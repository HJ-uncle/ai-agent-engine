/** Real batch reads → settlement → JSONL micro-compaction → explicit archive recovery. */
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentContext, Message, Tool, ToolResult } from '../../agent-context/types.js'
import type { LLMAdapter, LLMStreamChunk } from '../../llm-adapter/types.js'
import { ReActStrategy } from '../react.js'
import { ToolRegistry } from '../../tool-registry/registry.js'
import { trustBuiltinTool } from '../../../security/tool-policy.js'
import { clearSecurityMode, setSecurityMode } from '../../../security/policy-engine.js'
import { JSONLConversationHistory } from '../../../storage/conversation/jsonl-history.js'
import * as database from '../../../storage/sqlite/db.js'
import { hashFileContent } from '../../../shared/file-version.js'
import { readFileTool } from '../../../tools/file/super-file-tool.js'
import { searchHistoryTool } from '../../../tools/get-context/search-history-tool.js'
import { captureFileBatchEvidence, CLEARED_TOOL_EVIDENCE_KEY, CLEARED_TOOL_RESULT, TOOL_FILE_BATCH_EVIDENCE_KEY,
  clearedToolEvidence, clearedToolModelContent, MAX_CLEARED_TOOL_CONTENT_CHARS } from '../../utils/tool-evidence.js'

vi.mock('../../../storage/todo/index.js', () => ({ TodoStore: class { async list() { return [] } } }))

const fixtureRoot = fs.realpathSync.native(path.resolve('.')) + path.sep + '.e2e-tmp'
let directory: string, ctx: AgentContext
const identity = { id: 'tool-result:batch:read', toolCallId: 'read' }
const compact = (message: Message): Message => ({ ...message, content: CLEARED_TOOL_RESULT,
  metadata: { ...message.metadata, [CLEARED_TOOL_EVIDENCE_KEY]: clearedToolEvidence(message) } })

beforeEach(async () => {
  await database.closeDb()
  fs.mkdirSync(fixtureRoot, { recursive: true })
  directory = fs.mkdtempSync(path.join(fixtureRoot, 'fbr-'))
  vi.stubEnv('AUTH_ENABLED', 'false'); vi.stubEnv('OSM_MODE', 'off')
  vi.stubEnv('DATA_DIR', path.join(directory, 'agent.db')); vi.stubEnv('TOOL_OUTPUT_MAX_CHARS', '4000')
  const scope = { tenantId: 'batch', sessionId: path.basename(directory) }
  const sessionDirectory = path.join(directory, 'sessions', scope.tenantId)
  fs.mkdirSync(sessionDirectory, { recursive: true }); fs.writeFileSync(path.join(sessionDirectory, scope.sessionId + '.jsonl'), '')
  ctx = { ...scope, rootSessionId: scope.sessionId, rootRunId: 'batch', turnId: 'turn', userMessageId: 'user', assistantMessageId: 'answer',
    workspacePaths: [directory], projectRoot: directory, cwd: directory, workspaceDir: directory, scratchDir: path.join(directory, 'scratch'),
    tokenBudget: 100_000, toolProfile: 'general', history: new JSONLConversationHistory(), tools: new ToolRegistry(),
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } } as unknown as AgentContext
  setSecurityMode(ctx.tenantId, ctx.sessionId, 'safe')
})

