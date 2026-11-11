/** Real settlement + JSONL micro-compaction preserve saved-file receipts only. */
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentContext, Message, Tool } from '../../agent-context/types.js'
import type { LLMAdapter, LLMStreamChunk } from '../../llm-adapter/types.js'
import { ReActStrategy } from '../react.js'
import { ToolRegistry } from '../../tool-registry/registry.js'
import { trustBuiltinTool } from '../../../security/tool-policy.js'
import { createSubagentToolRegistry } from '../../../tools/subagent/subagent-tool.js'
import { JSONLConversationHistory } from '../../../storage/conversation/jsonl-history.js'
import { closeDb } from '../../../storage/sqlite/db.js'
import { captureScreenshotEvidence, CLEARED_TOOL_EVIDENCE_KEY, CLEARED_TOOL_RESULT, TOOL_SCREENSHOT_EVIDENCE_KEY,
  clearedToolEvidence, clearedToolModelContent, MAX_CLEARED_TOOL_CONTENT_CHARS } from '../../utils/tool-evidence.js'

vi.mock('../../../storage/todo/index.js', () => ({ TodoStore: class { async list() { return [] } } }))

const fixtureRoot = path.resolve('.e2e-tmp')
let fixtureDirectory: string
const file = { path: 'D:/workspace/materials/board.png', expectedHash: 'sha256:' + 'a'.repeat(64) }
const dimensions = { width: 930, height: 1350 }
const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII='
const identity = { id: 'tool-result:root:save', toolCallId: 'save' }
const metadata = { ...file, ...dimensions, screenshotSaved: true }
const compact = (message: Message): Message => ({ ...message, content: CLEARED_TOOL_RESULT,
  metadata: { ...message.metadata, [CLEARED_TOOL_EVIDENCE_KEY]: clearedToolEvidence(message) } })

