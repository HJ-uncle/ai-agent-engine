import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  getSuperpowerBootstrapBlock,
  prependBootstrapToSystemPrompt,
  SUPERPOWER_BOOTSTRAP_SKILL_NAME,
  __resetBootstrapWarnFlagForTests,
} from '../superpower-bootstrap.js'
import { __resetSuperpowerWarnFlagsForTests } from '../superpower.js'
import { skillsRegistry } from '../../skills/index.js'

/**
 * Bootstrap 注入单元测试
 *
 * 关注点：
 *   1. mode ∈ {off, balanced}      → 空块，无注入
 *   2. mode ∈ {methodology, max}   → 返回带 <SUPERPOWER-ACTIVE> 哨兵的全文
 *   3. 缺失 bootstrap skill        → 返回空块，只打一次 warn
 *   4. 分隔符只在非空时插入
 *   5. skillsRegistry 更新后下次调用能取到新内容（热重载）
 *
 * 实现策略：通过 vi.spyOn(skillsRegistry, 'getSkills') 模拟技能列表，
 *   避免依赖实际文件系统 & SKILLS_ROOT。
 */

function setEnv(mode: string | undefined) {
  if (mode === undefined) delete process.env.SUPERPOWER_MODE
  else process.env.SUPERPOWER_MODE = mode
  delete process.env.SUPERPOWER_ENABLED
}

const FAKE_SKILL_CONTENT = '# Using Superpowers\n\n<EXTREMELY-IMPORTANT>iron laws here</EXTREMELY-IMPORTANT>'

function mockBootstrapSkill(content: string | null) {
  vi.spyOn(skillsRegistry, 'getSkills').mockReturnValue(
    content === null
      ? []
      : [{
          name: SUPERPOWER_BOOTSTRAP_SKILL_NAME,
          description: 'test',
          skillMdPath: '',
          order: 1,
          enabled: true,
          inlineContent: content,
        }],
  )
}

beforeEach(() => {
  __resetBootstrapWarnFlagForTests()
  __resetSuperpowerWarnFlagsForTests()
  vi.restoreAllMocks()
})

describe('superpower-bootstrap / getSuperpowerBootstrapBlock', () => {
  it('off 模式 → 空字符串', () => {
    setEnv('off')
    mockBootstrapSkill(FAKE_SKILL_CONTENT)
    expect(getSuperpowerBootstrapBlock()).toBe('')
  })

  it('balanced 模式 → 空字符串', () => {
    setEnv('balanced')
    mockBootstrapSkill(FAKE_SKILL_CONTENT)
    expect(getSuperpowerBootstrapBlock()).toBe('')
  })

  it('methodology 模式 → 带哨兵的技能全文', () => {
    setEnv('methodology')
    mockBootstrapSkill(FAKE_SKILL_CONTENT)
    const block = getSuperpowerBootstrapBlock()
    expect(block).toContain('<SUPERPOWER-ACTIVE>')
    expect(block).toContain('</SUPERPOWER-ACTIVE>')
    expect(block).toContain('Using Superpowers')
    expect(block).toContain('iron laws here')
  })

  it('max 模式 → 带哨兵的技能全文（与 methodology 同格式）', () => {
    setEnv('max')
    mockBootstrapSkill(FAKE_SKILL_CONTENT)
    const block = getSuperpowerBootstrapBlock()
    expect(block).toContain('<SUPERPOWER-ACTIVE>')
    expect(block).toContain('Using Superpowers')
  })

  it('bootstrap skill 缺失时返回空 + 首次打 warn', () => {
    const warn = vi.fn()
    const log = { warn, debug: vi.fn() } as any
    setEnv('methodology')
    mockBootstrapSkill(null)
    const block = getSuperpowerBootstrapBlock(log)
    expect(block).toBe('')
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('bootstrap 缺失的 warn 只打一次（5 次调用总共 1 条）', () => {
    const warn = vi.fn()
    const log = { warn, debug: vi.fn() } as any
    setEnv('methodology')
    mockBootstrapSkill(null)
    for (let i = 0; i < 5; i++) getSuperpowerBootstrapBlock(log)
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('skillsRegistry 热更新 → 下次调用取到新内容', () => {
    setEnv('methodology')
    mockBootstrapSkill('v1 content')
    const b1 = getSuperpowerBootstrapBlock()
    expect(b1).toContain('v1 content')

    vi.restoreAllMocks()
    mockBootstrapSkill('v2 content')
    const b2 = getSuperpowerBootstrapBlock()
    expect(b2).toContain('v2 content')
    expect(b2).not.toContain('v1 content')
  })
})

describe('superpower-bootstrap / prependBootstrapToSystemPrompt', () => {
  it('bootstrap 为空时 → 返回 base 原样（无多余分隔符）', () => {
    setEnv('off')
    mockBootstrapSkill(FAKE_SKILL_CONTENT)
    const base = 'You are a helpful assistant.'
    expect(prependBootstrapToSystemPrompt(base)).toBe(base)
  })

  it('bootstrap 非空 → 格式为 bootstrap + \\n\\n---\\n\\n + base', () => {
    setEnv('methodology')
    mockBootstrapSkill(FAKE_SKILL_CONTENT)
    const base = 'You are a helpful assistant.'
    const out = prependBootstrapToSystemPrompt(base)
    expect(out.startsWith('<SUPERPOWER-ACTIVE>')).toBe(true)
    expect(out.endsWith(base)).toBe(true)
    expect(out).toContain('\n\n---\n\n')
    // base 在分隔符之后出现
    const idx = out.indexOf('\n\n---\n\n')
    expect(idx).toBeGreaterThan(0)
    expect(out.slice(idx + 7)).toBe(base)
  })

  it('空 base + 非空 bootstrap → 仍然注入（不做空串优化）', () => {
    setEnv('max')
    mockBootstrapSkill(FAKE_SKILL_CONTENT)
    const out = prependBootstrapToSystemPrompt('')
    expect(out).toContain('<SUPERPOWER-ACTIVE>')
    expect(out.endsWith('\n\n---\n\n')).toBe(true)
  })
})
