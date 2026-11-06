import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import path from 'node:path'

export interface StatusStatFile {
  path: string
  changeType: string
  binary: boolean
  additions: number
  deletions: number
  stagedAdditions?: number
  stagedDeletions?: number
  unstagedAdditions?: number
  unstagedDeletions?: number
}

const MAX_UNTRACKED_BYTES = 2 * 1024 * 1024
const MAX_CACHED_FILES = 512
const untrackedCache = new Map<string, { signature: string; additions: number; binary: boolean }>()

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep))
}

/** NUL records preserve tabs/newlines and carry both names for renames. */
export function applyStatusNumstat(raw: string, files: StatusStatFile[], side: 'staged' | 'unstaged'): void {
  const byPath = new Map(files.map(file => [file.path, file]))
  const records = raw.split('\0')
  for (let index = 0; index < records.length; index++) {
    const record = records[index]
    if (!record) continue
    const first = record.indexOf('\t'), second = record.indexOf('\t', first + 1)
    if (first < 0 || second < 0) continue
    const add = record.slice(0, first), del = record.slice(first + 1, second)
    let filePath = record.slice(second + 1)
    if (!filePath) { index++; filePath = records[++index] ?? '' }
    const file = byPath.get(filePath)
    if (!file) continue
    if (add === '-' || del === '-') { file.binary = true; continue }
    if (!/^\d+$/.test(add) || !/^\d+$/.test(del)) continue
    if (side === 'staged') { file.stagedAdditions = Number(add); file.stagedDeletions = Number(del) }
    else { file.unstagedAdditions = Number(add); file.unstagedDeletions = Number(del) }
  }
}

/** Read only physical files under this root. Counting never follows a link to
 * another directory, and descriptor identity is checked before reading bytes. */
async function untrackedStats(root: string, relativePath: string): Promise<{ additions: number; binary: boolean } | undefined> {
  const fullPath = path.resolve(root, relativePath)
  if (!inside(root, fullPath) || fullPath === root) return undefined
  let component = root
  const parts = path.relative(root, fullPath).split(path.sep)
  for (const part of parts) {
    component = path.join(component, part)
    const entry = await lstat(component)
    if (entry.isSymbolicLink()) return undefined
  }
  const info = await lstat(fullPath)
  if (!info.isFile() || info.size > MAX_UNTRACKED_BYTES) return undefined
  const canonical = await realpath(fullPath)
  if (!inside(root, canonical)) return undefined
  const signature = [info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs].join(':')
  const cached = untrackedCache.get(fullPath)
  if (cached?.signature === signature) return cached
  const handle = await open(canonical, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const opened = await handle.stat()
    if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino || opened.size !== info.size
      || opened.mtimeMs !== info.mtimeMs || opened.ctimeMs !== info.ctimeMs || !inside(root, await realpath(fullPath))) return undefined
    // A bounded read also handles a file growing after stat without unbounded allocation.
    const buffer = Buffer.alloc(info.size + 1)
    let bytes = 0
    while (bytes < buffer.length) {
      const chunk = await handle.read(buffer, bytes, buffer.length - bytes, bytes)
      if (!chunk.bytesRead) break
      bytes += chunk.bytesRead
    }
    const after = await handle.stat()
    if (bytes !== info.size || after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs) return undefined
    const content = buffer.subarray(0, bytes)
    const binary = content.includes(0)
    let additions = 0
    if (!binary && bytes) {
      for (const byte of content) if (byte === 10) additions++
      if (content[bytes - 1] !== 10) additions++
    }
    const result = { signature, additions, binary }
    untrackedCache.delete(fullPath)
    untrackedCache.set(fullPath, result)
    if (untrackedCache.size > MAX_CACHED_FILES) untrackedCache.delete(untrackedCache.keys().next().value!)
    return result
  } finally { await handle.close() }
}

export async function fillUntrackedStats(cwd: string, files: StatusStatFile[]): Promise<void> {
  const root = await realpath(cwd)
  for (const file of files) {
    if (file.changeType !== 'untracked') continue
    try {
      const stats = await untrackedStats(root, file.path)
      if (!stats) continue
      file.binary = stats.binary
      file.unstagedAdditions = stats.additions
      file.unstagedDeletions = 0
      file.additions = stats.additions
      file.deletions = 0
    } catch {
      // Disappearing/unreadable files retain their status; no guessed line count.
    }
  }
}

/** Two repository-wide Git reads; untracked files are absent from both diffs. */
export async function fillStatusStats(cwd: string, files: StatusStatFile[], run: (args: string[]) => Promise<string>): Promise<void> {
  for (const side of ['unstaged', 'staged'] as const) {
    const args = ['diff', '--numstat', '-z', '--relative', '--no-ext-diff', '--no-textconv', ...(side === 'staged' ? ['--cached'] : []), '--']
    applyStatusNumstat(await run(args), files, side)
  }
  for (const file of files) {
    file.additions = (file.stagedAdditions ?? 0) + (file.unstagedAdditions ?? 0)
    file.deletions = (file.stagedDeletions ?? 0) + (file.unstagedDeletions ?? 0)
  }
  await fillUntrackedStats(cwd, files)
}

