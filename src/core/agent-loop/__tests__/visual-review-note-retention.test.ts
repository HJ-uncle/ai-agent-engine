/** Real settlement, JSONL clearing and restart keep ordinary review notes available
 * to the summary boundary. This does not evaluate any model's summary semantics. */
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentContext, Message, Tool } from '../../agent-context/types.js'
import type { LLMAdapter, LLMStreamChunk } from '../../llm-adapter/types.js'
import { ReActStrategy } from '../react.js'
import { buildCompactSummarizeFn } from '../compact-prompt.js'
import { ToolRegistry } from '../../tool-registry/registry.js'
import { trustBuiltinTool } from '../../../security/tool-policy.js'
import { JSONLConversationHistory } from '../../../storage/conversation/jsonl-history.js'
import { closeDb } from '../../../storage/sqlite/db.js'
import { modelMessageContent } from '../../utils/model-context.js'
import { CLEARED_TOOL_RESULT, TOOL_OFFICE_EVIDENCE_KEY } from '../../utils/tool-evidence.js'

vi.mock('../../../storage/todo/index.js', () => ({ TodoStore: class { async list() { return [] } } }))

const fixtureRoot = path.resolve('.e2e-tmp')
let fixtureDirectory: string
const version = { path: 'D:/workspace/deck.pptx', expectedHash: 'sha256:' + 'a'.repeat(64) }
const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII='
const notes = [
  `${version.path} · ${version.expectedHash} · 第1页：通过，标题和图片没有裁切。`,
  `${version.path} · ${version.expectedHash} · 第2页：页脚重叠，需调整。`,
]
const noteIdentity = (message: Message) => ({ id: message.id, role: message.role,
  content: message.content, toolCallId: message.toolCallId })

