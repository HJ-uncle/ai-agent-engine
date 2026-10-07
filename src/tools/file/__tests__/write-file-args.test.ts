import { describe, expect, it } from 'vitest'
import { normalizeWriteFileArgs } from '../../../shared/write-file-args.js'

describe('normalizeWriteFileArgs', () => {
  it('accepts the canonical data payload', () => {
    expect(normalizeWriteFileArgs({ path: 'src/App.tsx', data: 'export {}' })).toEqual({
      ok: true,
      args: { path: 'src/App.tsx', data: 'export {}', usedContentAlias: false },
    })
  })

  it('maps the legacy content payload without exposing undefined', () => {
    expect(normalizeWriteFileArgs({ path: 'src/App.tsx', content: 'export {}' })).toEqual({
      ok: true,
      args: { path: 'src/App.tsx', data: 'export {}', usedContentAlias: true },
    })
  })

  it('rejects missing or undefined payloads before any handler can write', () => {
    for (const args of [{ path: 'src/App.tsx' }, { path: 'src/App.tsx', data: undefined }, { path: 'src/App.tsx', content: undefined }]) {
      expect(normalizeWriteFileArgs(args)).toMatchObject({ ok: false, error: { code: 'WRITE_INVALID_ARGUMENTS' } })
    }
  })

  it('keeps an explicit null payload valid because null is part of the tool schema', () => {
    expect(normalizeWriteFileArgs({ path: 'value.txt', data: null })).toMatchObject({ ok: true, args: { data: null } })
  })

  it.each(['', false, 0])('preserves the canonical falsy value %j instead of replacing it with legacy content', data => {
    expect(normalizeWriteFileArgs({ path: 'value.txt', data, content: 'legacy' })).toMatchObject({
      ok: true, args: { data, usedContentAlias: false },
    })
  })

  it.each([null, [], 'text', { path: ' ' }, { path: 123, data: 'text' }])('rejects malformed arguments %j', args => {
    expect(normalizeWriteFileArgs(args)).toMatchObject({ ok: false, error: { code: 'WRITE_INVALID_ARGUMENTS' } })
  })
})
