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
})
