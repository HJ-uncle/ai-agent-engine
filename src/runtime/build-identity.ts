import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'

export interface BuildManifest {
  version: string
  buildId: string
  protocolVersion: 1
  toolProfiles: ['general', 'code']
  subagentSchemaVersion: 1
  dependencyPatchSchemaVersion?: 1
  dependencyPatchDigest?: string
}

const BUILD_INPUTS = ['package.json', 'package-lock.json', 'tsconfig.json', 'scripts/build.ts', 'scripts/apply-node-pty-patch.mjs']

/** Hash actual build inputs, including uncommitted edits, rather than identifying every dirty build by HEAD. */
export function createBuildManifest(root: string): BuildManifest {
  const files: string[] = []
  function walk(relative: string): void {
    for (const entry of readdirSync(path.join(root, relative), { withFileTypes: true })) {
      const name = `${relative}/${entry.name}`
      if (entry.isDirectory()) walk(name)
      else if (entry.isFile()) files.push(name)
    }
  }
  walk('src')
  if (existsSync(path.join(root, 'scripts/patches'))) walk('scripts/patches')
  for (const name of BUILD_INPUTS) if (existsSync(path.join(root, name))) files.push(name)
  const hash = createHash('sha256')
  for (const name of files.sort()) {
    const bytes = readFileSync(path.join(root, name))
    hash.update(`${name}\0${bytes.length}\0`)
    hash.update(bytes)
  }
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as { version?: unknown }
  if (typeof pkg.version !== 'string' || !pkg.version) throw new Error('Engine package version is missing')
  return {
    version: pkg.version,
    buildId: `sha256:${hash.digest('hex')}`,
    protocolVersion: 1,
    toolProfiles: ['general', 'code'],
    subagentSchemaVersion: 1,
    ...(existsSync(path.join(root, 'scripts/patches/node-pty-1.1.0/manifest.json')) ? {
      dependencyPatchSchemaVersion: 1 as const,
      dependencyPatchDigest: createHash('sha256').update(readFileSync(path.join(root, 'scripts/patches/node-pty-1.1.0/manifest.json'))).digest('hex'),
    } : {}),
  }
}

/** The deployed manifest travels beside the runtime module, so neither cwd nor a sibling checkout affects identity. */
export function readBuildManifest(runtimeDirectory: string): BuildManifest {
  const manifestPath = path.join(runtimeDirectory, 'build-manifest.json')
  if (!existsSync(manifestPath)) {
    // tsx development has no dist manifest. Only a real source checkout may use this fallback.
    const root = path.resolve(runtimeDirectory, '../..')
    if (path.basename(path.dirname(runtimeDirectory)) === 'src' && existsSync(path.join(root, 'src'))) {
      return createBuildManifest(root)
    }
    throw new Error('Engine build manifest is missing; rebuild the engine')
  }
  const value: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (!value || typeof value !== 'object') throw new Error('Invalid engine build manifest')
  const manifest = value as Partial<BuildManifest>
  if (typeof manifest.version !== 'string' || !manifest.version ||
      typeof manifest.buildId !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(manifest.buildId) ||
      manifest.protocolVersion !== 1 || manifest.subagentSchemaVersion !== 1 ||
      !Array.isArray(manifest.toolProfiles) || manifest.toolProfiles.length !== 2 ||
      manifest.toolProfiles[0] !== 'general' || manifest.toolProfiles[1] !== 'code') {
    throw new Error('Invalid engine build manifest')
  }
  if (manifest.dependencyPatchSchemaVersion !== undefined && (manifest.dependencyPatchSchemaVersion !== 1 ||
      !/^[a-f0-9]{64}$/.test(manifest.dependencyPatchDigest ?? ''))) throw new Error('Invalid engine dependency patch manifest')
  // Publish only the documented fields, never accidental build metadata or local paths.
  return { version: manifest.version, buildId: manifest.buildId, protocolVersion: 1,
    toolProfiles: ['general', 'code'], subagentSchemaVersion: 1,
    ...(manifest.dependencyPatchSchemaVersion === 1 ? { dependencyPatchSchemaVersion: 1 as const, dependencyPatchDigest: manifest.dependencyPatchDigest } : {}) }
}
