import { createHash } from 'node:crypto'
import { readFileSync, lstatSync, realpathSync, existsSync } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { readBuildManifest } from './build-identity.js'

/** Read-only production verification; a launched engine never mutates dependencies. */
export function verifyTerminalDependencyPatch(): void {
  if (process.platform !== 'win32') return
  const runtimeDirectory = path.dirname(fileURLToPath(import.meta.url))
  const build = readBuildManifest(runtimeDirectory)
  if (build.dependencyPatchSchemaVersion !== 1) throw new Error('NODE_PTY_PATCH_REQUIRED: rebuild the Windows engine')
  const packageDir = path.dirname(createRequire(import.meta.url).resolve('node-pty/package.json'))
  const receiptFile = path.join(packageDir, '.aether-node-pty-patch.json')
  const json = (filename: string) => JSON.parse(readFileSync(filename, 'utf8'))
  const digest = (filename: string) => createHash('sha256').update(readFileSync(filename)).digest('hex')
  const receipt = json(receiptFile) as { schemaVersion?: number; patchId?: string; manifestSha256?: string; packageSha256?: string; files?: Array<{ path: string; afterSha256: string }> }
  if (receipt.schemaVersion !== 1 || receipt.patchId !== 'aether-system-conpty-close-v1' ||
      receipt.manifestSha256 !== build.dependencyPatchDigest || !Array.isArray(receipt.files) || receipt.files.length !== 5 ||
      digest(path.join(packageDir, 'package.json')) !== receipt.packageSha256) throw new Error('NODE_PTY_PATCH_INVALID: dependency receipt differs from engine build')
  const bundled = path.join(runtimeDirectory, 'dependency-patches.json')
  if (path.basename(path.dirname(runtimeDirectory)) === 'dist' && (!existsSync(bundled) || JSON.stringify(json(bundled)) !== JSON.stringify(receipt))) {
    throw new Error('NODE_PTY_PATCH_INVALID: runtime receipt is missing or differs from installed dependency')
  }
  for (const file of receipt.files) {
    const filename = path.resolve(packageDir, file.path)
    const relative = path.relative(packageDir, filename)
    if (relative.startsWith('..') || path.isAbsolute(relative) || lstatSync(filename).isSymbolicLink() ||
        realpathSync(filename).toLowerCase() !== filename.toLowerCase() || digest(filename) !== file.afterSha256) {
      throw new Error(`NODE_PTY_PATCH_INVALID: altered dependency file ${file.path}`)
    }
  }
}
