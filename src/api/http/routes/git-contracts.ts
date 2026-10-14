import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { resolveGitPath, type GitWorkspace } from './git-workspace.js'

export type GitRun = (workspace: GitWorkspace, args: string[]) => Promise<string>
interface DiffLine { type: 'add' | 'delete' | 'context'; oldLineNumber: number | null; newLineNumber: number | null; content: string }
interface Hunk { id: string; oldStart: number; oldLines: number; newStart: number; newLines: number; heading?: string; lines: DiffLine[] }
export interface ParsedPatch { header: string[]; hunks: Array<{ hunk: Hunk; raw: string[] }> }
const HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/

/** Keep the exact patch bytes alongside render data. An ordinal alone can
 * silently refer to a different edit after a file changes. */
export function parsePatch(raw: string): ParsedPatch {
  const parsed: ParsedPatch = { header: [], hunks: [] }
  let current: ParsedPatch['hunks'][number] | undefined
  let oldLine = 0, newLine = 0
  for (const line of raw.split('\n')) {
    const match = HEADER.exec(line)
    if (match) {
      oldLine = Number(match[1]); newLine = Number(match[3])
      current = { raw: [line], hunk: { id: '', oldStart: oldLine, oldLines: match[2] === undefined ? 1 : Number(match[2]), newStart: newLine, newLines: match[4] === undefined ? 1 : Number(match[4]), heading: match[5].trim() || undefined, lines: [] } }
      parsed.hunks.push(current)
    } else if (!current) {
      if (line) parsed.header.push(line)
    } else if (/^[ +\\-]/.test(line)) {
      current.raw.push(line)
      const content = line.slice(1)
      if (line[0] === '+') current.hunk.lines.push({ type: 'add', oldLineNumber: null, newLineNumber: newLine++, content })
      else if (line[0] === '-') current.hunk.lines.push({ type: 'delete', oldLineNumber: oldLine++, newLineNumber: null, content })
      else if (line[0] === ' ') current.hunk.lines.push({ type: 'context', oldLineNumber: oldLine++, newLineNumber: newLine++, content })
    }
  }
  parsed.hunks.forEach((item, index) => {
    item.hunk.id = `h${index}-${createHash('sha256').update([...parsed.header, ...item.raw].join('\n')).digest('hex').slice(0, 24)}`
  })
  return parsed
}
function missingObject(error: unknown): boolean {
  const value = error as { stderr?: string }
  return /does not exist in|exists on disk, but not in|path .* does not exist|not a valid object name|invalid object name 'HEAD'|unknown revision|bad revision 'HEAD'/i.test(value.stderr ?? '')
}
async function version(run: GitRun, workspace: GitWorkspace, spec: string): Promise<{ exists: boolean; content: string }> {
  try { return { exists: true, content: await run(workspace, ['show', spec]) } }
  catch (error) { if (missingObject(error)) return { exists: false, content: '' }; throw error }
}
async function rootFile(workspace: GitWorkspace, file: string): Promise<{ repo: GitWorkspace; file: string; absolute: string }> {
  if (!workspace.repository) throw new Error('The current workspace is not a Git repository')
  const absolute = await resolveGitPath(workspace, file)
  const repo = { ...workspace, cwd: workspace.repository.workTree }
  return { repo, file: path.relative(repo.cwd, absolute).replace(/\\/g, '/'), absolute }
}
export async function diffPatch(run: GitRun, workspace: GitWorkspace, file: string, staged: boolean, base?: string): Promise<{ parsed: ParsedPatch; raw: string; repo: GitWorkspace }> {
  const scoped = await rootFile(workspace, file)
  const args = ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', '--src-prefix=a/', '--dst-prefix=b/', '--unified=3']
  if (staged) args.push('--cached')
  else if (base === 'head') args.push('HEAD')
  args.push('--', scoped.file)
  const raw = await run(scoped.repo, args)
  return { raw, parsed: parsePatch(raw), repo: scoped.repo }
}
export async function readDiff(run: GitRun, workspace: GitWorkspace, file: string, staged: boolean, base?: string) {
  const scoped = await rootFile(workspace, file)
  const patch = await diffPatch(run, workspace, file, staged, base)
  const old = await version(run, scoped.repo, `${staged || base === 'head' ? 'HEAD' : ':0'}:${scoped.file}`)
  let next: { exists: boolean; content: string }
  if (staged) next = await version(run, scoped.repo, `:0:${scoped.file}`)
  else {
    try { next = { exists: true, content: await fs.readFile(scoped.absolute, 'utf8') } }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; next = { exists: false, content: '' } }
  }
  const binary = patch.raw.includes('Binary files ') || old.content.includes('\0') || next.content.includes('\0')
  return { success: true, diff: { path: file, changeType: !old.exists ? 'added' : !next.exists ? 'deleted' : 'modified', binary, oldContent: old.content, newContent: next.content, hunks: binary ? [] : patch.parsed.hunks.map(item => item.hunk) } }
}
/** Worktree edits reverse only on worktree; stage/unstage mutate only index.
 * An opaque ID has to match the current complete patch header and block. */
