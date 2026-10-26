import { describe, expect, it } from 'vitest'
import { repairJson } from '../json.js'

describe('repairJson', () => {
  it('escapes invalid Windows path escapes inside tool arguments', () => {
    const repaired = repairJson(String.raw`{"path":"D:\dev\aether-code\.ae\company\report.xlsx"}`)
    expect(JSON.parse(repaired)).toEqual({ path: 'D:\\dev\\aether-code\\.ae\\company\\report.xlsx' })
  })

  it('preserves valid JSON escapes and unicode escapes', () => {
    const repaired = repairJson('{"text":"line\\nquote\\\"\\u4e2d"}')
    expect(JSON.parse(repaired)).toEqual({ text: 'line\nquote"中' })
  })

  it('does not alter already valid JSON', () => {
    const source = '{"path":"D:\\\\dev\\\\aether-code","operation":"read_file"}'
    expect(repairJson(source)).toBe(source)
  })
})
