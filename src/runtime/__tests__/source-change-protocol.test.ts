import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { captureBuildSource, captureSourceFiles, resolveSourceChangeChoice, sourceChangePendingAction, verifySourceSnapshot } from '../source-change-protocol.js'

const roots: string[] = []
function fixture(): string {
  const root = path.resolve('.e2e-tmp/build-conflict-engine-tests', `case-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  fs.mkdirSync(root, { recursive: true }); roots.push(root); return root
}
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })

describe('source change protocol', () => {
  it('captures file versions, reports external edits and freezes a safe pending action', () => {
    const root = fixture(), file = path.join(root, 'source.ts')
    fs.writeFileSync(file, 'before')
    const snapshot = captureSourceFiles([file], root)
    fs.writeFileSync(file, 'external')
    const check = verifySourceSnapshot(snapshot)
    expect(check.changed).toBe(true)
    expect(check.changes[0]).toMatchObject({ path: file, kind: 'modified', before: { hash: expect.stringMatching(/^sha256:/) }, after: { hash: expect.stringMatching(/^sha256:/) } })
    const pending = sourceChangePendingAction(check, { phase: 'write', operation: 'write_file' })
    expect(pending).toMatchObject({ type: 'source_change', phase: 'write', operation: 'write_file', defaultChoice: 'pause', risk: 'external-source-change' })
    expect(pending.changes[0]).not.toHaveProperty('content')
    expect(resolveSourceChangeChoice(pending, 'rebuild')).toBeUndefined()
    expect(resolveSourceChangeChoice(pending, 'skip')).toBe('skip')
    expect(resolveSourceChangeChoice(pending, 'approved')).toBeUndefined()
  })

  it('uses the build manifest identity and detects source changes without accepting a sibling checkout', () => {
    const root = fixture()
    fs.mkdirSync(path.join(root, 'src'), { recursive: true })
    fs.mkdirSync(path.join(root, 'scripts'), { recursive: true })
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '1.0.0' }))
    fs.writeFileSync(path.join(root, 'src', 'main.ts'), 'one')
    const snapshot = captureBuildSource(root)
    fs.writeFileSync(path.join(root, 'src', 'main.ts'), 'two')
    const check = verifySourceSnapshot(snapshot)
    expect(check.changed).toBe(true)
    expect(check.before.kind).toBe('build')
    expect(check.after.kind).toBe('build')
    expect((check.before as { buildId: string }).buildId).not.toBe((check.after as { buildId: string }).buildId)
  })
})