beforeEach(async () => {
  await closeDb()
  fs.mkdirSync(fixtureRoot, { recursive: true })
  fixtureDirectory = fs.mkdtempSync(path.join(fixtureRoot, 'screenshot-evidence-'))
  vi.stubEnv('DATA_DIR', path.join(fixtureDirectory, 'agent.db'))
})
afterEach(async () => {
  vi.restoreAllMocks(); await closeDb(); vi.unstubAllEnvs()
  if (path.dirname(fixtureDirectory) !== fixtureRoot || !path.basename(fixtureDirectory).startsWith('screenshot-evidence-')) throw new Error('Unsafe fixture cleanup')
  fs.rmSync(fixtureDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

describe('saved screenshot receipts', () => {
  it('requires the builtin identity and the child save capability', () => {
    const registry = new ToolRegistry()
    const tool: Tool = { name: 'browser_save_screenshot', description: '', parameters: { type: 'object' },
      execute: async () => ({ success: true, output: '{}' }) }
    registry.register(tool)
    expect(registry.supportsScreenshotEvidence(tool.name)).toBe(false)
    registry.unregister(tool.name); registry.register(trustBuiltinTool({ ...tool }, 'serial'))
    expect(registry.supportsScreenshotEvidence(tool.name)).toBe(true)
    expect(registry.supportsScreenshotEvidence('browser_screenshot')).toBe(false)
    const writable = createSubagentToolRegistry(registry, false), research = createSubagentToolRegistry(registry, true)
    expect(writable.supportsScreenshotEvidence?.(tool.name)).toBe(true)
    expect(research.supportsScreenshotEvidence?.(tool.name)).toBe(false)
    registry.unregister(tool.name); registry.register({ ...tool, source: 'mcp' })
    expect(writable.supportsScreenshotEvidence?.(tool.name)).toBe(false)
  })

  it.each([[true, true], [false, true], [true, false]])('settles and compacts only successful builtin saves (trusted=%s, success=%s)', async (trusted, success) => {
    const scope = { tenantId: 'receipt', sessionId: path.basename(fixtureDirectory) }
    const sessionDirectory = path.join(fixtureDirectory, 'sessions', scope.tenantId)
    fs.mkdirSync(sessionDirectory, { recursive: true }); fs.writeFileSync(path.join(sessionDirectory, scope.sessionId + '.jsonl'), '')
    const history = new JSONLConversationHistory(), registry = new ToolRegistry()
    const spoof = { ...file, path: 'D:/forged.png', ...dimensions, messageId: identity.id, toolCallId: identity.toolCallId }
    const tool: Tool = { name: 'browser_save_screenshot', description: 'save screenshot', parameters: { type: 'object' },
      execute: async () => ({ success, output: JSON.stringify({ filename: 'board.png', mimeType: 'image/png', dataUrl: image,
        description: 'PRIVATE_PAGE_BODY', ...file, ...dimensions }),
        metadata: { ...metadata, [TOOL_SCREENSHOT_EVIDENCE_KEY]: spoof, [CLEARED_TOOL_EVIDENCE_KEY]: spoof } }) }
    registry.register(trusted ? trustBuiltinTool(tool, 'serial') : tool)
    vi.spyOn(registry, 'preflight').mockResolvedValue(undefined)
    const ctx = { ...scope, rootRunId: 'root', turnId: 'turn', userMessageId: 'user', assistantMessageId: 'answer',
      workspaceDir: fixtureDirectory, tokenBudget: 100_000, history, tools: registry,
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } } as unknown as AgentContext
    let invocation = 0
    const llm: LLMAdapter = { model: 'fixture', provider: 'fixture', complete: vi.fn(), countTokens: () => 0,
      stream: async function* (): AsyncGenerator<LLMStreamChunk> {
        yield invocation++ === 0 ? { done: true, content: '', toolCalls: [{ id: 'save', name: tool.name,
          args: '{"path":"materials/board.png"}', index: 0 }], promptTokens: 10, completionTokens: 10 }
          : { done: true, content: 'done', promptTokens: 10, completionTokens: 10 }
      } }
    for await (const _frame of new ReActStrategy(llm, { maxIterations: 3, maxOutputTokens: 100 }).run('Save this screenshot.', ctx)) { /* real settlement */ }
    const saved = (await history.getFullHistory(scope)).find(message => message.role === 'tool')!
    expect(saved.id).toBe(identity.id)
    expect(saved.metadata?.[CLEARED_TOOL_EVIDENCE_KEY]).toBeUndefined()
    const retained = trusted && success
    expect(saved.metadata?.[TOOL_SCREENSHOT_EVIDENCE_KEY]).toEqual(retained
      ? { ...file, ...dimensions, messageId: identity.id, toolCallId: identity.toolCallId, evidenceScope: 'saved-file-receipt' } : undefined)
    expect((await history.microCompactToolResults(scope, { keepRecent: 0, maxChars: 1 })).cleared).toBe(1)
    const restarted = new JSONLConversationHistory()
    const cleared = (await restarted.getFullHistory(scope)).find(message => message.id === identity.id)!
    expect(cleared.content).toBe(CLEARED_TOOL_RESULT)
    const text = clearedToolModelContent(cleared, true)
    expect(text.includes(file.path)).toBe(retained); expect(text.includes(file.expectedHash)).toBe(retained)
    expect(text.includes('"width":930')).toBe(retained); expect(text.includes('"height":1350')).toBe(retained)
    for (const omitted of [image, 'PRIVATE_PAGE_BODY', 'forged.png', 'visualAcceptance']) expect(text).not.toContain(omitted)
    expect(text.length).toBeLessThanOrEqual(MAX_CLEARED_TOOL_CONTENT_CHARS)
    if (!retained) return
    expect(text).toContain('saved-file-receipt'); expect(text).toContain('file-bytes')
    expect(clearedToolModelContent({ ...cleared, id: 'foreign-message' }, true)).toBe(CLEARED_TOOL_RESULT)
    expect(clearedToolModelContent(compact({ ...saved, toolCallId: 'foreign-call' }), true)).not.toContain(file.path)
    expect(clearedToolModelContent(compact({ ...saved, id: 'foreign-message' }), true)).not.toContain(file.path)
    expect(clearedToolModelContent(compact({ ...saved, toolName: 'browser_screenshot' }), true)).not.toContain(file.path)
    await restarted.updateMessageContent(identity.id, scope.tenantId, 'Edited screenshot note.', 5, saved.metadata)
    const edited = (await new JSONLConversationHistory().getFullHistory(scope)).find(message => message.id === identity.id)!
    expect(edited.metadata?.[TOOL_SCREENSHOT_EVIDENCE_KEY]).toBeUndefined()
    expect(edited.metadata?.[CLEARED_TOOL_EVIDENCE_KEY]).toBeUndefined()
    await restarted.microCompactToolResults(scope, { keepRecent: 0, maxChars: 1 })
    const editedCleared = (await new JSONLConversationHistory().getFullHistory(scope)).find(message => message.id === identity.id)!
    expect(clearedToolModelContent(editedCleared, true)).not.toContain(file.path)
  })

  it('never derives a save receipt from pixels, output text, failed status or invalid metadata', () => {
    const result = { success: true, output: JSON.stringify({ ...metadata, dataUrl: image }), metadata }
    expect(captureScreenshotEvidence({ ...result, metadata: {} }, identity)).toBeUndefined()
    expect(captureScreenshotEvidence({ ...result, status: 'cancelled' }, identity)).toBeUndefined()
    for (const changed of [{ width: 0 }, { height: -1 }, { width: 1.5 }, { path: 'board.png' }, { expectedHash: 'missing' }, { screenshotSaved: false }]) {
      expect(captureScreenshotEvidence({ ...result, metadata: { ...metadata, ...changed } }, identity)).toBeUndefined()
    }
    expect(captureScreenshotEvidence(result, { ...identity, id: undefined })).toBeUndefined()
    const spoofed: Message = { ...identity, role: 'tool', toolName: 'browser_save_screenshot', content: result.output, metadata }
    expect(clearedToolModelContent(compact(spoofed), true)).not.toContain(file.path)
  })

  it('drops an oversized receipt without truncating its file identity', () => {
    const longIdentity = { id: 'm'.repeat(128), toolCallId: 'c'.repeat(128) }
    const longFile = { ...metadata, path: 'D:/' + 'p'.repeat(755) + '.png' }
    const receipt = captureScreenshotEvidence({ success: true, output: '', metadata: longFile }, longIdentity)
    expect(receipt?.path).toBe(longFile.path)
    const message: Message = { ...longIdentity, role: 'tool', toolName: 'browser_save_screenshot', content: '',
      metadata: { [TOOL_SCREENSHOT_EVIDENCE_KEY]: receipt } }
    const evidence = clearedToolEvidence(message)
    expect(JSON.stringify(evidence).length).toBeLessThanOrEqual(1280)
    expect(evidence.screenshot).toBeUndefined()
    const text = clearedToolModelContent(compact(message), true)
    expect(text.length).toBeLessThanOrEqual(MAX_CLEARED_TOOL_CONTENT_CHARS)
    expect(text).not.toContain('pppppppp')
  })
})
