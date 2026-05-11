import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  isSuperpowerEnabled,
  applySuperpowerMultiplier,
  getSuperpowerCompressRatio,
  resolveDefaultAllowedTools,
  resolveSuperpowerMode,
  SUPERPOWER_CORE_TOOLS,
  SUPERPOWER_ONLY_TOOLS,
  SUPERPOWER_MODE_CONFIG,
  runSuperpowerSelfCheck,
  logSuperpowerSelfCheck,
  __resetSuperpowerWarnFlagsForTests,
} from '../superpower.js'

/**
 * Superpower 核心逻辑单元测试（Layer 2 — 四档模式 + legacy 兼容）
 *
 * 关注点：
 *   1. 模式解析优先级（MODE 合法 > legacy true→methodology > 其它→off）
 *   2. 一次性 deprecation / invalid-mode 告警
 *   3. 倍率表按模式派发（off/balanced/methodology/max）
 *   4. 压缩阈值：只有 max 覆盖为 0.7
 *   5. resolveDefaultAllowedTools 的 4 象限语义（off 收敛 CORE / 其它直通）
 *   6. 启动自检三类违规识别
 *   7. isSuperpowerEnabled 作为 mode !== 'off' 的 thin alias 工作
 */

function withEnv(vars: Record<string, string | undefined>, fn: () => void) {
  const saved: Record<string, string | undefined> = {}
  for (const k of Object.keys(vars)) {
    saved[k] = process.env[k]
    if (vars[k] === undefined) delete process.env[k]
    else process.env[k] = vars[k] as string
  }
  try {
    fn()
  } finally {
    for (const k of Object.keys(vars)) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k] as string
    }
  }
}

/** 便捷：仅设置 SUPERPOWER_MODE 并清掉 legacy */
function withMode(mode: string | undefined, fn: () => void) {
  withEnv({ SUPERPOWER_MODE: mode, SUPERPOWER_ENABLED: undefined }, fn)
}

/** 便捷：仅设置 legacy SUPERPOWER_ENABLED 并清掉新字段 */
function withLegacy(value: string | undefined, fn: () => void) {
  withEnv({ SUPERPOWER_MODE: undefined, SUPERPOWER_ENABLED: value }, fn)
}

beforeEach(() => __resetSuperpowerWarnFlagsForTests())

