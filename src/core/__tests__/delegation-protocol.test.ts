import { describe, expect, it } from 'vitest'
import { buildExecutionProtocol } from '../execution-protocol.js'

const registry = (...names: string[]) => ({ list: () => names.map(name => ({
  name, description: name, parameters: { type: 'object' as const, properties: {} },
})) })

describe('early delegation guidance respects the executable scope', () => {
  it.each(['general', 'code'] as const)('makes a broad %s investigation decide ownership before detailed exploration', profile => {
    const prompt = buildExecutionProtocol(registry('read_file', 'load_tools', 'subagent_start', 'subagent_directory'), profile)
    const decision = prompt.indexOf('Delegate useful independent work early')
    expect(decision).toBeGreaterThan(0)
    expect(decision).toBeLessThan(prompt.indexOf('Before project operations'))
    expect(prompt).toContain('even one final report')
    expect(prompt).toContain('read shared rules/entry points then assign independent modules or analysis axes')
    expect(prompt).toContain('no user @/selection is needed')
    expect(prompt).toContain('Respect no-delegation/solo requests')
    expect(prompt).toContain('single-chain dependencies and one-batch work directly')
    expect(prompt).toContain('包括已完成实例')
    expect(prompt).toContain('空目录可新建内置角色')
    expect(prompt).toContain('不重做已验证工作')
  })

  it('does not tell a child with directory and messaging access to create or revive children', () => {
    const prompt = buildExecutionProtocol(registry('read_file', 'load_tools', 'subagent_directory', 'subagent_send', 'subagent_request_input'))
    expect(prompt).not.toContain('Delegate useful')
    expect(prompt).not.toContain('委派先查subagent_directory')
    expect(prompt).not.toContain('新建内置角色')
    expect(prompt).not.toContain('subagent_start')
    expect(prompt).not.toContain('subagent_followup')
    expect(prompt).toContain('同伴先查participants')
  })

  it('keeps followup-only scopes usable without suggesting new workers', () => {
    const prompt = buildExecutionProtocol(registry('subagent_directory', 'subagent_followup'))
    expect(prompt).not.toContain('Delegate useful')
    expect(prompt).not.toContain('新建内置角色')
    expect(prompt).toContain('运行中补充及完成后继续用subagent_followup')
  })

  it('supports synchronous delegation without advertising an unavailable directory', () => {
    const prompt = buildExecutionProtocol(registry('subagent'))
    expect(prompt).toContain('Delegate useful independent work early')
    expect(prompt).not.toContain('subagent_directory')
    expect(prompt).not.toContain('subagent_start')
    expect(prompt).toContain('research只读不产文件')
  })

  it('offers no delegation instructions to a tool-free finalization request', () => {
    const prompt = buildExecutionProtocol(registry())
    expect(prompt).not.toContain('Delegate useful')
    expect(prompt).not.toMatch(/subagent|新建内置角色/)
    expect(prompt).toContain('read-only/plan-only')
    expect(prompt).toContain('For ordinary chat')
  })
})