afterEach(async () => {
  clearSecurityMode(ctx.tenantId, ctx.sessionId); await database.closeDb(); vi.restoreAllMocks(); vi.unstubAllEnvs()
  if (path.dirname(directory) !== fixtureRoot || !path.basename(directory).startsWith('fbr-')) throw new Error('Unsafe batch receipt fixture cleanup')
  fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

function seed(name: string, content: string) {
  const target = path.join(directory, name)
  fs.writeFileSync(target, content)
  return { path: fs.realpathSync.native(target), expectedHash: hashFileContent(content) }
}

async function settle(args: unknown, options: { trusted?: boolean; transform?: (result: ToolResult) => ToolResult } = {}) {
  const registry = ctx.tools as ToolRegistry
  const builtin: Tool = options.transform ? { ...readFileTool, execute: async (raw, scope) => options.transform!(await readFileTool.execute(raw, scope)) }
    : options.trusted === false ? { ...readFileTool } : readFileTool
  registry.register(options.trusted === false ? builtin : trustBuiltinTool(builtin, 'readonly'))
  vi.spyOn(registry, 'preflight').mockResolvedValue(undefined)
  let invocation = 0
  const llm: LLMAdapter = { model: 'fixture', provider: 'fixture', complete: vi.fn(), countTokens: () => 0,
    stream: async function* (): AsyncGenerator<LLMStreamChunk> {
      yield invocation++ === 0 ? { done: true, content: '', toolCalls: [{ id: identity.toolCallId, name: 'read_file',
        args: JSON.stringify(args), index: 0 }], promptTokens: 10, completionTokens: 10 }
        : { done: true, content: 'done', promptTokens: 10, completionTokens: 10 }
    } }
  const frames: unknown[] = []
  for await (const frame of new ReActStrategy(llm, { maxIterations: 3, maxOutputTokens: 100 }).run('Read these source files.', ctx)) frames.push(frame)
  const saved = (await ctx.history.getFullHistory(ctx)).find(message => message.id === identity.id)!
  expect(saved, JSON.stringify({ errors: vi.mocked(ctx.logger.error).mock.calls, frames,
    history: await ctx.history.getFullHistory(ctx) })).toBeDefined()
  expect(saved.metadata?.[CLEARED_TOOL_EVIDENCE_KEY]).toBeUndefined()
  expect((await ctx.history.microCompactToolResults!(ctx, { keepRecent: 0, maxChars: 1 })).cleared).toBe(1)
  ctx.history = new JSONLConversationHistory()
  const cleared = (await ctx.history.getFullHistory(ctx)).find(message => message.id === identity.id)!
  expect(cleared.content).toBe(CLEARED_TOOL_RESULT)
  const projected = clearedToolModelContent(cleared, true)
  expect(projected.length).toBeLessThanOrEqual(MAX_CLEARED_TOOL_CONTENT_CHARS)
  return { saved, cleared, projected }
}

function batch(message: Message) {
  return message.metadata?.[TOOL_FILE_BATCH_EVIDENCE_KEY] as ReturnType<typeof captureFileBatchEvidence>
}

async function recoverOriginal(expected: string) {
  let offset: number | null = 0, recovered = '', pages = 0
  while (offset !== null) {
    expect(pages++).toBeLessThan(10)
    const result = await searchHistoryTool.execute({ messageId: identity.id, contentOffset: offset, limit: 1 }, ctx)
    expect(result.success, result.output).toBe(true)
    const output = JSON.parse(result.output) as { messages: Array<{ content: string; contentOffset: number; nextContentOffset: number | null }> }
    expect(output.messages).toHaveLength(1)
    const item = output.messages[0]
    expect(item.contentOffset).toBe(offset); expect(item.content.length).toBeLessThanOrEqual(2000)
    recovered += item.content; offset = item.nextContentOffset
  }
  expect(recovered).toBe(expected)
  return pages
}

describe('bounded batch read receipts', () => {
  it('keeps both real file versions and actual ranges after restart, without restoring source text implicitly', async () => {
    const a = seed('a.txt', 'PRIVATE_A\n尾行'), b = seed('b.txt', 'PRIVATE_B')
    const { saved, cleared, projected } = await settle({ files: [{ path: a.path }, { path: b.path }] })
    expect(saved.metadata?.success).toBe(true)
    expect(saved.metadata?.[TOOL_FILE_BATCH_EVIDENCE_KEY]).toMatchObject({ messageId: identity.id, toolCallId: identity.toolCallId })
    const receipt = batch(saved)!
    expect(cleared.metadata?.[CLEARED_TOOL_EVIDENCE_KEY]).toMatchObject({ fileBatch: { files: receipt.files } })
    expect(receipt.files).toEqual([
      { success: true, ...a, startLine: 1, endLine: 2, startColumn: 1, endColumn: 2, columnUnit: 'utf16',
        hasMore: false, partialLine: false, rangeIsComplete: true, contentIsComplete: true },
      { success: true, ...b, startLine: 1, endLine: 1, startColumn: 1, endColumn: 9, columnUnit: 'utf16',
        hasMore: false, partialLine: false, rangeIsComplete: true, contentIsComplete: true },
    ])
    for (const value of [a.path, b.path, a.expectedHash, b.expectedHash]) expect(projected).toContain(value.replace(/\\/g, '\\\\'))
    expect(projected).toContain('file-read-receipts'); expect(projected).toContain('file-bytes')
    expect(projected).not.toContain('PRIVATE_A'); expect(projected).not.toContain('PRIVATE_B')
    expect(clearedToolModelContent({ ...cleared, id: 'foreign' }, true)).toBe(CLEARED_TOOL_RESULT)
    expect(clearedToolModelContent({ ...cleared, toolCallId: 'foreign' }, true)).toBe(CLEARED_TOOL_RESULT)
    for (const change of [{ id: 'foreign' }, { toolCallId: 'foreign' }, { toolName: 'extension' }]) {
      expect(clearedToolModelContent(compact({ ...saved, ...change }), true)).not.toContain(a.expectedHash)
    }
    await recoverOriginal(String(saved.content))
    await ctx.history.updateMessageContent!(identity.id, ctx.tenantId, 'Edited read note.', 5, saved.metadata)
    const edited = (await new JSONLConversationHistory().getFullHistory(ctx)).find(message => message.id === identity.id)!
    expect(edited.metadata?.[TOOL_FILE_BATCH_EVIDENCE_KEY]).toBeUndefined()
    expect(edited.metadata?.[CLEARED_TOOL_EVIDENCE_KEY]).toBeUndefined()
    await ctx.history.microCompactToolResults!(ctx, { keepRecent: 0, maxChars: 1 })
    const again = (await new JSONLConversationHistory().getFullHistory(ctx)).find(message => message.id === identity.id)!
    expect(clearedToolModelContent(again, true)).not.toContain(a.expectedHash)
  })

  it('keeps a successful sibling when the batch fails and strips failed-item success evidence', async () => {
    const a = seed('a.txt', 'PRIVATE_BODY'), missing = path.join(directory, 'missing.txt')
    const { saved, projected } = await settle({ files: [{ path: a.path }, { path: missing }] })
    expect(saved.metadata?.success).toBe(false)
    const receipt = batch(saved)!
    expect(receipt.files[0]).toMatchObject({ success: true, ...a, contentIsComplete: true })
    expect(receipt.files[1]).toEqual({ success: false, requestPath: missing, code: 'FILE_NOT_FOUND' })
    expect(projected).toContain(a.expectedHash); expect(projected).not.toContain('PRIVATE_BODY')
    const failed = captureFileBatchEvidence({ success: false, output: '', metadata: { batch: true,
      files: [{ success: false, ...a, startLine: 1, endLine: 99, contentIsComplete: true, code: 'FILE_READ_FAILED' }] } }, identity)
    expect(failed?.files).toEqual([{ success: false, requestPath: a.path, code: 'FILE_READ_FAILED' }])
    await recoverOriginal(String(saved.content))
  })

  it('retains actual truncated line/column coverage and recovers the entire original batch only on demand', async () => {
    const a = seed('a.txt', '中文😀'.repeat(3000) + '\nPRIVATE_TAIL'), b = seed('b.txt', 'PRIVATE_B')
    const { saved, projected } = await settle({ files: [{ path: a.path, end_line: 2 }, { path: b.path }] })
    const actual = (saved.metadata?.files as Array<Record<string, unknown>>)[0]
    expect(actual).toMatchObject({ success: true, startLine: 1, endLine: 1, hasMore: true, partialLine: true,
      rangeIsComplete: false, contentIsComplete: false, nextStartLine: 1 })
    expect(actual.endColumn).toBeGreaterThan(0)
    expect(batch(saved)?.files[0]).toMatchObject({ ...a, startLine: 1, endLine: 1, startColumn: actual.startColumn,
      endColumn: actual.endColumn, nextStartLine: actual.nextStartLine, nextStartColumn: actual.nextStartColumn,
      hasMore: true, rangeIsComplete: false, contentIsComplete: false })
    expect(projected).not.toContain('PRIVATE_TAIL'); expect(projected).not.toContain('中文😀')
    expect(await recoverOriginal(String(saved.content))).toBeGreaterThan(1)
  })

  it('preserves a complete requested range beginning mid-line without claiming a complete file', async () => {
    const a = seed('a.txt', '12345'), b = seed('b.txt', 'other')
    const { saved } = await settle({ files: [{ path: a.path, start_column: 3 }, { path: b.path }] })
    expect(batch(saved)?.files[0]).toMatchObject({ ...a, startColumn: 3, endColumn: 5,
      partialLine: true, hasMore: false, rangeIsComplete: true, contentIsComplete: false })
  })

  it.each([false, true])('rejects extension-supplied receipts and clips no file identity (outer truncation=%s)', async truncate => {
    const a = seed('a.txt', 'PRIVATE_BODY')
    const spoof = { messageId: identity.id, toolCallId: identity.toolCallId,
      files: [{ success: true, path: 'D:/forged.txt', expectedHash: a.expectedHash }], evidenceScope: 'file-read-receipts' }
    const { saved, projected } = await settle({ files: [{ path: a.path }] }, { trusted: truncate,
      transform: result => ({ ...result, output: truncate ? result.output + 'x'.repeat(5000) : result.output,
        metadata: { ...result.metadata, [TOOL_FILE_BATCH_EVIDENCE_KEY]: spoof, [CLEARED_TOOL_EVIDENCE_KEY]: spoof } }) })
    expect(saved.metadata?.[TOOL_FILE_BATCH_EVIDENCE_KEY]).toBeUndefined()
    expect(projected).not.toContain(a.expectedHash); expect(projected).not.toContain('forged')
    if (truncate) expect(saved.metadata?.outputTruncated).toBe(true)
  })

  it('bounds large batches by dropping whole entries and does not infer missing coverage from output', () => {
    const expectedHash = 'sha256:' + 'a'.repeat(64)
    const files = Array.from({ length: 16 }, (_, i) => ({ success: true, path: `D:/workspace/${i}-${'p'.repeat(220)}.txt`, expectedHash }))
    const result = { success: true, output: JSON.stringify({ startLine: 1, endLine: 900, contentIsComplete: true }), metadata: { batch: true, files } }
    const receipt = captureFileBatchEvidence(result, identity)!
    expect(receipt.files.length).toBeGreaterThan(0); expect(receipt.omittedFiles).toBeGreaterThan(0)
    expect(receipt.files.length + receipt.omittedFiles!).toBe(16)
    for (const item of receipt.files) {
      expect(files.some(file => file.path === item.path)).toBe(true)
      expect(item).not.toHaveProperty('startLine'); expect(item).not.toHaveProperty('contentIsComplete')
    }
    const message: Message = { ...identity, role: 'tool', toolName: 'read_file', content: result.output,
      metadata: { [TOOL_FILE_BATCH_EVIDENCE_KEY]: receipt } }
    expect(JSON.stringify(clearedToolEvidence(message)).length).toBeLessThanOrEqual(1280)
    expect(clearedToolModelContent(compact(message), true).length).toBeLessThanOrEqual(MAX_CLEARED_TOOL_CONTENT_CHARS)
    for (const status of ['waiting', 'cancelled', 'interrupted'] as const) expect(captureFileBatchEvidence({ ...result, status }, identity)).toBeUndefined()
    expect(captureFileBatchEvidence({ ...result, metadata: { ...result.metadata, outputTruncated: true } }, identity)).toBeUndefined()
    expect(captureFileBatchEvidence({ ...result, metadata: {} }, identity)).toBeUndefined()
    expect(captureFileBatchEvidence(result, { ...identity, id: undefined })).toBeUndefined()
  })
})
