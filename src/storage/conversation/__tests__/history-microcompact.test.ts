import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Message, ToolResult } from '../../../core/agent-context/types.js'
import { browserOutputPresentation } from '../../../core/utils/browser-output.js'
import { estimateModelHistoryTokens, modelMessageContent } from '../../../core/utils/model-context.js'
import { largeNativePng } from '../../../core/utils/__tests__/fixtures/native-image.js'
import { imageToolPayload } from '../../../core/utils/multimodal-context.js'
import { createHash } from 'node:crypto'
import { captureFileEvidence, clearedToolModelContent, CLEARED_TOOL_EVIDENCE_KEY, MAX_CLEARED_TOOL_CONTENT_CHARS, TOOL_FILE_EVIDENCE_KEY } from '../../../core/utils/tool-evidence.js'

type Ctx = { tenantId: string; sessionId: string }
type Result = { compacted: { cleared: number; freedTokens: number }; cached: Message[]; messages: Message[]; archive: Message[]; edited?: Message[]; editedCleared?: Message[]; recovered: ToolResult[]; foreignRecovery?: ToolResult; repeated: { cleared: number; freedTokens: number } }
const ctx: Ctx = { tenantId: 'micro-compact-tenant', sessionId: 'micro-compact-session' }
let fixture: string
let savedDataDir: string | undefined

function tool(id: string, content: string): Message {
  return { id, role: 'tool', content, toolCallId: `call-${id}`, toolName: 'execute_cmd', tokens: Math.max(1, Math.ceil(content.length / 4)) }
}
function user(id: string): Message { return { id, role: 'user', content: `message-${id}`, tokens: 2 } }

beforeEach(() => {
  savedDataDir = process.env.DATA_DIR
  fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'aether-microcompact-'))
  process.env.DATA_DIR = path.join(fixture, 'agent.db')
})
afterEach(() => {
  // History and SQLite are used only inside runScenario's subprocess, which
  // joins its owned database worker before exiting. This parent owns no client.
  if (savedDataDir === undefined) delete process.env.DATA_DIR
  else process.env.DATA_DIR = savedDataDir
  if (path.dirname(fixture) !== path.resolve(os.tmpdir()) || !path.basename(fixture).startsWith('aether-microcompact-')) throw new Error('Unsafe fixture cleanup')
  fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  expect(fs.existsSync(fixture)).toBe(false)
})

