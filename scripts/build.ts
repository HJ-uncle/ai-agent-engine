import { spawnSync } from 'node:child_process'
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createBuildManifest } from '../src/runtime/build-identity.js'

const root = fileURLToPath(new URL('../', import.meta.url))
const before = createBuildManifest(root)
const directory = path.join(root, 'dist/runtime')
// A failed or interrupted build must not leave an old manifest certifying partially replaced output.
rmSync(path.join(directory, 'build-manifest.json'), { force: true })
const result = spawnSync(process.execPath, [path.join(root, 'node_modules/typescript/bin/tsc'), '--noEmitOnError'], {
  cwd: root, stdio: 'inherit', windowsHide: true,
})
if (result.error) throw result.error
if (result.status !== 0) process.exit(result.status ?? 1)
const after = createBuildManifest(root)
if (after.buildId !== before.buildId) throw new Error('Engine sources changed during compilation; rebuild before using this artifact')
mkdirSync(directory, { recursive: true })
const temporary = path.join(directory, `build-manifest.${process.pid}.tmp`)
writeFileSync(temporary, JSON.stringify(after, null, 2) + '\n', 'utf8')
renameSync(temporary, path.join(directory, 'build-manifest.json'))
console.log(`Engine build: ${after.version} ${after.buildId}`)