// ─────────────────────────────────────────────────────────────────────────
describe('superpower / resolveSuperpowerMode', () => {
  it('未配置任何 env → off（默认安全）', () => {
    withEnv({ SUPERPOWER_MODE: undefined, SUPERPOWER_ENABLED: undefined }, () => {
      expect(resolveSuperpowerMode()).toBe('off')
    })
  })

  it('SUPERPOWER_MODE 合法值直接生效', () => {
    for (const m of ['off', 'balanced', 'methodology', 'max'] as const) {
      withMode(m, () => expect(resolveSuperpowerMode()).toBe(m))
    }
  })

  it('SUPERPOWER_MODE 合法时忽略 legacy（MODE 优先）', () => {
    withEnv({ SUPERPOWER_MODE: 'balanced', SUPERPOWER_ENABLED: 'true' }, () => {
      expect(resolveSuperpowerMode()).toBe('balanced')
    })
  })

  it('SUPERPOWER_MODE 非法值 → 降级到 legacy → off（legacy 缺失）', () => {
    const warn = vi.fn()
    const log = { warn, debug: vi.fn() } as any
    withEnv({ SUPERPOWER_MODE: 'turbo', SUPERPOWER_ENABLED: undefined }, () => {
      expect(resolveSuperpowerMode(log)).toBe('off')
    })
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('SUPERPOWER_MODE 非法值 + legacy true → methodology', () => {
    withEnv({ SUPERPOWER_MODE: 'turbo', SUPERPOWER_ENABLED: 'true' }, () => {
      expect(resolveSuperpowerMode()).toBe('methodology')
    })
  })

  it('legacy true → methodology', () => {
    withLegacy('true', () => expect(resolveSuperpowerMode()).toBe('methodology'))
  })

  it('legacy 任意非 "true" 值 → off', () => {
    withLegacy('false', () => expect(resolveSuperpowerMode()).toBe('off'))
    withLegacy('1', () => expect(resolveSuperpowerMode()).toBe('off'))
    withLegacy('yes', () => expect(resolveSuperpowerMode()).toBe('off'))
    withLegacy('TRUE', () => expect(resolveSuperpowerMode()).toBe('off'))
  })

  it('legacy=true 只打一次 deprecation warn（即使调用 N 次）', () => {
    const warn = vi.fn()
    const log = { warn, debug: vi.fn() } as any
    withLegacy('true', () => {
      for (let i = 0; i < 10; i++) resolveSuperpowerMode(log)
    })
    expect(warn).toHaveBeenCalledTimes(1)
    const [, msg] = warn.mock.calls[0]
    expect(String(msg)).toContain('DEPRECATION')
    expect(String(msg)).toContain('SUPERPOWER_ENABLED')
    expect(String(msg)).toContain('SUPERPOWER_MODE')
  })

  it('invalid-mode 只打一次 warn', () => {
    const warn = vi.fn()
    const log = { warn, debug: vi.fn() } as any
    withEnv({ SUPERPOWER_MODE: 'xxx', SUPERPOWER_ENABLED: undefined }, () => {
      for (let i = 0; i < 5; i++) resolveSuperpowerMode(log)
    })
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('MODE 合法时不打 deprecation（即使 legacy=true 同时存在）', () => {
    const warn = vi.fn()
    const log = { warn, debug: vi.fn() } as any
    withEnv({ SUPERPOWER_MODE: 'max', SUPERPOWER_ENABLED: 'true' }, () => {
      resolveSuperpowerMode(log)
    })
    expect(warn).not.toHaveBeenCalled()
  })
})

// ─────────────────────────────────────────────────────────────────────────
describe('superpower / isSuperpowerEnabled (deprecated thin alias)', () => {
  it('mode off → false；其它 → true', () => {
    withMode('off', () => expect(isSuperpowerEnabled()).toBe(false))
    withMode('balanced', () => expect(isSuperpowerEnabled()).toBe(true))
    withMode('methodology', () => expect(isSuperpowerEnabled()).toBe(true))
    withMode('max', () => expect(isSuperpowerEnabled()).toBe(true))
  })

  it('legacy true → true（映射到 methodology）', () => {
    withLegacy('true', () => expect(isSuperpowerEnabled()).toBe(true))
  })
})

// ─────────────────────────────────────────────────────────────────────────
describe('superpower / applySuperpowerMultiplier', () => {
  it('off 全部返回 base 原值', () => {
    withMode('off', () => {
      expect(applySuperpowerMultiplier('tokenBudget', 60000)).toBe(60000)
      expect(applySuperpowerMultiplier('maxIterations', 50)).toBe(50)
      expect(applySuperpowerMultiplier('toolOutputMaxChars', 4000)).toBe(4000)
      expect(applySuperpowerMultiplier('historyMaxTokens', 20000)).toBe(20000)
    })
  })

  it('balanced 全部字段 ×2', () => {
    withMode('balanced', () => {
      expect(applySuperpowerMultiplier('tokenBudget', 60000)).toBe(120000)
      expect(applySuperpowerMultiplier('maxIterations', 50)).toBe(100)
      expect(applySuperpowerMultiplier('toolOutputMaxChars', 4000)).toBe(8000)
      expect(applySuperpowerMultiplier('historyMaxTokens', 20000)).toBe(40000)
    })
  })

  it('methodology 倍率等同于 balanced', () => {
    withMode('methodology', () => {
      expect(applySuperpowerMultiplier('tokenBudget', 60000)).toBe(120000)
      expect(applySuperpowerMultiplier('maxIterations', 50)).toBe(100)
    })
  })

  it('max 按字段不对称放大（tokenBudget ×5，其它 ×4）', () => {
    withMode('max', () => {
      expect(applySuperpowerMultiplier('tokenBudget', 60000)).toBe(300000)    // ×5
      expect(applySuperpowerMultiplier('maxIterations', 50)).toBe(200)         // ×4
      expect(applySuperpowerMultiplier('toolOutputMaxChars', 4000)).toBe(16000)// ×4
      expect(applySuperpowerMultiplier('historyMaxTokens', 20000)).toBe(80000) // ×4
    })
  })

  it('legacy true 下对应 methodology 的 ×2（不再是 ×5）', () => {
    withLegacy('true', () => {
      expect(applySuperpowerMultiplier('tokenBudget', 60000)).toBe(120000)
    })
  })

  it('边界：base=0 返回 0；负数直通', () => {
    withMode('max', () => {
      expect(applySuperpowerMultiplier('tokenBudget', 0)).toBe(0)
      expect(applySuperpowerMultiplier('tokenBudget', -10)).toBe(-50)
    })
  })
})

// ─────────────────────────────────────────────────────────────────────────
describe('superpower / getSuperpowerCompressRatio', () => {
  it('off / balanced / methodology → 直返 baseRatio', () => {
    withMode('off', () => expect(getSuperpowerCompressRatio(0.5)).toBe(0.5))
    withMode('balanced', () => expect(getSuperpowerCompressRatio(0.5)).toBe(0.5))
    withMode('methodology', () => expect(getSuperpowerCompressRatio(0.5)).toBe(0.5))
  })

  it('max → 固定覆盖为 0.7（放宽）', () => {
    withMode('max', () => {
      expect(getSuperpowerCompressRatio(0.5)).toBe(0.7)
      expect(getSuperpowerCompressRatio(0.1)).toBe(0.7)
      expect(getSuperpowerCompressRatio(0.9)).toBe(0.7)
    })
  })
})

// ─────────────────────────────────────────────────────────────────────────
describe('superpower / resolveDefaultAllowedTools', () => {
  describe('off 模式（全局安全阀）', () => {
    it('undefined → CORE 副本', () => {
      withMode('off', () => {
        const result = resolveDefaultAllowedTools(undefined)
        expect(new Set(result)).toEqual(new Set(SUPERPOWER_CORE_TOOLS))
      })
    })
    it('null → CORE 副本', () => {
      withMode('off', () => {
        const result = resolveDefaultAllowedTools(null)
        expect(new Set(result)).toEqual(new Set(SUPERPOWER_CORE_TOOLS))
      })
    })
    it('[] → 保持空', () => {
      withMode('off', () => expect(resolveDefaultAllowedTools([])).toEqual([]))
    })
    it('显式列表 → 与 CORE 交集', () => {
      withMode('off', () => {
        const result = resolveDefaultAllowedTools(['read_file', 'run_command', 'grep', 'web_fetch'])
        expect(result).toEqual(expect.arrayContaining(['read_file', 'grep']))
        expect(result).not.toContain('run_command')
        expect(result).not.toContain('web_fetch')
      })
    })
    it('全高危 → 退化到 CORE', () => {
      withMode('off', () => {
        const result = resolveDefaultAllowedTools(['run_command', 'web_fetch', 'delete_file'])
        expect(new Set(result)).toEqual(new Set(SUPERPOWER_CORE_TOOLS))
      })
    })
  })

  for (const m of ['balanced', 'methodology', 'max'] as const) {
    describe(`${m} 模式（全量工具，尊重调用方）`, () => {
      it('undefined → undefined', () => {
        withMode(m, () => expect(resolveDefaultAllowedTools(undefined)).toBeUndefined())
      })
      it('null → undefined', () => {
        withMode(m, () => expect(resolveDefaultAllowedTools(null)).toBeUndefined())
      })
      it('[] → [] 原样', () => {
        withMode(m, () => expect(resolveDefaultAllowedTools([])).toEqual([]))
      })
      it('显式列表 → 原样（包含高危）', () => {
        withMode(m, () => {
          const input = ['read_file', 'run_command', 'web_fetch']
          expect(resolveDefaultAllowedTools(input)).toEqual(input)
        })
      })
    })
  }
})

// ─────────────────────────────────────────────────────────────────────────
describe('superpower / SUPERPOWER_MODE_CONFIG 结构契约', () => {
  it('off 关闭全量工具，其它都开', () => {
    expect(SUPERPOWER_MODE_CONFIG.off.allowAllTools).toBe(false)
    expect(SUPERPOWER_MODE_CONFIG.balanced.allowAllTools).toBe(true)
    expect(SUPERPOWER_MODE_CONFIG.methodology.allowAllTools).toBe(true)
    expect(SUPERPOWER_MODE_CONFIG.max.allowAllTools).toBe(true)
  })

  it('methodology / max 开启方法论注入；off / balanced 关闭', () => {
    expect(SUPERPOWER_MODE_CONFIG.off.methodology).toBe(false)
    expect(SUPERPOWER_MODE_CONFIG.balanced.methodology).toBe(false)
    expect(SUPERPOWER_MODE_CONFIG.methodology.methodology).toBe(true)
    expect(SUPERPOWER_MODE_CONFIG.max.methodology).toBe(true)
  })

  it('artifactDirs 与 methodology 位同步', () => {
    for (const m of ['off', 'balanced', 'methodology', 'max'] as const) {
      expect(SUPERPOWER_MODE_CONFIG[m].artifactDirs).toBe(SUPERPOWER_MODE_CONFIG[m].methodology)
    }
  })

  it('只有 max 有 compressRatio 覆盖', () => {
    expect(SUPERPOWER_MODE_CONFIG.off.compressRatio).toBeUndefined()
    expect(SUPERPOWER_MODE_CONFIG.balanced.compressRatio).toBeUndefined()
    expect(SUPERPOWER_MODE_CONFIG.methodology.compressRatio).toBeUndefined()
    expect(SUPERPOWER_MODE_CONFIG.max.compressRatio).toBe(0.7)
  })
})

// ─────────────────────────────────────────────────────────────────────────
describe('superpower / runSuperpowerSelfCheck', () => {
  it('CORE ∩ ONLY = ∅（核心与增强集合必须互斥）', () => {
    const intersection = [...SUPERPOWER_CORE_TOOLS].filter(t => SUPERPOWER_ONLY_TOOLS.has(t))
    expect(intersection).toEqual([])
  })

  it('空 registry → missingInRegistry 包含全部 CORE', () => {
    const fakeRegistry = { has: (_: string) => false, list: () => [] }
    const result = runSuperpowerSelfCheck(fakeRegistry)
    expect(result.disjointViolations).toEqual([])
    expect(result.missingInRegistry.length).toBe(SUPERPOWER_CORE_TOOLS.size)
    expect(result.unknownTools).toEqual([])
  })

  it('全量 CORE 都注册时 missingInRegistry 为空', () => {
    const fakeRegistry = {
      has: (n: string) => SUPERPOWER_CORE_TOOLS.has(n),
      list: () => [...SUPERPOWER_CORE_TOOLS].map(name => ({ name })),
    }
    const result = runSuperpowerSelfCheck(fakeRegistry)
    expect(result.missingInRegistry).toEqual([])
    expect(result.unknownTools).toEqual([])
  })

  it('未分类工具 → 记入 unknownTools', () => {
    const fakeRegistry = {
      has: (n: string) => SUPERPOWER_CORE_TOOLS.has(n) || n === 'mystery_tool',
      list: () => [
        ...[...SUPERPOWER_CORE_TOOLS].map(name => ({ name })),
        { name: 'mystery_tool' },
      ],
    }
    const result = runSuperpowerSelfCheck(fakeRegistry)
    expect(result.unknownTools).toEqual(['mystery_tool'])
  })

  it('缺少某个 CORE 工具时精确定位', () => {
    const fakeRegistry = {
      has: (n: string) => SUPERPOWER_CORE_TOOLS.has(n) && n !== 'grep',
      list: () => [...SUPERPOWER_CORE_TOOLS].filter(n => n !== 'grep').map(name => ({ name })),
    }
    const result = runSuperpowerSelfCheck(fakeRegistry)
    expect(result.missingInRegistry).toEqual(['grep'])
  })

  it('registry.list 抛错不影响其它检查', () => {
    const fakeRegistry = {
      has: (n: string) => SUPERPOWER_CORE_TOOLS.has(n),
      list: () => { throw new Error('list failure') },
    }
    const result = runSuperpowerSelfCheck(fakeRegistry)
    expect(result.missingInRegistry).toEqual([])
    expect(result.unknownTools).toEqual([])
  })

  it('registry 无 has 方法时跳过 missingInRegistry 检查', () => {
    const fakeRegistry = { list: () => [] }
    const result = runSuperpowerSelfCheck(fakeRegistry)
    expect(result.missingInRegistry).toEqual([])
  })
})

// ─────────────────────────────────────────────────────────────────────────
describe('superpower / logSuperpowerSelfCheck', () => {
  it('三类问题都触发 warn/debug 日志', () => {
    const warn = vi.fn()
    const debug = vi.fn()
    const fakeLogger = { warn, debug } as any
    logSuperpowerSelfCheck(fakeLogger, {
      disjointViolations: ['dup_tool'],
      missingInRegistry: ['grep'],
      unknownTools: ['foo'],
    })
    expect(warn).toHaveBeenCalledTimes(2)
    expect(debug).toHaveBeenCalledTimes(1)
  })

  it('无问题时不打日志', () => {
    const warn = vi.fn()
    const debug = vi.fn()
    const fakeLogger = { warn, debug } as any
    logSuperpowerSelfCheck(fakeLogger, {
      disjointViolations: [],
      missingInRegistry: [],
      unknownTools: [],
    })
    expect(warn).not.toHaveBeenCalled()
    expect(debug).not.toHaveBeenCalled()
  })
})