async function runScenario(backend: 'sqlite' | 'jsonl', messages: Message[], editId?: string, microOptions = { keepRecent: 10, maxChars: 64 }, recoverIds: string[] = []): Promise<Result> {
  // Exercise the unmocked history and transaction code in a real subprocess.
  // Its SQLite worker is a grandchild: the scenario's exit alone does not join
  // that worker, so wait for native handle release before parent fixture cleanup.
  const source = `
    import { initDb, closeDb, getDb } from ${JSON.stringify(new URL('../../sqlite/db.ts', import.meta.url).href)};
    import { SQLiteConversationHistory } from ${JSON.stringify(new URL('../history.ts', import.meta.url).href)};
    import { JSONLConversationHistory } from ${JSON.stringify(new URL('../jsonl-history.ts', import.meta.url).href)};
    import { searchHistoryTool } from ${JSON.stringify(new URL('../../../tools/get-context/search-history-tool.ts', import.meta.url).href)};
    const { readFileSync } = await import('node:fs');
    const { ctx, messages } = JSON.parse(readFileSync(process.argv[2], 'utf8'));
    const db = getDb();
    try {
      await initDb();
      const history = ${backend === 'sqlite' ? 'new SQLiteConversationHistory(1_000_000)' : 'new JSONLConversationHistory(1_000_000)'};
      for (const message of messages) await history.append(message, ctx);
      const compacted = await history.microCompactToolResults(ctx, ${JSON.stringify(microOptions)});
      const cached = await history.getFullHistory(ctx);
      const restarted = ${backend === 'sqlite' ? 'new SQLiteConversationHistory(1_000_000)' : 'new JSONLConversationHistory(1_000_000)'};
      const repeated = await restarted.microCompactToolResults(ctx, ${JSON.stringify(microOptions)});
      const active = await restarted.getFullHistory(ctx), archive = (await restarted.getArchive(ctx)).messages;
      const recovered = [];
      for (const id of ${JSON.stringify(recoverIds)}) recovered.push(await searchHistoryTool.execute({ messageId: id, imageIndex: 0 }, { ...ctx, history: restarted }));
      const foreignRecovery = ${recoverIds.length > 0} ? await searchHistoryTool.execute({ messageId: ${JSON.stringify(recoverIds[0] ?? '')}, imageIndex: 0 }, { ...ctx, sessionId: 'other-session', history: restarted }) : undefined;
      let edited, editedCleared;
      if (${JSON.stringify(editId ?? '')}) {
        await restarted.updateMessageContent(${JSON.stringify(editId ?? '')}, ctx.tenantId, 'Corrected browser observation', 8);
        edited = await restarted.getFullHistory(ctx);
        await restarted.microCompactToolResults(ctx, { keepRecent: 0 });
        editedCleared = await restarted.getFullHistory(ctx);
      }
      const output = 'MICROCOMPACT_RESULT:' + JSON.stringify({ compacted, repeated, cached, messages: active, archive, edited, editedCleared, recovered, foreignRecovery });
      await new Promise(resolve => process.stdout.write(output, resolve));
    } finally { closeDb(); await db.whenClosed(); }
    process.exit(0);
  `
  const root = fileURLToPath(new URL('../../../../', import.meta.url))
  const script = path.join(fixture, 'scenario.mjs')
  fs.writeFileSync(script, source)
  const input = path.join(fixture, 'input.json')
  fs.writeFileSync(input, JSON.stringify({ ctx, messages }))
  const output = await new Promise<string>((resolve, reject) => {
    execFile(process.execPath, ['--import', 'tsx', script, input],
      { cwd: root, env: { ...process.env, DATA_DIR: path.join(fixture, 'agent.db') }, windowsHide: true, timeout: 10_000, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => { if (error) reject(new Error(`History scenario failed: ${stderr || error.message}`)); else resolve(stdout) })
  })
  const result = output.split(/\r?\n/).find(line => line.startsWith('MICROCOMPACT_RESULT:'))
  if (!result) throw new Error('History scenario returned no result')
  return JSON.parse(result.slice('MICROCOMPACT_RESULT:'.length)) as Result
}

describe.each(['sqlite', 'jsonl'] as const)('%s micro-compaction', backend => {
  it('recovers two exact image versions after clearing and restart without crossing sessions or confusing hash domains', async () => {
    const images = ['data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=', largeNativePng().url]
    const originals = images.map((dataUrl, index): Message => {
      const bytes = Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64')
      const version = { path: `D:/workspace/page-${index}.png`, expectedHash: 'sha256:' + createHash('sha256').update(bytes).digest('hex'), encoding: 'binary-or-non-utf8', lineEnding: 'none', utf8Bom: false }
      return { ...tool(`image-${index}`, JSON.stringify({ filename: `page-${index}.png`, mimeType: 'image/png', size: bytes.length, dataUrl, fileVersion: version })),
        toolName: 'read_file', metadata: { ...version, [TOOL_FILE_EVIDENCE_KEY]: captureFileEvidence(version) } }
    })
    const result = await runScenario(backend, [user('start'), ...originals, ...Array.from({ length: 11 }, (_, i) => user('later-' + i))],
      'image-0', { keepRecent: 10, maxChars: 8000 }, originals.map(message => message.id!))
    expect(result.compacted.cleared).toBe(2)
    expect(result.repeated.cleared).toBe(0)
    originals.forEach((original, index) => {
      const active = result.messages.find(message => message.id === original.id)!
      const text = clearedToolModelContent(active, true)
      expect(active.content).toBe('[tool result cleared]')
      expect(text).toContain(original.id!)
      expect(text).toContain(original.metadata.expectedHash)
      expect(text.length).toBeLessThanOrEqual(MAX_CLEARED_TOOL_CONTENT_CHARS)
      expect(text).not.toContain('data:image')
      expect(active.tokens).toBeGreaterThan(5)
      expect(result.archive.find(message => message.id === original.id)!.content).toBe(original.content)
      expect(result.recovered[index].success).toBe(true)
      const recovered = JSON.parse(result.recovered[index].output)
      expect(recovered.dataUrl).toBe(images[index])
      expect(recovered.fileVersion.expectedHash).toBe(original.metadata.expectedHash)
      expect(recovered.description).toContain('dataURLSha256=')
      expect(recovered.messages[0].images[0].hashDomain).toBe('data-url')
      expect('sha256:' + recovered.messages[0].images[0].sha256).not.toBe(original.metadata.expectedHash)
    })
    expect(result.foreignRecovery!.success).toBe(false)
    expect(result.foreignRecovery!.metadata?.code).toBe('IMAGE_NOT_FOUND')
    expect(result.foreignRecovery!.output).not.toContain('data:image')
    const edited = result.editedCleared!.find(message => message.id === 'image-0')!
    expect(edited.metadata[TOOL_FILE_EVIDENCE_KEY]).toBeUndefined()
    expect(edited.metadata[CLEARED_TOOL_EVIDENCE_KEY].file).toBeUndefined()
    expect(clearedToolModelContent(edited, true)).not.toContain(originals[0].metadata.expectedHash)
  }, 15_000)

  it('retains recent native pixels under the text cap and archives older pictures losslessly', async () => {
    const image = largeNativePng()
    const content = JSON.stringify({ filename: 'layout.png', mimeType: 'image/png', size: image.buffer.length, dataUrl: image.url,
      hasDataUrl: true, fileVersion: { path: 'layout.png', expectedHash: 'sha256:' + 'a'.repeat(64), encoding: 'binary-or-non-utf8', lineEnding: 'none', utf8Bom: false } })
    const old = { ...tool('old-image', content), toolName: 'read_file' }
    const recent = { ...tool('recent-image', content), toolName: 'read_file' }
    const messages = [user('first'), old, ...Array.from({ length: 11 }, (_, i) => user('gap-' + i)), recent, user('latest')]
    const result = await runScenario(backend, messages, undefined, { keepRecent: 10, maxChars: 8000 })
    expect(result.compacted.cleared).toBe(1)
    for (const history of [result.cached, result.messages]) {
      expect(history.find(message => message.id === old.id)?.content).toBe('[tool result cleared]')
      const retained = history.find(message => message.id === recent.id)!
      expect(imageToolPayload(modelMessageContent(retained))?.dataUrl === image.url).toBe(true)
      expect(estimateModelHistoryTokens([retained])).toBeLessThan(4000)
    }
    expect(result.archive.find(message => message.id === old.id)?.content === content).toBe(true)
    expect(result.repeated).toEqual({ cleared: 0, freedTokens: 0 })
  }, 15_000)

  it('真正清理浏览器的模型语义投影，同时保留可回溯原图与语义，并允许后续更正', async () => {
    const screenshot = { width: 1, height: 1, dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=' }
    const presentation = browserOutputPresentation(JSON.stringify({
      tab: { tabId: 'actual-schema', title: '订单审核', url: 'http://127.0.0.1/orders', navigationId: 3 },
      text: '订单总额 7913 元；只读审核，不允许提交。'.repeat(40),
      elements: [{ role: 'button', name: '审核', ref: 'button-1' }], screenshot,
      viewport: { width: 1000, height: 800 },
      interaction: { type: 'click', x: 24, y: 40, viewport: { width: 1000, height: 800 }, screenshot },
    }))!
    const original: Message = { ...tool('browser-result', presentation.displayOutput), toolName: 'browser_click', modelInputContent: presentation.modelInputContent }
    const result = await runScenario(backend, [user('request'), original, user('next')], original.id)
    expect(result.compacted.cleared).toBe(1)
    for (const history of [result.cached, result.messages]) {
      const active = history.find(message => message.id === original.id)!
      expect(active.content).toBe('[tool result cleared]')
      expect(modelMessageContent(active)).toContain('[tool result cleared]')
      expect(modelMessageContent(active)).not.toContain('订单总额 7913')
      expect(estimateModelHistoryTokens([active])).toBeLessThan(estimateModelHistoryTokens([original]) / 4)
    }
    const archived = result.archive.find(message => message.id === original.id)!
    expect(archived.content).toBe(original.content)
    expect(archived.modelInputContent).toBe(original.modelInputContent)
    expect(modelMessageContent(archived)).toContain('订单总额 7913')
    expect(modelMessageContent(result.edited!.find(message => message.id === original.id)!)).toBe('Corrected browser observation')
    expect(result.repeated).toEqual({ cleared: 0, freedTokens: 0 })
  }, 15_000)

  it('保留十条以内且不超 maxChars 的工具结果', async () => {
    // Seed a valid conversation before tool output; orphaned tool rows are intentionally dropped.
    const result = await runScenario(backend, [user('first'), tool('short-tool', 'small output'), user('follow-up'), user('latest')])
    expect(result.compacted.cleared).toBe(0)
    expect(result.messages.find(message => message.id === 'short-tool')?.content).toBe('small output')
  }, 15_000)
  it('清理最近十条内超出 maxChars 的结果，同时清理窗口外旧结果', async () => {
    const messages = [user('old-user'), tool('old-tool', 'old output')]
    for (let index = 0; index < 8; index++) messages.push(user(`context-${index}`))
    messages.push(tool('recent-huge', 'x'.repeat(200)), user('latest'))
    const result = await runScenario(backend, messages)
    expect(result.compacted.cleared).toBe(2)
    expect(result.messages.find(message => message.id === 'old-tool')?.content).toBe('[tool result cleared]')
    expect(result.messages.find(message => message.id === 'recent-huge')?.content).toBe('[tool result cleared]')
    expect(result.messages.find(message => message.id === 'old-tool')?.metadata?.outputPreview).toBe('old output')
    expect(result.messages.find(message => message.id === 'recent-huge')?.metadata?.outputPreview).toBe('x'.repeat(200))
    expect(result.archive.find(message => message.id === 'old-tool')?.content).toBe('old output')
    expect(result.archive.find(message => message.id === 'recent-huge')?.content).toBe('x'.repeat(200))
    expect(result.archive.find(message => message.id === 'recent-huge')?.tokens).toBe(50)
    expect(result.repeated).toEqual({ cleared: 0, freedTokens: 0 })
  }, 15_000)
})
