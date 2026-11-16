/** Compatibility entry for maintainers. The canonical reference is now the frontend HTML project. */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const engine = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const frontend = path.resolve(process.argv[2] ?? path.join(engine, '../aether-code'))
const checker = path.join(frontend, 'docs/plugin-api/scripts/check.mjs')
if (!fs.existsSync(checker)) throw new Error('HTML reference project is missing from the paired frontend repository')
const result = spawnSync(process.execPath, [checker], {
  cwd: frontend, stdio: 'inherit', windowsHide: true,
  env: { ...process.env, AETHER_ENGINE_SOURCE_DIR: engine },
})
if (result.error) throw result.error
process.exitCode = result.status ?? 1