export async function selectedPatch(run: GitRun, workspace: GitWorkspace, file: string, id: string, staged: boolean): Promise<{ patch: string; repo: GitWorkspace }> {
  const result = await diffPatch(run, workspace, file, staged)
  const chosen = result.parsed.hunks.find(item => item.hunk.id === id)
  if (!chosen) throw new Error('变更块已变化或不支持部分操作，请刷新后重试。')
  return { patch: [...result.parsed.header, ...chosen.raw].join('\n') + '\n', repo: result.repo }
}
export async function mergeState(workspace: GitWorkspace): Promise<{ merging: boolean; mergeMessage?: string }> {
  if (!workspace.repository) return { merging: false }
  const resolve = (name: string) => resolveGitPath(workspace, path.relative(workspace.cwd, path.join(workspace.repository!.gitDir, name)))
  try { await fs.readFile(await resolve('MERGE_HEAD'), 'utf8') }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { merging: false }; throw error }
  try {
    const content = await fs.readFile(await resolve('MERGE_MSG'), 'utf8')
    return { merging: true, mergeMessage: content.split('\n').filter(line => !line.startsWith('#')).join('\n').trim() || undefined }
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { merging: true }; throw error }
}
export function parseBlame(raw: string) {
  const lines: Array<{ hash: string; shortHash: string; author: string; date: string; subject: string; boundary?: boolean }> = []
  let row = 0, hash = '', author = '', date = '', subject = '', boundary = false
  for (const value of raw.split('\n')) {
    const line = value.replace(/\r$/, '')
    const match = /^([0-9a-f]{40,64}) \d+ (\d+)(?: \d+)?$/.exec(line)
    if (match) { hash = match[1]; row = Number(match[2]); author = ''; date = ''; subject = ''; boundary = false }
    else if (line.startsWith('\t')) lines[row - 1] = { hash, shortHash: hash.slice(0, 8), author, date, subject, ...(boundary ? { boundary: true } : {}) }
    else if (line === 'boundary') boundary = true
    else if (line.startsWith('author ')) author = line.slice(7)
    else if (line.startsWith('author-time ')) date = new Date(Number(line.slice(12)) * 1000).toISOString()
    else if (line.startsWith('summary ')) subject = line.slice(8)
  }
  return lines
}
export async function blame(run: GitRun, workspace: GitWorkspace, file: string) {
  const scoped = await rootFile(workspace, file)
  let head: string
  try { head = (await run(scoped.repo, ['rev-parse', '--verify', 'HEAD'])).trim() }
  catch (error) { if (/Needed a single revision|ambiguous argument 'HEAD'/.test((error as { stderr?: string }).stderr ?? '')) return { success: true, lines: [] }; throw error }
  const content = await version(run, scoped.repo, `HEAD:${scoped.file}`)
  if (!content.exists || content.content.includes('\0') || Buffer.byteLength(content.content) > 2 * 1024 * 1024) return { success: true, head, lines: [] }
  return { success: true, head, lines: parseBlame(await run(scoped.repo, ['blame', '--line-porcelain', 'HEAD', '--', scoped.file])) }
}
export async function userName(run: GitRun, workspace: GitWorkspace) {
  const read = async (key: string): Promise<string | undefined> => {
    try { return (await run(workspace, ['config', '--get', key])).trim() || undefined }
    catch (error) { if ((error as { code?: number }).code === 1) return undefined; throw error }
  }
  const [name, email] = await Promise.all([read('user.name'), read('user.email')])
  return { success: true, name, email }
}
export async function listAuthors(run: GitRun, workspace: GitWorkspace) {
  let raw: string
  try { raw = await run(workspace, ['log', 'HEAD', '--format=%an']) }
  catch (error) { if (/does not have any commits|ambiguous argument 'HEAD'|bad revision 'HEAD'/i.test((error as { stderr?: string }).stderr ?? '')) return { success: true, authors: [] }; throw error }
  const counts = new Map<string, number>()
  for (const line of raw.split('\n')) { const name = line.trim(); if (name) counts.set(name, (counts.get(name) ?? 0) + 1) }
  return { success: true, authors: [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([name]) => name) }
}
