import { describe, expect, it } from 'vitest'
import { buildOfficeExecutionPrompt } from '../office-prompt.js'

describe('PPT visual review capability routing', () => {
  const registry = (...names: string[]) => ({ has: (name: string) => names.includes(name) })

  it('requires actual per-page rendering with a consistent file version when available', () => {
    const prompt = buildOfficeExecutionPrompt('general', registry('office_document', 'workbench_render'), [])
    expect(prompt).toContain('workbench_render')
    expect(prompt).toContain('pageCount')
    expect(prompt).toContain('同一expectedHash')
    expect(prompt).toContain('截图成功不等于验收通过')
    expect(prompt).toContain('非视觉模型、客户端未连接或渲染失败')
    expect(prompt).not.toContain('当前未提供幻灯片画面工具')
  })

  it('reports incomplete visual review without advertising an unavailable renderer', () => {
    const prompt = buildOfficeExecutionPrompt('general', registry('office_document'), [])
    expect(prompt).not.toContain('workbench_render')
    expect(prompt).toContain('视觉验收需明确标记未完成')
    expect(prompt).toContain('内容或结构通过不能代替逐页实际检查')
  })

  it.each(['general', 'code'])('keeps %s read-only Office routing free of generation instructions', profile => {
    const prompt = buildOfficeExecutionPrompt(profile, registry('office_inspect', 'workbench_render'), [])
    expect(prompt).toContain('office_inspect({path})')
    expect(prompt).not.toContain('Office delivery')
    expect(prompt).not.toContain('office_document')
    expect(prompt).not.toContain('workbench_render')
  })
})
