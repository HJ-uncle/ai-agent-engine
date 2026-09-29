// Script only the provider; registry, ReAct, safe paths, JSONL, SQLite and revert HTTP are real.
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import Fastify, { type FastifyInstance } from 'fastify'
import { pino } from 'pino'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Message } from '../../agent-context/index.js'
import type { LLMAdapter } from '../../llm-adapter/types.js'
import type { RunOutcome } from '../../subagent/types.js'
import type { FileChange } from '../../../storage/changes/index.js'

const fixtureRoot = path.resolve('.e2e-tmp')
const tenantId = 'edit-integration-tenant'
let fixtureDir: string
let projectRoot: string
let app: FastifyInstance
let runtime: Awaited<ReturnType<typeof loadRuntime>>

async function loadRuntime() {
  const [database, loop, registry, context, history, changes, runs, routes] = await Promise.all([
    import('../../../storage/sqlite/db.js'), import('../react.js'), import('../../../tools/registry-factory.js'),
    import('../../agent-context/factory.js'), import('../../../storage/conversation/factory.js'),
    import('../../../storage/changes/index.js'), import('../../../storage/root-runs/index.js'),
    import('../../../api/http/routes/changes.js'),
  ])
  return { ...database, ...loop, ...registry, ...context, ...history, ...changes, ...runs, ...routes }
}

const hash = (content: string | Buffer) => `sha256:${createHash('sha256').update(content).digest('hex')}`
const framesOf = (frames: string[], kind: string) => frames.filter(frame => frame.startsWith(`\x00__${kind}__`))
  .map(frame => JSON.parse(frame.slice(`\x00__${kind}__`.length)))
const toolMessage = (messages: Message[], id: string) => messages.find(message => message.role === 'tool' && message.toolCallId === id)!

interface FileEdit {
  name: string
  before: string
  after: string
  edits: Array<{ oldText: string; newText: string }>
  lineEnding: string
}

async function executeEdits(sessionId: string, files: FileEdit[], externalContent?: string) {
  const registration = await runtime.createToolRegistry({ toolProfile: 'code', allowedTools: ['read_file', 'edit_file'],
    securityContext: { tenantId, sessionId, toolProfile: 'code' } })
  expect(registration.registry.list().map(tool => tool.name).sort()).toEqual(['edit_file', 'read_file'])
  expect(registration.toolCategories.builtinTools.sort()).toEqual(['edit_file', 'read_file'])
  expect(registration.registry.executionMode('read_file', {})).toBe('readonly')
  expect(registration.registry.executionMode('edit_file', {})).toBe('serial')

  const run = await runtime.rootRunStore.create(tenantId, sessionId, 'scripted-edit-provider', [projectRoot], { toolProfile: 'code' })
  const history = runtime.createConversationHistory()
  const outcomes: RunOutcome[] = []
  const ctx = runtime.createAgentContext({ tenantId, sessionId, projectRoot, cwd: projectRoot,
    workspacePaths: [projectRoot], scratchDir: path.join(fixtureDir, 'scratch', sessionId),
    tools: registration.registry, history, logger: pino({ level: 'silent' }), tokenBudget: 100_000,
    toolProfile: 'code', modelName: 'scripted-edit-provider',
    rootRunId: run.runId, turnId: run.turnId, conversationId: run.turnId,
    userMessageId: run.userMessageId, assistantMessageId: run.assistantMessageId,
    runObserver: { async onOutcome(outcome) {
      outcomes.push(outcome)
      await runtime.rootRunStore.update(tenantId, run.runId, {
        status: outcome.status === 'blocked' ? 'waiting' : outcome.status,
        stopReason: outcome.stopReason, error: outcome.error,
      })
    } },
  })
  let requests = 0
  let schemaSeen = false
  const adapter: LLMAdapter = {
    provider: 'fixture', model: 'scripted-edit-provider', countTokens: text => Math.ceil(text.length / 4),
    complete: async () => { throw new Error('Unexpected completion request') },
    async *stream(messages, options) {
      requests++
      const schema = options?.tools?.find(tool => tool.name === 'edit_file')?.parameters
      expect(schema).toMatchObject({ type: 'object', required: ['path', 'expectedHash', 'edits'], properties: {
        expectedHash: { type: 'string', pattern: '^sha256:[a-f0-9]{64}$' },
        edits: { type: 'array', minItems: 1, items: { required: ['oldText', 'newText'], properties: {
          oldText: { type: 'string', minLength: 1 }, newText: { type: 'string' },
        } } },
      } })
      schemaSeen = true
      if (requests === 1) {
        yield { done: true, finishReason: 'tool_calls', toolCalls: files.map((file, index) => ({
          id: `read-${index}`, name: 'read_file', args: JSON.stringify({ path: file.name, mode: 'exact' }), index,
        })) }
      } else if (requests === 2) {
        const reads = files.map((file, index) => {
          const message = toolMessage(messages, `read-${index}`)
          expect(message.metadata).toMatchObject({ success: true, status: 'succeeded', rootRunId: run.runId, turnId: run.turnId })
          const read = JSON.parse(String(message.content))
          expect(read).toMatchObject({ expectedHash: hash(file.before), encoding: 'utf-8', content: file.before,
            lineEnding: file.lineEnding, utf8Bom: file.before.startsWith('\uFEFF'), startLine: 1 })
          expect(path.isAbsolute(read.path)).toBe(true)
          expect(read.endLine).toBe(read.totalLines)
          expect(fs.readFileSync(read.path, 'utf8')).toBe(file.before)
          return read
        })
        if (externalContent !== undefined) fs.writeFileSync(path.join(projectRoot, files[0].name), externalContent)
        yield { done: true, finishReason: 'tool_calls', toolCalls: files.map((file, index) => ({
          id: `edit-${index}`, name: 'edit_file', args: JSON.stringify({ path: reads[index].path,
            expectedHash: reads[index].expectedHash, edits: file.edits }), index,
        })) }
      } else if (requests === 3) {
        files.forEach((file, index) => {
          const result = toolMessage(messages, `edit-${index}`)
          if (externalContent !== undefined) expect(result.metadata).toMatchObject({ success: false,
            code: 'EDIT_VERSION_CONFLICT', fileMutationApplied: false,
            expectedHash: hash(file.before), actualHash: hash(externalContent) })
          else expect(result.metadata).toMatchObject({ success: true, status: 'succeeded',
            oldHash: hash(file.before), newHash: hash(file.after),
            change: { tenantId, sessionId, turnId: run.turnId, runId: run.runId,
              oldContent: file.before, newContent: file.after, truncated: false } })
        })
        yield { done: true, finishReason: 'stop', content: externalContent === undefined ? 'Edits verified.' : 'File changed; read it again.' }
      } else throw new Error('Unexpected provider iteration')
    },
  }
  const frames: string[] = []
  for await (const frame of new runtime.ReActStrategy(adapter, { maxIterations: 4, maxOutputTokens: 500 }).run('Apply the exact file edits.', ctx)) frames.push(frame)
  expect(schemaSeen).toBe(true)
  expect(requests).toBe(3)
  expect(outcomes).toEqual([expect.objectContaining({ status: 'succeeded' })])
  expect((await runtime.rootRunStore.get(tenantId, run.runId))?.status).toBe('succeeded')
  return { ctx, run, frames, history: await runtime.createConversationHistory().getFullHistory(ctx) }
}

