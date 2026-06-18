/**
 * SQLiteConversationHistory — compress() 与 tombstone 冲突测试
 * ============================================================================
 * 复现 Bug：compress() 内部先调用 clear()（设置 5 秒墓碑），
 * 再立即 append() 写入摘要和最近消息——由于墓碑期未过，
 * 所有 append 被拦截，导致会话历史清空后无法恢复，getFullHistory 返回空数组。
 *
 * 预期（修复前）：compress 后 getFullHistory 返回 0 条 → BUG
 * 预期（修复后）：compress 后 getFullHistory 返回 7 条（1 system 摘要 + 6 recent）
 *
 * 运行：`npx vitest run src/storage/conversation/__tests__/history-compress-tombstone.test.ts`
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── 内存 DB 模拟（纯 JS，不依赖 libsql/better-sqlite3）─────────────────────
type Row = Record<string, unknown>

let rows: Row[] = []
let idCounter = 0

const mockDb = {
  execute(opts: { sql: string; args?: unknown[] }) {
    const sql = opts.sql.trim().toUpperCase()
    const args = opts.args ?? []

    if (sql.startsWith('INSERT INTO CONVERSATIONS')) {
      const msgId = args[3] as string | null
      const role = args[4] as string
      const content = args[5] as string
      const tokens = args[11] as number | null
      rows.push({
        id: ++idCounter,
        tenant_id: args[0],
        session_id: args[1],
        conversation_id: args[2],
        message_id: msgId,
        role,
        content,
        reasoning_content: args[6] ?? null,
        tool_call_id: args[7] ?? null,
        tool_call_name: args[8] ?? null,
        tool_name: args[9] ?? null,
        tool_args: args[10] ?? null,
        tokens: tokens ?? 0,
        token_usage: args[12] ?? null,
        model_id: args[13] ?? null,
        metadata: args[14] ?? null,
        created_at: Math.floor(Date.now() / 1000) + idCounter, // ensure unique order
      })
      return Promise.resolve({ rows: [] })
    }

    if (sql.startsWith('SELECT') && sql.includes('FROM CONVERSATIONS')) {
      const tenantId = args[0] as string
      const sessionId = args[1] as string
      const filtered = rows
        .filter((r) => r.tenant_id === tenantId && r.session_id === sessionId)
        .sort((a, b) => {
          const tDiff = (a.created_at as number) - (b.created_at as number)
          return tDiff !== 0 ? tDiff : (a.id as number) - (b.id as number)
        })
      return Promise.resolve({ rows: filtered })
    }

    if (sql.startsWith('DELETE FROM CONVERSATIONS')) {
      // WHERE tenant_id = ? AND session_id = ?
      if (args.length === 2) {
        rows = rows.filter(
          (r) => !(r.tenant_id === args[0] && r.session_id === args[1]),
        )
      }
      // WHERE id = ? AND tenant_id = ?
      if (args.length === 2 && typeof args[0] === 'number') {
        rows = rows.filter((r) => !(r.id === args[0] && r.tenant_id === args[1]))
      }
      return Promise.resolve({ rows: [] })
    }

    return Promise.resolve({ rows: [] })
  },
}

vi.mock('../../../storage/sqlite/db.js', () => ({
  getDb: () => mockDb,
}))

// ── 导入被测类 ────────────────────────────────────────────────────────────────
import { SQLiteConversationHistory } from '../history.js'

const ctx = { tenantId: 'test-tenant', sessionId: 'test-session' }

async function seedMessages(count: number) {
  const h = new SQLiteConversationHistory(9_999_999)
  for (let i = 0; i < count; i++) {
    await h.append(
      {
        role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
        content: `message content ${i}`,
        tokens: 100,
      },
      ctx,
    )
  }
}

describe('compress() 与 tombstone 冲突 — Bug 复现与修复验证', () => {
  beforeEach(() => {
    rows = []
    idCounter = 0
  })

  it('【BUG 复现】compress 后 getFullHistory 不应返回空数组', async () => {
    await seedMessages(20)

    const h = new SQLiteConversationHistory(9_999_999)
    const before = await h.getFullHistory(ctx)
    expect(before.length).toBe(20)

    // 执行压缩（keepRecent=6）
    await h.compress(ctx, async () => 'summary of old messages', 6)

    const after = await h.getFullHistory(ctx)
    console.log('[test] after compress, message count:', after.length)
    console.log('[test] roles:', after.map((m) => m.role).join(', '))

    // ★ 核心断言：修复前这里会是 0（所有 append 被 tombstone 拦截）
    expect(after.length).toBeGreaterThan(0)

    // ★ 修复后：1 system(摘要) + 6 recent = 7
    expect(after.length).toBe(7)
    expect(after[0].role).toBe('system')
    expect(after[0].content).toBe('summary of old messages')
  })

  it('compress 后 recentMessages 是原始最后 6 条', async () => {
    await seedMessages(20)
    const h = new SQLiteConversationHistory(9_999_999)
    const allBefore = await h.getFullHistory(ctx)
    const expectedRecent = allBefore.slice(-6).map((m) => m.content)

    await h.compress(ctx, async () => 'summary', 6)

    const after = await h.getFullHistory(ctx)
    const actualRecent = after.slice(1).map((m) => m.content)
    expect(actualRecent).toEqual(expectedRecent)
  })
})
