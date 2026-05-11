import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { __resetSuperpowerWarnFlagsForTests } from '../../../core/superpower.js'

/**
 * SQLiteConversationHistory — maxTokens 倍率动态读取测试
 *
 * 关注点：
 *   1. 无参构造时读取 env + Superpower 倍率（动态，不冻结）
 *   2. 显式传入 maxTokens 时不被倍率影响
 *   3. 切换 SUPERPOWER_MODE 后下一次实例化立即反映（热更新语义）
 *
 * 由于 SQLiteConversationHistory 内部调用 getDb() 等需要 DB 初始化，
 * 我们只验证「构造时的 maxTokens 赋值」不测 DB 操作。
 * 通过访问 (instance as any).maxTokens 做白盒断言。
 */

function withEnv(vars: Record<string, string | undefined>, fn: () => void) {
  const saved: Record<string, string | undefined> = {}
  for (const k of Object.keys(vars)) {
    saved[k] = process.env[k]
    if (vars[k] === undefined) delete process.env[k]
    else process.env[k] = vars[k] as string
  }
  try { fn() } finally {
    for (const k of Object.keys(vars)) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k] as string
    }
  }
}

// 动态导入，避免模块顶层代码在 import 时触发 getDb()
const { SQLiteConversationHistory } = await import('../history.js')

beforeEach(() => __resetSuperpowerWarnFlagsForTests())

describe('SQLiteConversationHistory / maxTokens 动态倍率', () => {
  it('off 模式 → maxTokens = HISTORY_MAX_TOKENS 原值', () => {
    withEnv({ SUPERPOWER_MODE: 'off', SUPERPOWER_ENABLED: undefined, HISTORY_MAX_TOKENS: '20000' }, () => {
      const h = new SQLiteConversationHistory()
      expect((h as any).maxTokens).toBe(20000)
    })
  })

  it('balanced 模式 → maxTokens ×2', () => {
    withEnv({ SUPERPOWER_MODE: 'balanced', SUPERPOWER_ENABLED: undefined, HISTORY_MAX_TOKENS: '20000' }, () => {
      const h = new SQLiteConversationHistory()
      expect((h as any).maxTokens).toBe(40000)
    })
  })

  it('methodology 模式 → maxTokens ×2', () => {
    withEnv({ SUPERPOWER_MODE: 'methodology', SUPERPOWER_ENABLED: undefined, HISTORY_MAX_TOKENS: '20000' }, () => {
      const h = new SQLiteConversationHistory()
      expect((h as any).maxTokens).toBe(40000)
    })
  })

  it('max 模式 → maxTokens ×4', () => {
    withEnv({ SUPERPOWER_MODE: 'max', SUPERPOWER_ENABLED: undefined, HISTORY_MAX_TOKENS: '20000' }, () => {
      const h = new SQLiteConversationHistory()
      expect((h as any).maxTokens).toBe(80000)
    })
  })

  it('显式传入 maxTokens 时不被倍率放大（子代理/测试固定 cap）', () => {
    withEnv({ SUPERPOWER_MODE: 'max', SUPERPOWER_ENABLED: undefined, HISTORY_MAX_TOKENS: '20000' }, () => {
      const h = new SQLiteConversationHistory(5000)
      expect((h as any).maxTokens).toBe(5000)  // ×4 = 20000 时说明有 bug
    })
  })

  it('切换模式后下次实例化立即反映（热更新）', () => {
    let h: any
    withEnv({ SUPERPOWER_MODE: 'off', SUPERPOWER_ENABLED: undefined, HISTORY_MAX_TOKENS: '20000' }, () => {
      h = new SQLiteConversationHistory()
      expect(h.maxTokens).toBe(20000)
    })
    withEnv({ SUPERPOWER_MODE: 'max', SUPERPOWER_ENABLED: undefined, HISTORY_MAX_TOKENS: '20000' }, () => {
      h = new SQLiteConversationHistory()
      expect(h.maxTokens).toBe(80000)  // 同一进程内无需重启
    })
  })
})
