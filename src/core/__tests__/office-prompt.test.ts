import { describe, expect, it } from 'vitest'
import { buildOfficeExecutionPrompt } from '../office-prompt.js'

describe('office prompt capability evidence', () => {
  const registry = (...names: string[]) => ({ has: (name: string) => names.includes(name) })
  it('mentions environment diagnostics only when actually admitted with Work office capabilities', () => {
    expect(buildOfficeExecutionPrompt('general', registry('office_document', 'office_environment'), [])).toContain('office_environment({})')
    expect(buildOfficeExecutionPrompt('general', registry('office_document'), [])).not.toContain('office_environment')
    expect(buildOfficeExecutionPrompt('general', registry('office_environment'), [])).toBe('')
    expect(buildOfficeExecutionPrompt('code', registry('office_document', 'office_environment'), [])).toBe('')
  })
  it.each(['general', 'code'])('guides %s readonly handoff inspection without advertising unavailable mutation APIs', profile => {
    const prompt = buildOfficeExecutionPrompt(profile, registry('office_inspect'), [])
    expect(prompt).toContain('office_inspect({path})')
    expect(prompt).toContain('target=notes')
    expect(prompt).toContain('contentPage.hasMore/nextOffset')
    expect(prompt).toContain('expectedHash')
    expect(prompt).not.toContain('office_document')
    expect(prompt).not.toContain('office_environment')
    expect(prompt).not.toContain('get_skill')
    expect(buildOfficeExecutionPrompt(profile, registry('read_file'), [])).toBe('')
  })
  it('requires an internal draft only when file writing is available and closes delivery only when admitted', () => {
    const prompt = buildOfficeExecutionPrompt('general', registry('office_document', 'write_file', 'deliver_files'), [])
    expect(prompt).toContain('draft.md')
    expect(prompt).toContain('草稿→生成→必要校验/修正→登记交付→收敛计划→最终答复')
    expect(prompt).toContain('不重复列同文件下载链接')
    expect(prompt).toContain('已有共享草稿就直接复用')
    expect(prompt).toContain('同版本可信校验回执就复用')
    expect(prompt).toContain('修订Excel后按最新hash重算')
    const limited = buildOfficeExecutionPrompt('general', registry('office_document'), [])
    expect(limited).not.toContain('draft.md')
    expect(limited).not.toContain('deliver_files')
    expect(limited).toContain('已有共享草稿就直接复用')
  })
})
