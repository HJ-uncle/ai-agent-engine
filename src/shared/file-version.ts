import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

/** Absence is a version of its own, distinct from an existing empty file. */
export function hashFileContent(content: Buffer | string | null): string {
  return content === null ? 'missing' : `sha256:${createHash('sha256').update(content).digest('hex')}`
}

export function canonicalFilePathSync(filePath: string): string {
  const absolute = path.resolve(filePath)
  let cursor = absolute
  const suffix: string[] = []
  for (;;) {
    try {
      // Preserve the filesystem's spelling for I/O and user-visible change
      // records.  Windows paths are case-insensitive, but lower-casing this
      // value changes the name of a newly-created file (for example
      // `App.tsx` became `app.tsx`).  Case folding belongs only to the lock
      // identity below.
      return path.join(fs.realpathSync.native(cursor), ...suffix)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      // realpath also returns ENOENT for dangling symlinks. Treating such a link
      // as a missing regular file would lock the link name but write its target.
      try {
        if (fs.lstatSync(cursor).isSymbolicLink()) throw new Error('Cannot lock a dangling symbolic link')
      } catch (linkError) {
        if ((linkError as NodeJS.ErrnoException).code !== 'ENOENT') throw linkError
      }
      const parent = path.dirname(cursor)
      if (parent === cursor) throw error
      suffix.unshift(path.basename(cursor))
      cursor = parent
    }
  }
}

export async function canonicalFilePath(filePath: string): Promise<string> {
  return canonicalFilePathSync(filePath)
}

export interface FileVersion { content: Buffer | null; hash: string }

export function readFileVersionSync(filePath: string): FileVersion {
  try {
    const stat = fs.statSync(filePath)
    if (!stat.isFile()) throw new Error('Path is not a regular file')
    const content = fs.readFileSync(filePath)
    return { content, hash: hashFileContent(content) }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { content: null, hash: hashFileContent(null) }
    throw error
  }
}

export async function readFileVersion(filePath: string): Promise<FileVersion> {
  return readFileVersionSync(filePath)
}

const lockTails = new Map<string, Promise<void>>()

async function acquire(key: string): Promise<() => void> {
  const previous = lockTails.get(key) ?? Promise.resolve()
  let release!: () => void
  const held = new Promise<void>(done => { release = done })
  const tail = previous.then(() => held)
  lockTails.set(key, tail)
  await previous
  return () => {
    release()
    if (lockTails.get(key) === tail) lockTails.delete(key)
  }
}

/** All writers and reverts share a process-local lock order, including path aliases. */
export async function withFileLocks<T>(
  paths: readonly string[],
  action: (canonicalPaths: readonly string[]) => Promise<T>
): Promise<T> {
  const canonicalPaths = paths.map(canonicalFilePathSync)
  // Lock identity is case-insensitive on Windows; the paths passed to the
  // callback retain their real spelling so writes and change records do too.
  const keyFor = (value: string): string => process.platform === 'win32' ? value.toLowerCase() : value
  const keys = [...new Set(canonicalPaths.map(keyFor))].sort()
  const releases: Array<() => void> = []
  try {
    for (const key of keys) releases.push(await acquire(key))
    if (paths.some((filePath, index) => keyFor(canonicalFilePathSync(filePath)) !== keyFor(canonicalPaths[index]))) {
      throw new Error('File path target changed while waiting for its lock')
    }
    return await action(canonicalPaths)
  } finally {
    for (const release of releases.reverse()) release()
  }
}
