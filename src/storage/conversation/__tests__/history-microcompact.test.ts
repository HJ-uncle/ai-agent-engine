import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { closeDb } from '../../sqlite/db.js'
import type { Message } from '../../../core/agent-context/types.js'

type Ctx = { tenantId: string; sessionId: string }
type Result = { compacted: { cleared: number; freedTokens: number }; messages: Message[] }
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
  // JSONL lazy migration can open the shared SQLite client even without a SQLite setup helper.
  closeDb()
  if (savedDataDir === undefined) delete process.env.DATA_DIR
  else process.env.DATA_DIR = savedDataDir
  if (path.dirname(fixture) !== path.resolve(os.tmpdir()) || !path.basename(fixture).startsWith('aether-microcompact-')) throw new Error('Unsafe fixture cleanup')
  fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  expect(fs.existsSync(fixture)).toBe(false)
})

async function runScenario(backend: 'sqlite' | 'jsonl', messages: Message[]): Promise<Result> {
  // libsql's local transaction object retains its native SQLite connection until GC,
  // even after commit/close. A real subprocess exit deterministically releases Windows
  // file handles before cleanup while exercising the unmocked history and transaction code.
  const source = `
    import { initDb, closeDb } from ${JSON.stringify(new URL('../../sqlite/db.ts', import.meta.url).href)};
    import { SQLiteConversationHistory } from ${JSON.stringify(new URL('../history.ts', import.meta.url).href)};
    import { JSONLConversationHistory } from ${JSON.stringify(new URL('../jsonl-history.ts', import.meta.url).href)};
    const { ctx, messages } = JSON.parse(process.argv[2]);
    await initDb();
    try {
      const history = ${backend === 'sqlite' ? 'new SQLiteConversationHistory(1_000_000)' : 'new JSONLConversationHistory(1_000_000)'};
      for (const message of messages) await history.append(message, ctx);
      const compacted = await history.microCompactToolResults(ctx, { keepRecent: 10, maxChars: 64 });
      const output = 'MICROCOMPACT_RESULT:' + JSON.stringify({ compacted, messages: await history.getFullHistory(ctx) });
      await new Promise(resolve => process.stdout.write(output, resolve));
    } finally { closeDb(); }
    process.exit(0);
  `
  const root = fileURLToPath(new URL('../../../../', import.meta.url))
  const script = path.join(fixture, 'scenario.mjs')
  fs.writeFileSync(script, source)
  const output = await new Promise<string>((resolve, reject) => {
    execFile(process.execPath, ['--import', 'tsx', script, JSON.stringify({ ctx, messages })],
      { cwd: root, env: { ...process.env, DATA_DIR: path.join(fixture, 'agent.db') }, windowsHide: true, timeout: 10_000 },
      (error, stdout, stderr) => { if (error) reject(new Error(`History scenario failed: ${stderr || error.message}`)); else resolve(stdout) })
  })
  const result = output.split(/\r?\n/).find(line => line.startsWith('MICROCOMPACT_RESULT:'))
  if (!result) throw new Error('History scenario returned no result')
  return JSON.parse(result.slice('MICROCOMPACT_RESULT:'.length)) as Result
}

describe.each(['sqlite', 'jsonl'] as const)('%s micro-compaction', backend => {
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
  }, 15_000)
})