beforeEach(async () => {
  await closeDb()
  fs.mkdirSync(fixtureRoot, { recursive: true })
  fixtureDirectory = fs.mkdtempSync(path.join(fixtureRoot, 'visual-note-'))
  vi.stubEnv('DATA_DIR', path.join(fixtureDirectory, 'agent.db'))
})
afterEach(async () => {
  vi.restoreAllMocks()
  await closeDb()
  vi.unstubAllEnvs()
  if (path.dirname(fixtureDirectory) !== fixtureRoot || !path.basename(fixtureDirectory).startsWith('visual-note-')) throw new Error('Unsafe fixture cleanup')
  fs.rmSync(fixtureDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

describe('ordinary visual-review notes through history maintenance', () => {
  it('retains page verdicts when tool images clear and forwards them unchanged to summary input after restart', async () => {
    const scope = { tenantId: 'review', sessionId: path.basename(fixtureDirectory) }
    const sessionDirectory = path.join(fixtureDirectory, 'sessions', scope.tenantId)
    fs.mkdirSync(sessionDirectory, { recursive: true })
    fs.writeFileSync(path.join(sessionDirectory, scope.sessionId + '.jsonl'), '')
    const history = new JSONLConversationHistory(), registry = new ToolRegistry()
    const render: Tool = { name: 'workbench_render', description: 'render page', parameters: { type: 'object' },
      execute: async (args) => {
        const page = (args as { page: number }).page
        return { success: true, output: JSON.stringify({ ...version, format: 'pptx', page, pageCount: 2,
          mimeType: 'image/png', dataUrl: image, description: `PRIVATE_RENDER_BODY_${page}` }),
          metadata: { ...version, format: 'pptx', page, pageCount: 2, unit: 'page' } }
      } }
    registry.register(trustBuiltinTool(render, 'readonly'))
    vi.spyOn(registry, 'preflight').mockResolvedValue(undefined)
    const ctx = { ...scope, rootRunId: 'root-review', turnId: 'turn-review', userMessageId: 'user-review',
      assistantMessageId: 'answer-review', workspaceDir: fixtureDirectory, tokenBudget: 100_000, history, tools: registry,
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } } as unknown as AgentContext
    let invocation = 0
    const llm: LLMAdapter = { model: 'fixture', provider: 'fixture', complete: vi.fn(), countTokens: () => 0,
      stream: async function* (): AsyncGenerator<LLMStreamChunk> {
        const index = invocation++
        yield { done: true, content: index === 0 ? '' : notes[index - 1], promptTokens: 10, completionTokens: 10,
          ...(index < 2 ? { toolCalls: [{ id: `render-${index + 1}`, name: render.name,
            args: JSON.stringify({ path: version.path, page: index + 1 }), index: 0 }] } : {}) }
      } }
    for await (const _frame of new ReActStrategy(llm, { maxIterations: 4, maxOutputTokens: 100 }).run('Review both slides.', ctx)) { /* real settlement */ }
    const original = await history.getFullHistory(scope)
    const originalNotes = original.filter(message => message.role === 'assistant' && notes.includes(String(message.content)))
    expect(originalNotes.map(message => message.content)).toEqual(notes)
    expect(originalNotes.every(message => typeof message.id === 'string' && message.id.length > 0)).toBe(true)
    expect(original.filter(message => message.role === 'tool')).toHaveLength(2)
    expect(original.filter(message => message.role === 'tool').map(message => String(message.content))).toEqual([
      expect.stringContaining(image), expect.stringContaining(image),
    ])
    expect((await history.microCompactToolResults(scope, { keepRecent: 0, maxChars: 1 })).cleared).toBe(2)

    const restarted = new JSONLConversationHistory()
    const reloaded = await restarted.getFullHistory(scope)
    expect(reloaded.filter(message => originalNotes.some(note => note.id === message.id)).map(noteIdentity))
      .toEqual(originalNotes.map(noteIdentity))
    const cleared = reloaded.filter(message => message.role === 'tool')
    for (let index = 0; index < cleared.length; index++) {
      const message = cleared[index]
      expect(message.content).toBe(CLEARED_TOOL_RESULT)
      expect(message.metadata?.[TOOL_OFFICE_EVIDENCE_KEY]).toMatchObject({ operation: 'render', success: true,
        files: [{ ...version, page: index + 1, pageCount: 2, unit: 'page', success: true }] })
      const projected = String(modelMessageContent(message))
      expect(projected).toContain(version.expectedHash)
      expect(projected).toContain(`"page":${index + 1}`)
      expect(projected).not.toContain(image)
      expect(projected).not.toContain('PRIVATE_RENDER_BODY')
    }

    // A fixture summary cannot prove semantic retention; verify the production
    // prompt boundary too, including verdicts attached to tool-calling turns.
    const complete = vi.fn(async (_messages: Message[]) => ({ content: 'Fixture digest; semantics are not evaluated.' }))
    const productionSummarize = buildCompactSummarizeFn({ complete }, { archiveAvailable: true, contextWindow: 100_000 })
    const summarize = vi.fn(async (messages: Message[]) => {
      expect(messages.filter(message => originalNotes.some(note => note.id === message.id)).map(noteIdentity))
        .toEqual(originalNotes.map(noteIdentity))
      for (const note of notes) expect(messages.map(modelMessageContent)).toContain(note)
      return productionSummarize(messages)
    })
    await restarted.compress(scope, summarize, 0)
    expect(summarize).toHaveBeenCalledTimes(1)
    expect(complete).toHaveBeenCalledTimes(1)
    const prompt = String(complete.mock.calls[0][0][0].content)
    for (const note of originalNotes) {
      expect(prompt).toContain(`messageId=${note.id}`)
      expect(prompt).toContain(String(note.content))
    }
    expect(prompt).toContain(version.expectedHash)
    expect(prompt).toContain('original output/pixels are not in context')
    expect(prompt).toContain('not an earlier recorded review')
    expect(prompt).not.toContain(image)
    expect(prompt).not.toContain('PRIVATE_RENDER_BODY')
  })
})