describe('D6 exact-edit real runtime integration', () => {
  beforeAll(async () => {
    fs.mkdirSync(fixtureRoot, { recursive: true })
    fixtureDir = fs.mkdtempSync(path.join(fixtureRoot, 'edit-integration-'))
    projectRoot = path.join(fixtureDir, 'project')
    fs.mkdirSync(projectRoot)
    fs.writeFileSync(path.join(fixtureDir, 'mcp.json'), JSON.stringify({ mcpServers: {} }))
    vi.stubEnv('DATA_DIR', path.join(fixtureDir, 'storage', 'agent.db'))
    vi.stubEnv('WORKSPACE_ROOT', path.join(fixtureDir, 'scratch'))
    vi.stubEnv('HISTORY_BACKEND', 'jsonl')
    vi.stubEnv('OSM_MODE', 'off')
    vi.stubEnv('DEFAULT_SECURITY_MODE', 'safe')
    vi.stubEnv('MCP_CONFIG_PATH', path.join(fixtureDir, 'mcp.json'))
    vi.stubEnv('AETHER_GLOBAL_DIR', path.join(fixtureDir, 'global'))
    runtime = await loadRuntime()
    await runtime.initDb()
    app = Fastify()
    app.decorateRequest('authContext', null)
    app.addHook('onRequest', async request => { Object.assign(request, { authContext: { tenantId } }) })
    await app.register(runtime.changeRoutes)
  })

  afterAll(async () => {
    await app?.close()
    runtime?.closeDb()
    vi.unstubAllEnvs()
    if (!fixtureDir) return
    if (path.dirname(fixtureDir) !== fixtureRoot || !path.basename(fixtureDir).startsWith('edit-integration-')) throw new Error('Unsafe fixture cleanup path')
    try { fs.rmSync(fixtureDir, { recursive: true, force: true, maxRetries: 2, retryDelay: 20 }) }
    catch (error) {
      // Native libsql transaction handles may outlive closeDb until the Windows worker exits.
      if (process.platform !== 'win32' || !(error instanceof Error) || !('code' in error) || error.code !== 'EPERM') throw error
    }
  })

  it('exposes real schemas and edits multiple files, persists turn/change records, then reverts by turn with exact bytes', async () => {
    const sessionId = 'two-turn-multi-file'
    const a0 = '\uFEFF标题：原始\r\nconst alpha = 1;\r\nconst beta = 2;\r\n'
    const a1 = a0.replace('标题：原始', '标题：第一轮')
    const a2 = a1.replace('alpha = 1', 'alpha = 10').replace('beta = 2', 'beta = 20')
    const b0 = '中文 and emoji 🌱\nleft = true\nright = false\n'
    const b1 = b0.replace('left = true', 'left = false').replace('right = false', 'right = true')
    const a = path.join(projectRoot, 'first.ts')
    const b = path.join(projectRoot, 'second.txt')
    fs.writeFileSync(a, a0)
    fs.writeFileSync(b, b0)
    const first = await executeEdits(sessionId, [{ name: 'first.ts', before: a0, after: a1, lineEnding: 'CRLF',
      edits: [{ oldText: '标题：原始', newText: '标题：第一轮' }] }])
    const second = await executeEdits(sessionId, [
      { name: 'first.ts', before: a1, after: a2, lineEnding: 'CRLF', edits: [
        { oldText: 'alpha = 1', newText: 'alpha = 10' }, { oldText: 'beta = 2', newText: 'beta = 20' },
      ] },
      { name: 'second.txt', before: b0, after: b1, lineEnding: 'LF', edits: [
        { oldText: 'left = true', newText: 'left = false' }, { oldText: 'right = false', newText: 'right = true' },
      ] },
    ])
    expect(fs.readFileSync(a).equals(Buffer.from(a2))).toBe(true)
    expect(fs.readFileSync(b).equals(Buffer.from(b1))).toBe(true)
    const emitted = framesOf(second.frames, 'file_change')
    expect(emitted).toHaveLength(2)
    expect(emitted.map(change => change.toolCallId)).toEqual(['edit-0', 'edit-1'])
    expect(emitted.every(change => change.turnId === second.run.turnId && change.runId === second.run.runId)).toBe(true)
    const persistedEdits = second.history.filter(message => message.role === 'tool' && message.toolName === 'edit_file')
    expect(persistedEdits).toHaveLength(3)
    expect(new Set(persistedEdits.map(message => message.metadata?.turnId))).toEqual(new Set([first.run.turnId, second.run.turnId]))
    const records = (await app.inject(`/changes?sessionId=${sessionId}`)).json().data as FileChange[]
    expect(records).toHaveLength(3)
    expect(new Set(records.map(change => change.id))).toEqual(new Set(persistedEdits.map(message => (message.metadata?.change as FileChange).id)))
    expect(records.every(change => change.tenantId === tenantId && change.sessionId === sessionId && !change.truncated && change.status === 'pending')).toBe(true)
    expect(records.filter(change => change.turnId === second.run.turnId).map(change => change.id).sort()).toEqual(emitted.map(change => change.id).sort())

    const revertedSecond = await app.inject({ method: 'POST', url: '/changes/revert-batch',
      payload: { sessionId, fromTurnId: second.run.turnId } })
    expect(revertedSecond.statusCode).toBe(200)
    expect(revertedSecond.json().data).toMatchObject({ total: 2, reverted: 2, conflicts: 0, unavailable: 0, failed: 0 })
    expect(fs.readFileSync(a).equals(Buffer.from(a1))).toBe(true)
    expect(fs.readFileSync(b).equals(Buffer.from(b0))).toBe(true)
    const remaining = await new runtime.ChangeStore().list(tenantId, sessionId, 'pending')
    expect(remaining).toHaveLength(1)
    expect(remaining[0].turnId).toBe(first.run.turnId)
    const revertedFirst = await app.inject({ method: 'POST', url: '/changes/revert-batch',
      payload: { sessionId, fromTurnId: first.run.turnId } })
    expect(revertedFirst.json().data).toMatchObject({ total: 1, reverted: 1, conflicts: 0 })
    expect(fs.readFileSync(a).equals(Buffer.from(a0))).toBe(true)
  })

  it('returns a stale-version failure to the model without modifying the newer file or emitting/persisting a change', async () => {
    const sessionId = 'stale-version'
    const before = 'original\r\n中文\r\n'
    const external = 'manual edit after exact read\r\n中文 🌱\r\n'
    const file = path.join(projectRoot, 'stale.txt')
    fs.writeFileSync(file, before)
    const result = await executeEdits(sessionId, [{ name: 'stale.txt', before, after: 'agent replacement\r\n中文\r\n',
      lineEnding: 'CRLF', edits: [{ oldText: 'original', newText: 'agent replacement' }] }], external)
    expect(fs.readFileSync(file).equals(Buffer.from(external))).toBe(true)
    expect(framesOf(result.frames, 'file_change')).toEqual([])
    const terminal = framesOf(result.frames, 'tool_result').find(frame => frame.name === 'edit_file')
    expect(terminal).toMatchObject({ success: false, status: 'failed', error: 'EDIT_VERSION_CONFLICT',
      rootRunId: result.run.runId, turnId: result.run.turnId,
      metadata: { code: 'EDIT_VERSION_CONFLICT', fileMutationApplied: false, expectedHash: hash(before), actualHash: hash(external) } })
    expect(terminal.metadata.change).toBeUndefined()
    expect((await new runtime.ChangeStore().list(tenantId, sessionId))).toEqual([])
    expect(result.history.find(message => message.toolName === 'edit_file')?.metadata).toMatchObject({ success: false, code: 'EDIT_VERSION_CONFLICT' })
    expect(result.history.at(-1)?.content).toBe('File changed; read it again.')
  })
})
