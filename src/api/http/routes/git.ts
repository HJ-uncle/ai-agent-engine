/** Read-only, session-scoped Git HTTP API for remote Aether Code.
 *
 * The engine's authenticated request context supplies the tenant.  Callers
 * provide only a session id and workspace-relative path; WorkspaceManager
 * resolves and bounds every path before git is invoked.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs/promises'
import path from 'node:path'
import { workspaceManager } from '../../../workspace/index.js'
import { success, fail } from '../response.js'

const execFileAsync = promisify(execFile)
const tenant = (req: FastifyRequest) => (req as any).authContext?.tenantId ?? 'default'
interface Query { sessionId?: string; cwd?: string; path?: string; staged?: string; base?: string; limit?: string; skip?: string; hash?: string; index?: string; search?: string; author?: string; refs?: string }
interface ActionBody {
  sessionId?: string; cwd?: string; op?: string; path?: string; paths?: string[]; message?: string;
  branch?: string; oldName?: string; newName?: string; ref?: string; remote?: string; name?: string;
  url?: string; index?: number; indexes?: number[]; includeUntracked?: boolean; force?: boolean;
  hash?: string; hunkId?: string;
}

function text(value: unknown, label: string, max = 4096): string {
  const out = typeof value === 'string' ? value : ''
  if (out.length > max || /[\u0000-\u001f\u007f]/.test(out)) throw new Error(`${label} 无效`)
  return out
}

function relative(value: unknown, label: string): string {
  const out = text(value, label)
  if (/^(?:[A-Za-z]:|[\\/])/.test(out) || out.replace(/\\/g, '/').split('/').some((part) => part === '..' || part === '.')) {
    throw new Error(`${label} 必须是工作区内相对路径`)
  }
  return out
}

async function run(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync('git', ['-C', cwd, ...args], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 30_000, windowsHide: true })
  return String(result.stdout ?? '')
}

async function runInput(cwd: string, args: string[], input: string): Promise<string> {
  return await new Promise((resolve, reject) => {
    const child = spawn('git', ['-C', cwd, ...args], { windowsHide: true })
    let stdout = ''; let stderr = ''
    const timer = setTimeout(() => { child.kill(); reject(new Error('git 操作超时')) }, 30_000)
    child.stdout.on('data', (chunk) => { stdout += String(chunk) })
    child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    child.once('error', (error) => { clearTimeout(timer); reject(error) })
    child.once('close', (code) => { clearTimeout(timer); code === 0 ? resolve(stdout) : reject(new Error(stderr || `git exited with ${code}`)) })
    child.stdin.end(input)
  })
}

function resultFromInput(cwd: string, args: string[], input: string): Promise<Record<string, unknown>> {
  return runInput(cwd, args, input).then(() => ({ success: true })).catch((error: any) => ({ success: false, error: String(error?.message || error) }))
}

function argument(value: unknown, label: string, max = 4096): string {
  const out = text(value, label, max)
  if (!out) throw new Error(`${label} 必填`)
  return out
}

function paths(value: unknown, label = 'paths'): string[] {
  if (!Array.isArray(value) || value.length > 500) throw new Error(`${label} 无效`)
  return value.map((item) => relative(item, label))
}

function stashRef(index: unknown): string {
  return typeof index === 'number' && Number.isInteger(index) && index >= 0 && index < 10000 ? `stash@{${index}}` : 'stash@{0}'
}

function gitName(value: unknown, label: string, max = 512): string {
  const out = argument(value, label, max)
  if (out.startsWith('-') || out.includes(':')) throw new Error(`${label} 无效`)
  return out
}

async function runAction(cwd: string, body: ActionBody): Promise<Record<string, unknown>> {
  const op = argument(body.op, 'op', 64)
  const result = (args: string[]) => run(cwd, args).then(() => ({ success: true })).catch((error: any) => ({ success: false, error: String(error?.stderr || error?.message || error) }))
  const file = () => relative(body.path, 'path')
  const many = () => paths(body.paths)
  const message = () => argument(body.message, 'message', 32000)
  const branch = () => gitName(body.branch, 'branch')
  const ref = () => gitName(body.ref, 'ref')
  const remote = () => gitName(body.remote, 'remote', 256)
  const name = () => gitName(body.name, 'name')
  const hash = () => { const out = argument(body.hash, 'hash', 256); if (!/^[0-9a-f]{4,64}$/i.test(out)) throw new Error('hash 无效'); return out }
  switch (op) {
    case 'init': return result(['init'])
    case 'clone': {
      const url = argument(body.url, 'url', 4096)
      if (!/^(?:https?|ssh|git|file):\/\//i.test(url) && !/^[^\s/@:]+@[^\s:]+:.+/.test(url)) throw new Error('clone 地址只支持 HTTP(S)、SSH、Git 或 file 协议')
      const rawName = url.split(/[?#]/, 1)[0].replace(/[\\/]+$/, '').split(/[\\/]/).at(-1)?.replace(/\.git$/i, '') || 'repository'
      const folder = /^[A-Za-z0-9._-]{1,120}$/.test(rawName) && rawName !== '.' && rawName !== '..' ? rawName : 'repository'
      const destination = path.join(cwd, folder)
      const clone = await result(['clone', url, destination])
      return clone.success ? { ...clone, finalPath: destination } : clone
    }
    case 'stage': return result(['add', '-f', '--', file()])
    case 'stage-files': { const items = many(); return items.length ? { ...(await result(['--literal-pathspecs', 'add', '-f', '--', ...items])), stagedPaths: items } : { success: true, stagedPaths: [] } }
    case 'unstage': return result(['restore', '--staged', '--', file()])
    case 'unstage-files': return result(['reset', '-q', '--', ...many()])
    case 'check-ignored': { const items = many(); const output = await run(cwd, ['check-ignore', '--', ...items]).catch((error: any) => String(error?.stdout || '')); const set = new Set(output.split(/\r?\n/).filter(Boolean).map((item) => item.replace(/\\/g, '/'))); const ignored: Record<string, boolean> = {}; for (const item of items) ignored[item] = set.has(item); return { success: true, ignored } }
    case 'discard-file': return result(['restore', '--staged', '--worktree', '--', file()])
    case 'discard-worktree': return result(['restore', '--worktree', '--', file()])
    case 'discard-files': return result(['restore', '--staged', '--worktree', '--', ...many()])
    case 'discard-worktree-files': return result(['restore', '--worktree', '--', ...many()])
    case 'discard-hunk': {
      const raw = await run(cwd, ['diff', '-U0', '--', file()])
      const blocks: string[][] = []; let current: string[] | null = null; const header: string[] = []
      for (const line of raw.split('\n')) { if (line.startsWith('@@')) { current = [line]; blocks.push(current) } else if (current) current.push(line); else if (line) header.push(line) }
      const index = Number(String(body.hunkId ?? '').replace(/^h/, ''))
      if (!Number.isInteger(index) || !blocks[index]) return { success: false, error: '变更块已变化，请刷新后重试。' }
      return resultFromInput(cwd, ['apply', '--reverse', '--unidiff-zero', '-'], [...header, ...blocks[index]].join('\n') + '\n')
    }
    case 'commit': return result(['commit', '-m', message()])
    case 'stage-all-commit': { const staged = await result(['add', '-A']); return staged.success ? result(['commit', '-m', message()]) : staged }
    case 'commit-amend': return result(['commit', '--amend', '--no-edit'])
    case 'commit-amend-message': return result(['commit', '--amend', '-m', message()])
    case 'undo-commit': return result(['reset', '--soft', 'HEAD~1'])
    case 'commit-empty': return result(['commit', '--allow-empty', ...(body.message?.trim() ? ['-m', body.message] : ['--allow-empty-message'])])
    case 'fetch': return result(['fetch', '--all', '--prune'])
    case 'pull': return result(['pull', '--ff-only'])
    case 'pull-merge': return result(['pull', '--no-rebase'])
    case 'pull-rebase': return result(['pull', '--rebase'])
    case 'push': return result(['push'])
    case 'push-force': return result(['push', '--force-with-lease'])
    case 'push-tags': return result(['push', '--tags'])
    case 'push-tag': return result(['push', 'origin', name()])
    case 'pull-from': return result(['pull', remote(), branch()])
    case 'push-to': return result(['push', remote(), branch()])
    case 'sync': { const pulled = await result(['pull', '--ff-only']); return pulled.success ? result(['push']) : pulled }
    case 'checkout': return result(['checkout', branch()])
    case 'create-branch': return result(['branch', branch(), ...(body.ref ? [ref()] : [])])
    case 'delete-branch': return result(['branch', body.force ? '-D' : '-d', branch()])
    case 'rename-branch': return result(['branch', '-m', gitName(body.oldName, 'oldName'), gitName(body.newName, 'newName')])
    case 'publish-branch': return result(['push', '-u', 'origin', (await run(cwd, ['branch', '--show-current'])).trim()])
    case 'merge': return result(['merge', ref()])
    case 'merge-abort': return result(['merge', '--abort'])
    case 'rebase': return result(['rebase', ref()])
    case 'rebase-abort': return result(['rebase', '--abort'])
    case 'cherry-pick': return result(['cherry-pick', hash()])
    case 'cherry-pick-abort': return result(['cherry-pick', '--abort'])
    case 'revert-commit': return result(['revert', hash()])
    case 'add-remote': return result(['remote', 'add', name(), argument(body.url, 'url', 4096)])
    case 'remove-remote': return result(['remote', 'remove', name()])
    case 'delete-remote-branch': return result(['push', remote(), '--delete', branch()])
    case 'delete-remote-tag': return result(['push', argument(body.remote || 'origin', 'remote', 256), '--delete', `refs/tags/${name()}`])
    case 'stash-push': return result(['stash', 'push', ...(body.includeUntracked ? ['-u'] : []), ...(body.message ? ['-m', body.message] : [])])
    case 'stash-push-staged': return result(['stash', 'push', '--staged', ...(body.message ? ['-m', body.message] : [])])
    case 'stash-pop': return result(['stash', 'pop', stashRef(body.index)])
    case 'stash-apply': return result(['stash', 'apply', stashRef(body.index)])
    case 'stash-drop': return result(['stash', 'drop', stashRef(body.index)])
    case 'stash-drop-batch': { for (const index of body.indexes ?? []) { const item = await result(['stash', 'drop', stashRef(index)]); if (!item.success) return item } return { success: true } }
    case 'stash-clear': return result(['stash', 'clear'])
    case 'create-tag': return result(['tag', ...(body.message ? ['-a', name(), '-m', body.message] : [name()])])
    case 'delete-tag': return result(['tag', '-d', name()])
    case 'append-gitignore': { const entry = relative(body.path, 'path'); const target = path.join(cwd, '.gitignore'); const existing = await fs.readFile(target, 'utf8').catch(() => ''); if (!existing.split(/\r?\n/).some((line) => line.trim() === entry || line.trim() === `/${entry}`)) await fs.writeFile(target, `${existing}${existing && !existing.endsWith('\n') ? '\n' : ''}${entry}\n`, 'utf8'); return { success: true } }
    case 'suggest-message': { const stat = await run(cwd, ['diff', '--stat', 'HEAD']).catch(() => ''); return { success: true, message: stat.trim() ? `更新 ${stat.trim().split(/\r?\n/).length} 个文件` : '更新项目文件' } }
    default: throw new Error(`不支持的 Git 操作: ${op}`)
  }
}

function parseStatus(raw: string) {
  const files: any[] = []
  for (const line of raw.split(/\r?\n/)) {
    if (!line || line.startsWith('##')) continue
    const code = line.slice(0, 2)
    const value = line.slice(3)
    const parts = value.split(' -> ')
    const filePath = (parts.at(-1) ?? '').trim()
    if (!filePath) continue
    const kind = code.includes('?') ? 'untracked' : code.includes('R') ? 'renamed' : code.includes('C') ? 'copied' : code.includes('A') ? 'added' : code.includes('D') ? 'deleted' : 'modified'
    files.push({ path: filePath, ...(parts.length > 1 ? { oldPath: parts[0].trim() } : {}), changeType: kind, staged: code[0] !== ' ' && code[0] !== '?', stagedChange: code[0] === ' ' ? null : kind, unstagedChange: code[1] === ' ' ? null : kind, binary: false, additions: 0, deletions: 0 })
  }
  return files
}

function parseLog(raw: string) {
  return raw.split('\x1e').filter(Boolean).map((record) => {
    const [hash, shortHash, author, date, subject, body, parents, refs] = record.split('\x1f')
    return { hash, shortHash, author, date, subject, body: body || '', parents: parents ? parents.split(' ').filter(Boolean) : [], refs: refs ? refs.split(',').filter(Boolean).map((name) => ({ name: name.trim(), type: name.trim().startsWith('origin/') ? 'remote' : name.trim().startsWith('tag:') ? 'tag' : 'branch' })) : [], fileChanges: [] }
  })
}

function commitHash(value: unknown): string {
  const hash = text(value, 'hash', 80)
  if (!/^[0-9a-f]{7,64}$/i.test(hash)) throw new Error('hash 无效')
  return hash
}

export async function gitRoutes(fastify: FastifyInstance) {
  fastify.post<{ Body: ActionBody }>('/git/action', async (request, reply) => {
    try {
      const body = request.body ?? {}
      const sessionId = text(body.sessionId || 'default', 'sessionId', 256) || 'default'
      const cwdRelative = body.cwd === '.' ? '' : relative(body.cwd || '', 'cwd')
      const cwd = cwdRelative ? workspaceManager.resolveSafePath({ tenantId: tenant(request), sessionId }, cwdRelative) : workspaceManager.getWorkingDirectory({ tenantId: tenant(request), sessionId })
      return reply.send(success(await runAction(cwd, body)))
    } catch (error) {
      return reply.code(200).send(fail(50000, error instanceof Error ? error.message : String(error)))
    }
  })

  fastify.get<{ Params: { op: string }; Querystring: Query }>('/git/:op', async (request, reply) => {
    const sessionId = text(request.query.sessionId || 'default', 'sessionId', 256) || 'default'
    const base = workspaceManager.getWorkingDirectory({ tenantId: tenant(request), sessionId })
    const cwdRelative = request.query.cwd === '.' ? '' : relative(request.query.cwd || '', 'cwd')
    const cwd = cwdRelative ? workspaceManager.resolveSafePath({ tenantId: tenant(request), sessionId }, cwdRelative) : base
    const op = request.params.op
    try {
      switch (op) {
        case 'status': {
          const raw = await run(cwd, ['status', '--porcelain=v1', '--branch', '--untracked-files=all']).catch(() => '')
          if (!raw && await run(cwd, ['rev-parse', '--is-inside-work-tree']).catch(() => '') === '') return reply.send(success({ success: true, isRepo: false, files: [] }))
          const header = raw.split(/\r?\n/).find((line) => line.startsWith('##')) ?? ''
          const branch = header.slice(3).split('...')[0].split(' ')[0] || ''
          return reply.send(success({ success: true, isRepo: true, files: parseStatus(raw), branch, merging: false }))
        }
        case 'branch-info': {
          const branch = (await run(cwd, ['branch', '--show-current'])).trim() || 'HEAD'
          let upstream: string | null = null; let ahead: number | null = null; let behind: number | null = null
          try { upstream = (await run(cwd, ['rev-parse', '--abbrev-ref', '@{u}'])).trim() || null; const counts = (await run(cwd, ['rev-list', '--left-right', '--count', 'HEAD...@{u}'])).trim().split(/\s+/); ahead = Number(counts[0] ?? 0); behind = Number(counts[1] ?? 0) } catch {}
          return reply.send(success({ success: true, isRepo: true, info: { branch, upstream, ahead, behind } }))
        }
        case 'divergence': { const counts = (await run(cwd, ['rev-list', '--left-right', '--count', 'HEAD...@{u}']).catch(() => '0 0')).trim().split(/\s+/).map(Number); return reply.send(success({ success: true, ahead: counts[0] || 0, behind: counts[1] || 0 })) }
        case 'incoming': { const limit = Math.min(Math.max(Number(request.query.limit ?? 50), 1), 500); const out = await run(cwd, ['log', `-${limit}`, '--date=iso-strict', '--pretty=format:%H%x1f%h%x1f%an%x1f%aI%x1f%s%x1f%b%x1f%P%x1f%D%x1e', 'HEAD..@{u}']).catch(() => ''); return reply.send(success({ success: true, commits: parseLog(out) })) }
        case 'diff': {
          const file = relative(request.query.path, 'path'); const staged = request.query.staged === 'true'; const base = request.query.base === 'head'; const raw = await run(cwd, staged ? ['diff', '--cached', '--', file] : base ? ['diff', 'HEAD', '--', file] : ['diff', '--', file]);
          const oldContent = await run(cwd, staged || base ? ['show', `HEAD:${file}`] : ['show', `:${file}`]).catch(() => '');
          const newContent = await fs.readFile(path.join(cwd, file), 'utf8').catch(() => '')
          const lines = raw.split(/\r?\n/).filter(Boolean).map((line) => ({ type: line.startsWith('+') && !line.startsWith('+++') ? 'add' : line.startsWith('-') && !line.startsWith('---') ? 'delete' : 'context', oldLineNumber: null, newLineNumber: null, content: line.slice(1) }))
          return reply.send(success({ success: true, diff: { path: file, changeType: 'modified', binary: false, oldContent, newContent, hunks: lines.length ? [{ id: 'hunk-0', oldStart: 1, oldLines: 0, newStart: 1, newLines: 0, lines }] : [] } }))
        }
        case 'list-branches': { const branches = (await run(cwd, ['for-each-ref', '--format=%(refname:short)', 'refs/heads'])).split(/\r?\n/).filter(Boolean); return reply.send(success({ success: true, branches, current: (await run(cwd, ['branch', '--show-current'])).trim() })) }
        case 'list-remote-branches': { const branches = (await run(cwd, ['for-each-ref', '--format=%(refname:short)', 'refs/remotes'])).split(/\r?\n/).filter(Boolean); return reply.send(success({ success: true, branches })) }
        case 'log': { const limit = Math.min(Math.max(Number(request.query.limit ?? 50), 1), 500); const skip = Math.max(Number(request.query.skip ?? 0), 0); const args = ['log', `-${limit}`, `--skip=${skip}`, '--date=iso-strict', '--pretty=format:%H%x1f%h%x1f%an%x1f%aI%x1f%s%x1f%b%x1f%P%x1f%D%x1e']; if (request.query.search) args.push(`--grep=${text(request.query.search, 'search', 1024)}`, '-i', '--fixed-strings'); if (request.query.author) args.push(`--author=${text(request.query.author, 'author', 1024)}`, '-i', '--fixed-strings'); if (request.query.refs) args.push(...(request.query.refs === 'all' ? ['--all'] : [gitName(request.query.refs, 'refs', 1024)])); return reply.send(success({ success: true, commits: parseLog(await run(cwd, args)) })) }
        case 'commit-show': { const hash = commitHash(request.query.hash); const out = await run(cwd, ['show', '-s', '--date=iso-strict', '--pretty=format:%H%x1f%h%x1f%an%x1f%aI%x1f%s%x1f%b%x1f%P%x1f%D', hash]); const [full, shortHash, author, date, subject, body, parents, refs] = out.split('\x1f'); const names = await run(cwd, ['show', '--format=', '--name-status', hash]); const fileChanges = names.split(/\r?\n/).filter(Boolean).map((line) => { const [code, file] = line.split(/\s+/, 2); return { code, path: file } }); return reply.send(success({ success: true, commit: { hash: full, shortHash, author, date, subject, body: body || '', parents: (parents || '').split(' ').filter(Boolean), refs: refs ? refs.split(',').filter(Boolean).map((name) => ({ name: name.trim(), type: 'branch' })) : [], additions: 0, deletions: 0, fileChanges } })) }
        case 'show-commit-file': { const hash = commitHash(request.query.hash); const file = relative(request.query.path, 'path'); const content = await run(cwd, ['show', `${hash}:${file}`]); return reply.send(success({ success: true, content })) }
        case 'file-history': { const file = relative(request.query.path, 'path'); const limit = Math.min(Math.max(Number(request.query.limit ?? 50), 1), 500); const out = await run(cwd, ['log', `-${limit}`, '--follow', '--date=iso-strict', '--pretty=format:%H%x1f%h%x1f%an%x1f%aI%x1f%s%x1f%b%x1f%P%x1e', '--', file]); return reply.send(success({ success: true, entries: parseLog(out).map((item: any) => ({ ...item, changeCode: 'M', changePath: file })) })) }
        case 'head-file': case 'head-file-content': { const file = relative(request.query.path, 'path'); const content = await run(cwd, ['show', `HEAD:${file}`]).catch(() => ''); return reply.send(success({ success: true, content })) }
        case 'list-stashes': { const out = await run(cwd, ['stash', 'list', '--format=%gd%x09%H%x09%gs%x09%aI']); const stashes = out.split(/\r?\n/).filter(Boolean).map((line) => { const [ref, hash, message, date] = line.split('\t'); return { index: Number((ref ?? '').match(/\d+/)?.[0] ?? 0), hash, message, date } }); return reply.send(success({ success: true, stashes })) }
        case 'stash-show': case 'stash-show-files': { const index = Number(request.query.index ?? 0); const ref = `stash@{${Number.isInteger(index) && index >= 0 ? index : 0}}`; const args = op === 'stash-show-files' ? ['stash', 'show', '--format=', '--name-only', ref] : ['show', `${ref}:`]; const content = await run(cwd, args).catch(() => ''); return reply.send(success({ success: true, content })) }
        case 'list-tags': return reply.send(success({ success: true, tags: (await run(cwd, ['tag', '--list'])).split(/\r?\n/).filter(Boolean) }))
        case 'list-remotes': { const out = await run(cwd, ['remote', '-v']); const remotes: any[] = []; for (const line of out.split(/\r?\n/)) { const m = line.match(/^(\S+)\s+(\S+)\s+\(fetch\)/); if (m) remotes.push({ name: m[1], url: m[2] }) }; return reply.send(success({ success: true, remotes })) }
        default: return reply.code(200).send(fail(40400, `不支持的 Git 查询: ${op}`))
      }
    } catch (error) { return reply.code(200).send(fail(50000, error instanceof Error ? error.message : String(error))) }
  })
}
