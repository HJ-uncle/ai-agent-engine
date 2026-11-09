import fs from 'node:fs'
import path from 'node:path'
import { canonicalFilePathSync } from '../../shared/file-version.js'

export interface CreatedDirectory { path: string; dev: number; ino: number; birthtimeMs: number }
const identity = (value: string) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value)

/** Capture absence before the writer creates parent directories. Existing empty
 * folders belong to the workspace, not to this file mutation. */
export function missingParentDirectories(file: string): string[] {
  const missing: string[] = []
  let cursor = path.dirname(canonicalFilePathSync(file))
  while (path.dirname(cursor) !== cursor) {
    try { fs.lstatSync(cursor); break } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      missing.push(cursor)
      cursor = path.dirname(cursor)
    }
  }
  return missing
}

export function captureCreatedDirectories(file: string, candidates: readonly string[]): CreatedDirectory[] {
  file = canonicalFilePathSync(file)
  return candidates.flatMap(directory => {
    const relative = path.relative(directory, file)
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return []
    try {
      const stat = fs.lstatSync(directory)
      if (!stat.isDirectory() || stat.isSymbolicLink() || identity(canonicalFilePathSync(directory)) !== identity(directory)) return []
      return [{ path: directory, dev: stat.dev, ino: stat.ino, birthtimeMs: stat.birthtimeMs }]
    } catch { return [] }
  })
}

/** Never recurse: a concurrent/user-created child keeps the directory intact.
 * Identity checks also keep replaced directories and junctions untouched. */
export function removeCreatedEmptyDirectories(entries: readonly CreatedDirectory[]): string[] {
  const unique = new Map(entries.map(entry => [identity(entry.path), entry]))
  const removed: string[] = []
  for (const entry of [...unique.values()].sort((a, b) => b.path.length - a.path.length)) {
    try {
      const stat = fs.lstatSync(entry.path)
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== entry.dev || stat.ino !== entry.ino ||
        stat.birthtimeMs !== entry.birthtimeMs || identity(canonicalFilePathSync(entry.path)) !== identity(entry.path)) continue
      fs.rmdirSync(entry.path)
      removed.push(entry.path)
    } catch (error) {
      if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
    }
  }
  return removed
}
