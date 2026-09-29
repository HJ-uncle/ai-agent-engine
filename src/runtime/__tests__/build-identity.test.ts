import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createBuildManifest, readBuildManifest } from '../build-identity.js'

const fixtures: string[] = []
function fixture(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'aether-build-identity-'))
  fixtures.push(root)
  mkdirSync(path.join(root, 'src/runtime'), { recursive: true })
  mkdirSync(path.join(root, 'scripts'))
  writeFileSync(path.join(root, 'src/runtime/example.ts'), 'export const value = 1\n')
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '9.8.7' }))
  writeFileSync(path.join(root, 'tsconfig.json'), '{}')
  writeFileSync(path.join(root, 'scripts/build.ts'), 'build()')
  return root
}
afterEach(() => {
  for (const root of fixtures.splice(0)) {
    if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('aether-build-identity-')) throw new Error('Unsafe fixture path')
    rmSync(root, { recursive: true, force: true })
  }
})

describe('portable engine build identity', () => {
  it('identifies source bytes including dirty edits, but not unrelated data or cwd', () => {
    const root = fixture()
    const before = createBuildManifest(root)
    writeFileSync(path.join(root, 'unrelated-user-data.json'), 'private runtime data')
    expect(createBuildManifest(root)).toEqual(before)
    writeFileSync(path.join(root, 'src/runtime/example.ts'), 'export const value = 2\n')
    expect(createBuildManifest(root).buildId).not.toBe(before.buildId)
    expect(before).toMatchObject({ version: '9.8.7', protocolVersion: 1, toolProfiles: ['general', 'code'], subagentSchemaVersion: 1 })
    expect(before.buildId).toMatch(/^sha256:[a-f0-9]{64}$/)
  })

  it('ships a self-contained manifest with dist and does not inspect a surrounding package', () => {
    const root = fixture()
    const manifest = createBuildManifest(root)
    const deployed = path.join(root, 'standalone-dist/runtime')
    mkdirSync(deployed, { recursive: true })
    writeFileSync(path.join(deployed, 'build-manifest.json'), JSON.stringify({ ...manifest, accidentalSecret: 'must not appear' }))
    writeFileSync(path.join(root, 'package.json'), '{"version":"wrong-neighbour"}')
    expect(readBuildManifest(deployed)).toEqual(manifest)
    expect(JSON.stringify(readBuildManifest(deployed))).not.toContain('must not appear')
  })

  it('requires an explicit manifest for compiled output and rejects malformed versions', () => {
    const root = fixture()
    const deployed = path.join(root, 'dist/runtime')
    mkdirSync(deployed, { recursive: true })
    expect(() => readBuildManifest(deployed)).toThrow('manifest is missing')
    writeFileSync(path.join(deployed, 'build-manifest.json'), '{"version":"9.8.7","buildId":"unknown"}')
    expect(() => readBuildManifest(deployed)).toThrow('Invalid engine build manifest')
    // Source execution still works without an installed build and uses the same content fingerprint.
    expect(readBuildManifest(path.join(root, 'src/runtime'))).toEqual(createBuildManifest(root))
  })
})
