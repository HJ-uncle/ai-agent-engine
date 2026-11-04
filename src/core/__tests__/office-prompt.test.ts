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
})
