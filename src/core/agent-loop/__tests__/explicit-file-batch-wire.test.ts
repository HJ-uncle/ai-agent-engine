import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createClient, type Client } from '@libsql/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentContext, Message } from '../../agent-context/types.js'
import type { LLMAdapter } from '../../llm-adapter/types.js'
import { OpenAIAdapter } from '../../llm-adapter/openai.js'
import { AnthropicAdapter } from '../../llm-adapter/anthropic.js'
import { ToolRegistry } from '../../tool-registry/registry.js'
import { ReActStrategy } from '../react.js'
import { readFileTool, writeFileTool } from '../../../tools/file/super-file-tool.js'
import { trustBuiltinTool } from '../../../security/tool-policy.js'
import { clearSecurityMode, setSecurityMode } from '../../../security/policy-engine.js'
import * as database from '../../../storage/sqlite/db.js'

vi.mock('../../../storage/todo/index.js', () => ({ TodoStore: class { async list() { return [] } } }))
vi.mock('../../../storage/results/index.js', () => ({ finalResults: {
  stalePaths: async () => [], prepare: async () => undefined, retainToolImages: async () => [],
}, TOOL_RESULT_IMAGE_ASSETS: '__aetherResultImageAssets' }))

let root: string, db: Client
const tenantId = 'explicit-batch-wire'
beforeEach(() => {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'aether-batch-wire-')))
  vi.stubEnv('AUTH_ENABLED', 'false')
  vi.stubEnv('OSM_MODE', 'balanced')
  vi.stubEnv('ENABLE_LONG_TERM_MEMORY', 'false')
  vi.stubEnv('DATA_DIR', path.join(root, 'agent.db'))
  db = createClient({ url: 'file::memory:' })
  vi.spyOn(database, 'getDb').mockReturnValue(db)
  setSecurityMode(tenantId, path.basename(root), 'safe')
})
afterEach(() => {
  clearSecurityMode(tenantId, path.basename(root))
  db.close(); vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals()
  if (path.dirname(root) !== fs.realpathSync.native(os.tmpdir()) || !path.basename(root).startsWith('aether-batch-wire-')) throw new Error('Unsafe fixture cleanup')
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
})

describe('explicit batch real file tools through ReAct and provider serialization', () => {
  it.each(['openai', 'anthropic'] as const)('%s sends three reads and three writes in just three model requests', async provider => {
    const paths = ['a.txt', 'b.txt', 'c.txt'], values = [19, 23, 41]
    paths.forEach((name, index) => fs.writeFileSync(path.join(root, name), `${values[index]}\n`))
    const history: Message[] = [], requests: Message[][] = [], wire: any[] = []
    const registry = new ToolRegistry()
    registry.register(trustBuiltinTool(readFileTool, 'readonly'))
    registry.register(trustBuiltinTool(writeFileTool, 'serial'))
    const ctx = { tenantId, sessionId: path.basename(root), rootRunId: 'root', turnId: 'turn', toolProfile: 'general',
      workspacePaths: [root], workspaceDir: root, projectRoot: root, cwd: root, tokenBudget: 100_000,
      signal: new AbortController().signal, tools: registry, memoryScopes: [],
      history: { append: async (message: Message) => { history.push(message); return message.id ?? 'saved' },
        getHistory: async () => [...history], getRawTokenCount: async () => 0 },
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as unknown as AgentContext
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
      wire.push(JSON.parse(String(init?.body)))
      return Response.json(provider === 'openai'
        ? { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 10 } }
        : { id: 'fixture', type: 'message', role: 'assistant', model: 'fixture', content: [{ type: 'text', text: 'ok' }],
          stop_reason: 'end_turn', usage: { input_tokens: 100, output_tokens: 10 } })
    }))
    const serializer = provider === 'openai' ? new OpenAIAdapter('fixture', 'fixture-key', 'http://model.invalid', true)
      : new AnthropicAdapter('fixture', 'fixture-key', 'http://model.invalid')
    const llm: LLMAdapter = { provider: 'controlled', model: 'fixture', complete: vi.fn(), countTokens: () => 0,
      stream: async function* (messages, options) {
        requests.push(structuredClone(messages))
        // Actual adapters and fetch path, with deterministic local responses.
        // This is protocol evidence, not a model-behavior benchmark.
        await serializer.complete(messages, options)
        const turn = requests.length
        if (turn === 2) expect(fs.existsSync(path.join(root, 'out-a.txt'))).toBe(false)
        if (turn === 3) paths.forEach((name, i) => expect(fs.readFileSync(path.join(root, `out-${name}`), 'utf8')).toBe(`${values[i] * 2}\n`))
        yield { done: false, promptTokens: 100, completionTokens: 0 }
        if (turn < 3) yield { done: true, promptTokens: 100, completionTokens: 10, toolCalls: [{ id: `batch-${turn}`, index: 0,
          name: turn === 1 ? 'read_file' : 'write_file', args: JSON.stringify({ files: paths.map((name, i) => turn === 1
            ? { path: name } : { path: `out-${name}`, data: String(values[i] * 2), trailingNewline: 'LF', expectedHash: 'missing' }) }) }] }
        else yield { done: true, promptTokens: 100, completionTokens: 10, content: 'All three files read and written.' }
      } }
    for await (const _frame of new ReActStrategy(llm, { maxIterations: 4 }).run('Read and transform the three specified files.', ctx)) { /* settle */ }
    expect(requests).toHaveLength(3)
    expect(wire).toHaveLength(3)
    const results = requests[2].filter(message => message.role === 'tool')
    expect(results).toHaveLength(2)
    expect(results.map(message => message.toolCallId)).toEqual(['batch-1', 'batch-2'])
    for (const result of results) {
      expect(result.metadata?.success).toBe(true)
      expect(result.metadata?.outputTruncated).not.toBe(true)
      const files = JSON.parse(String(result.content)).files
      expect(files).toHaveLength(3)
      expect(files.every((file: any) => file.success)).toBe(true)
      for (const file of files) expect(file.output.expectedHash).toMatch(/^sha256:[a-f0-9]{64}$/)
    }
    const secondToolResults = provider === 'openai' ? wire[1].messages.filter((message: any) => message.role === 'tool')
      : wire[1].messages.flatMap((message: any) => Array.isArray(message.content) ? message.content.filter((block: any) => block.type === 'tool_result') : [])
    expect(secondToolResults).toHaveLength(1)
    expect(JSON.parse(secondToolResults[0].content).files.map((file: any) => file.path.replaceAll('\\', '/').split('/').at(-1))).toEqual(paths)
    expect(history.filter(message => message.role === 'assistant' && message.usage).map(message => message.usage?.promptTokens)).toEqual([100, 100, 100])
    expect((results[1].metadata?.changes as unknown[])).toHaveLength(3)
  })
})
