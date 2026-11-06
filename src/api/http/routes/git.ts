/** Session-scoped Git HTTP API for remote Aether Code.
 *
 * The engine's authenticated request context supplies the tenant.  Callers
 * provide only a session id and workspace-relative path; WorkspaceManager
 * resolves and bounds every path before git is invoked.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify'
import fs from 'node:fs/promises'
import path from 'node:path'
import { withRepositoryLease, prepareCloneDestinationLock, repositoryFailureMetadata } from '../../../workspace/repository-lease.js'
import { workspaceManager } from '../../../workspace/index.js'
import { success, fail } from '../response.js'
import { readDiff, selectedPatch, mergeState, blame, userName, listAuthors } from './git-contracts.js'
import { expectedBinding, withGitBinding, gitLeaseStatus, recoverGitLease } from './git-binding.js'
import { resolveGitPath, resolveGitCloneSource, gitArguments, gitEnvironment, type GitWorkspace } from './git-workspace.js'
import { parseGitRemotes } from './git-remotes.js'
import { fillStatusStats, type StatusStatFile } from './git-status-stats.js'


const tenant = (req: FastifyRequest) => (req as any).authContext?.tenantId ?? 'default'
interface Query { sessionId?: string; cwd?: string; path?: string; staged?: string; base?: string; limit?: string; skip?: string; hash?: string; index?: string; search?: string; author?: string; refs?: string; expectedRoot?: string; bindingEpoch?: string }
interface ActionBody {
  sessionId?: string; cwd?: string; op?: string; path?: string; paths?: string[]; message?: string;
  branch?: string; oldName?: string; newName?: string; ref?: string; remote?: string; name?: string;
  url?: string; index?: number; indexes?: number[]; includeUntracked?: boolean; force?: boolean;
  hash?: string; hunkId?: string; remember?: boolean;
  expectedRoot?: string; bindingEpoch?: string; generation?: string;
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

async function run(cwd: GitWorkspace, args: string[]): Promise<string>{
  cwd.assertBinding?.()
  if(!cwd.processScope)throw new Error('Git command was dispatched without a repository scope')
  return cwd.processScope.run('git',gitArguments(cwd,args),{cwd:cwd.cwd,env:gitEnvironment(cwd),maxBytes:16*1024*1024,timeoutMs:30_000})
}

async function runInput(cwd: GitWorkspace, args: string[], input: string): Promise<string>{
  cwd.assertBinding?.()
  if(!cwd.processScope)throw new Error('Git command was dispatched without a repository scope')
  return cwd.processScope.run('git',gitArguments(cwd,args),{cwd:cwd.cwd,env:gitEnvironment(cwd),input,maxBytes:16*1024*1024,timeoutMs:30_000})
}

function resultFromInput(cwd: GitWorkspace, args: string[], input: string): Promise<Record<string, unknown>> {
  return runInput(cwd, args, input).then(() => ({ success: true })).catch((error: any) => ({ success: false, error: String(error?.message || error), ...repositoryFailureMetadata(error) }))
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

function gitErrorText(error: unknown): string {
  const detail = error as { stderr?: unknown; message?: unknown }
  return String(detail?.stderr || detail?.message || error)
}

async function unstagePaths(cwd: GitWorkspace, files: string[]): Promise<void> {
  if (!files.length) return
  let hasHead = true
  try {
    await run(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD'])
  } catch (error) {
    if ((error as { code?: unknown }).code !== 1) throw error
    hasHead = false
  }
  // reset tolerates a stale selection containing an absent path. Falling back
  // from any pathspec error to rm would incorrectly stage tracked deletions.
  await run(cwd, hasHead
    ? ['--literal-pathspecs', 'reset', '-q', '--', ...files]
    : ['--literal-pathspecs', 'rm', '--cached', '--force', '--ignore-unmatch', '--', ...files])
}

async function removeUntrackedPath(cwd: GitWorkspace, file: string): Promise<void> {
  if (!file || file.split(/[\\/]/).includes('.git')) throw new Error('只能放弃工作区内的文件')
  const target = await resolveGitPath(cwd, file)
  for (const directory of [cwd.repository?.gitDir, cwd.repository?.commonDir]) {
    if (!directory) continue
    const relative = path.relative(directory, target)
    if (!relative || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep))) {
      throw new Error('不能删除 Git 仓库元数据')
    }
  }
  cwd.assertBinding?.()
  // Keep the original lexical path so an allowed symlink is removed, not its
  // destination. resolveGitPath above still rejects links outside the task.
  await fs.rm(path.resolve(cwd.cwd, file), { force: true })
}

async function discardPaths(cwd: GitWorkspace, files: string[], worktreeOnly: boolean): Promise<void> {
  for (const file of files) {
    if (!worktreeOnly) await unstagePaths(cwd, [file])
    try {
      await run(cwd, ['--literal-pathspecs', 'restore', '--worktree', '--', file])
    } catch (error) {
      if (!/pathspec|did not match/i.test(gitErrorText(error))) throw error
      // A missing index entry is an untracked file (or a staged deletion).
      // Never substitute HEAD here: that would destroy staged content.
      const indexed = await run(cwd, ['--literal-pathspecs', 'ls-files', '-z', '--', file])
      if (indexed) throw error
      await removeUntrackedPath(cwd, file)
    }
  }
}

async function pullWithStrategy(cwd: GitWorkspace, args: string[], remember?: boolean, rebase = false): Promise<Record<string, unknown>> {
  try {
    await run(cwd, args)
    if (remember) await run(cwd, ['config', 'pull.rebase', String(rebase)])
    return { success: true }
  } catch (error) {
    const message = gitErrorText(error)
    const divergent = /divergent branches|need to specify how to reconcile|Not possible to fast-forward/i.test(message)
      && !/CONFLICT|Automatic merge failed|fix conflicts|error: could not apply/i.test(message)
    return { success: false, error: message, ...repositoryFailureMetadata(error), ...(divergent ? { errorCode: 'divergent' } : {}) }
  }
}

async function pushCurrent(cwd: GitWorkspace): Promise<Record<string, unknown>> {
  try {
    try { await run(cwd, ['push']) }
    catch (error) {
      if (!/no upstream|has no upstream|set-upstream/i.test(gitErrorText(error))) throw error
      const branch = (await run(cwd, ['branch', '--show-current'])).trim()
      if (!branch) throw error
      await run(cwd, ['push', '-u', 'origin', branch])
    }
    return { success: true }
  } catch (error) {
    return { success: false, error: gitErrorText(error), ...repositoryFailureMetadata(error) }
  }
}

async function checkoutBranch(cwd: GitWorkspace, branch: string): Promise<void> {
  const refs = (await run(cwd, ['for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/remotes'])).split(/\r?\n/)
  if (refs.includes(`refs/remotes/${branch}`)) {
    const local = branch.slice(branch.indexOf('/') + 1)
    await run(cwd, refs.includes(`refs/heads/${local}`) ? ['checkout', local] : ['checkout', '--track', '-b', local, branch])
  } else await run(cwd, ['checkout', branch])
}

function parseCommitFiles(raw: string): Array<{ code: string; path: string; oldPath?: string }> {
  const fields = raw.split('\0')
  const files: Array<{ code: string; path: string; oldPath?: string }> = []
  for (let index = 0; index < fields.length;) {
    const code = fields[index++].trim()
    if (!code) continue
    const first = fields[index++]
    if (!first) throw new Error('Git 提交文件列表不完整')
    if (/^[RC]/.test(code)) {
      const next = fields[index++]
      if (!next) throw new Error('Git 重命名路径不完整')
      files.push({ code, path: next, oldPath: first })
    } else files.push({ code, path: first })
  }
  return files
}

async function runAction(cwd: GitWorkspace, body: ActionBody): Promise<Record<string, unknown>> {
  const op = argument(body.op, 'op', 64)
  const result = (args: string[]) => run(cwd, args).then(() => ({ success: true })).catch((error: any) => ({ success: false, error: String(error?.stderr || error?.message || error), ...repositoryFailureMetadata(error) }))
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
      const destination = await resolveGitPath(cwd, folder)
      const source = await resolveGitCloneSource(cwd, url)
      const lock=prepareCloneDestinationLock(destination)
      return withRepositoryLease(lock,async(scope,assertOwned)=>{
        cwd.assertBinding?.();assertOwned();await fs.mkdir(destination)
        const identity=await fs.lstat(destination)
        try {
          await scope.run('git',gitArguments({...cwd,repository:undefined},['clone','--',source,destination]),{cwd:cwd.cwd,env:gitEnvironment({...cwd,repository:undefined}),timeoutMs:30_000,maxBytes:16*1024*1024,beforeDispatch:()=>{cwd.assertBinding?.();assertOwned()}})
          cwd.assertBinding?.();assertOwned();return{success:true,finalPath:destination}
        } catch(error) {
          await scope.close();cwd.assertBinding?.();assertOwned()
          const current=await fs.lstat(destination).catch(problem=>{if((problem as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw problem})
          if(current) {
            if(current.isSymbolicLink() || !current.isDirectory() || current.dev!==identity.dev || current.ino!==identity.ino)throw new Error('Clone target identity changed; partial files were preserved')
            await fs.rm(destination,{recursive:true,force:true})
          }
          return{success:false,error:error instanceof Error?error.message:String(error)}
        }
      },0,cwd.bindingResource)
    }
    case 'stage': return result(['add', '-f', '--', file()])
    case 'stage-files': { const items = many(); return items.length ? { ...(await result(['--literal-pathspecs', 'add', '-f', '--', ...items])), stagedPaths: items } : { success: true, stagedPaths: [] } }
    case 'unstage': await unstagePaths(cwd, [file()]); return { success: true }
    case 'unstage-files': await unstagePaths(cwd, many()); return { success: true }
    case 'check-ignored': { const items = many(); const output = await run(cwd, ['check-ignore', '--', ...items]).catch((error: any) => String(error?.stdout || '')); const set = new Set(output.split(/\r?\n/).filter(Boolean).map((item) => item.replace(/\\/g, '/'))); const ignored: Record<string, boolean> = {}; for (const item of items) ignored[item] = set.has(item); return { success: true, ignored } }
    case 'discard-file': await discardPaths(cwd, [file()], false); return { success: true }
    case 'discard-worktree': await discardPaths(cwd, [file()], true); return { success: true }
    case 'discard-files': await discardPaths(cwd, many(), false); return { success: true }
    case 'discard-worktree-files': await discardPaths(cwd, many(), true); return { success: true }
    case 'discard-hunk': case 'stage-hunk': case 'unstage-hunk': {
      const selected = await selectedPatch(run, cwd, file(), argument(body.hunkId, 'hunkId', 128), op === 'unstage-hunk')
      const args = ['apply', '--recount', '--whitespace=nowarn']
      if (op !== 'discard-hunk') args.push('--cached')
      if (op !== 'stage-hunk') args.push('--reverse')
      args.push('-')
      return resultFromInput(selected.repo, args, selected.patch)
    }
    case 'commit': return result(['commit', '-m', message()])
    case 'stage-all-commit': { const staged = await result(['add', '-A']); return staged.success ? result(['commit', '-m', message()]) : staged }
    case 'commit-amend': return result(['commit', '--amend', '--no-edit'])
    case 'commit-amend-message': return result(['commit', '--amend', '-m', message()])
    case 'undo-commit': return result(['reset', '--soft', 'HEAD~1'])
    case 'commit-empty': return result(['commit', '--allow-empty', ...(body.message?.trim() ? ['-m', body.message] : ['--allow-empty-message', '-m', ''])])
    case 'fetch': return result(['fetch', '--all', '--prune'])
    case 'pull': return pullWithStrategy(cwd, ['pull', '--no-edit'])
    case 'pull-merge': return pullWithStrategy(cwd, ['pull', '--no-rebase', '--no-edit'], body.remember, false)
    case 'pull-rebase': return pullWithStrategy(cwd, ['pull', '--rebase'], body.remember, true)
    case 'push': return pushCurrent(cwd)
    case 'push-force': return result(['push', '--force-with-lease'])
    case 'push-tags': return result(['push', '--tags'])
    case 'push-tag': return result(['push', 'origin', `refs/tags/${name()}`])
    case 'pull-from': return pullWithStrategy(cwd, ['pull', '--no-edit', remote(), branch()])
    case 'push-to': { const selected = body.branch?.trim() ? branch() : (await run(cwd, ['branch', '--show-current'])).trim(); if (!selected) return { success: false, error: '当前不在任何分支上，无法推送。' }; return result(['push', remote(), selected]) }
    case 'push-to-branch': return result(['push', remote(), `HEAD:refs/heads/${branch()}`])
    case 'sync': { const pulled = await pullWithStrategy(cwd, ['pull', '--no-edit']); return pulled.success ? pushCurrent(cwd) : pulled }
    case 'checkout': await checkoutBranch(cwd, branch()); return { success: true }
    case 'create-branch': {
      const start = body.ref ? ref() : undefined
      const remoteRef = start?.startsWith('refs/remotes/') ? start : `refs/remotes/${start}`
      const track = start && (await run(cwd, ['for-each-ref', '--format=%(refname)', 'refs/remotes'])).split(/\r?\n/).includes(remoteRef)
      return result(['checkout', ...(track ? ['--track'] : []), '-b', branch(), ...(start ? [start] : [])])
    }
    case 'delete-branch': return result(['branch', body.force ? '-D' : '-d', branch()])
    case 'rename-branch': return result(['branch', '-m', gitName(body.oldName, 'oldName'), gitName(body.newName, 'newName')])
    case 'publish-branch': return result(['push', '-u', 'origin', (await run(cwd, ['branch', '--show-current'])).trim()])
    case 'merge': return result(['merge', ref()])
    case 'merge-abort': return result(['merge', '--abort'])
    case 'rebase': return result(['rebase', ref()])
    case 'rebase-abort': return result(['rebase', '--abort'])
    case 'cherry-pick': return result(['cherry-pick', hash()])
    case 'cherry-pick-abort': return result(['cherry-pick', '--abort'])
    case 'revert-commit': return result(['revert', '--no-edit', hash()])
    case 'add-remote': return result(['remote', 'add', name(), argument(body.url, 'url', 4096)])
    case 'remove-remote': return result(['remote', 'remove', name()])
    case 'delete-remote-branch': return result(['push', remote(), '--delete', branch()])
    case 'delete-remote-tag': return result(['push', argument(body.remote || 'origin', 'remote', 256), '--delete', `refs/tags/${name()}`])
    case 'stash-push': return result(['stash', 'push', ...(body.includeUntracked ? ['-u'] : []), ...(body.message ? ['-m', body.message] : [])])
    case 'stash-push-staged': return result(['stash', 'push', '--staged', ...(body.message ? ['-m', body.message] : [])])
    case 'stash-pop': return result(['stash', 'pop', stashRef(body.index)])
    case 'stash-apply': return result(['stash', 'apply', stashRef(body.index)])
    case 'stash-drop': return result(['stash', 'drop', stashRef(body.index)])
    case 'stash-drop-batch': { const indexes = body.indexes ?? []; if (!Array.isArray(indexes) || indexes.some(index => !Number.isInteger(index) || index < 0 || index >= 10000)) throw new Error('indexes 无效'); for (const index of [...new Set(indexes)].sort((a, b) => b - a)) { const item = await result(['stash', 'drop', stashRef(index)]); if (!item.success) return item } return { success: true } }
    case 'stash-clear': return result(['stash', 'clear'])
    case 'create-tag': return result(['tag', ...(body.message ? ['-a', name(), '-m', body.message] : [name()])])
    case 'delete-tag': return result(['tag', '-d', name()])
    case 'append-gitignore': { const entry = relative(body.path, 'path'); const target = await resolveGitPath(cwd, '.gitignore'); const existing = await fs.readFile(target, 'utf8').catch(() => ''); cwd.assertBinding?.(); if (!existing.split(/\r?\n/).some((line) => line.trim() === entry || line.trim() === `/${entry}`)) await fs.writeFile(target, `${existing}${existing && !existing.endsWith('\n') ? '\n' : ''}${entry}\n`, 'utf8'); return { success: true } }
    case 'suggest-message': { const stat = await run(cwd, ['diff', '--stat', 'HEAD']).catch(() => ''); return { success: true, message: stat.trim() ? `更新 ${stat.trim().split(/\r?\n/).length} 个文件` : '更新项目文件' } }
    default: throw new Error(`不支持的 Git 操作: ${op}`)
  }
}

function parseStatus(raw: string) {
  const files: Array<StatusStatFile & { staged: boolean; stagedChange: string | null; unstagedChange: string | null; oldPath?: string; conflict?: boolean }> = []
  const tokens = raw.split('\0')
  const change = (code: string) => code === 'A' ? 'added' : code === 'D' ? 'deleted' : code === 'R' ? 'renamed' : code === 'C' ? 'copied' : code === '?' ? 'untracked' : code === ' ' ? null : 'modified'
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]
    if (!token || token.startsWith('##')) continue
    const code = token.slice(0, 2)
    const filePath = token.slice(3)
    if (!filePath) continue
    const oldPath = /[RC]/.test(code) ? tokens[++index] : undefined
    const stagedChange = code[0] === '?' ? null : change(code[0])
    const unstagedChange = change(code[1])
    files.push({ path: filePath, ...(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'].includes(code) ? { conflict: true } : {}), ...(oldPath ? { oldPath } : {}), changeType: unstagedChange ?? stagedChange ?? 'modified', staged: stagedChange !== null, stagedChange, unstagedChange, binary: false, additions: 0, deletions: 0 })
  }
  return files
}

function parseLog(raw: string) {
  return raw.split('\x1e').filter((record) => record.trim()).map((record) => {
    const [hash, shortHash, author, date, subject, body, parents, refs] = record.split('\x1f')
    return { hash: hash.trim(), shortHash, author, date, subject, body: body || '', parents: parents ? parents.split(' ').filter(Boolean) : [], refs: refs ? refs.split(',').filter(Boolean).map((name) => ({ name: name.trim(), type: name.trim().startsWith('origin/') ? 'remote' : name.trim().startsWith('tag:') ? 'tag' : 'branch' })) : [], fileChanges: [] }
  })
}

function commitHash(value: unknown): string {
  const hash = text(value, 'hash', 80)
  if (!/^[0-9a-f]{7,64}$/i.test(hash)) throw new Error('hash 无效')
  return hash
}

export async function gitRoutes(fastify: FastifyInstance) {
  fastify.post<{ Body: ActionBody }>('/git/action', async (request, reply) => {
    let admitted=false
    try {
      const body = request.body ?? {}
      const sessionId = text(body.sessionId || 'default', 'sessionId', 256) || 'default'
      const cwdRelative = body.cwd === '.' ? '' : relative(body.cwd || '', 'cwd')
      const context={tenantId:tenant(request),sessionId}
      if(body.op==='recover-lease')return reply.send(success({success:true,lease:await recoverGitLease(context,cwdRelative,expectedBinding(body,true),argument(body.generation,'generation',128))}))
      const data = await withGitBinding(context, cwdRelative, expectedBinding(body, true), async cwd => {
        admitted=true
        if (!cwd.repository && body.op !== 'init' && body.op !== 'clone') throw new Error('The current workspace is not a Git repository')
        return runAction(cwd, body)
      },0,body.op==='init',body.op==='clone')
      return reply.send(success(data))
    } catch (error) {
      const metadata=repositoryFailureMetadata(error)
      // A lease refusal happens before the route admits the Git action.  It
      // therefore has a replay-safe outcome even for `init` (which is usually
      // conservatively marked as may-have-effects because the route can
      // create `.git` before dispatch).  Preserve that distinction so the UI
      // can inspect the lease and offer a safe retry after a transient
      // workspace/session contention.
      const leaseErrorCode = metadata.errorCode ?? ((error as {code?:unknown})?.code==='WORKSPACE_LEASE_BUSY' ? 'git-busy' as const : undefined)
      const executionDisposition = !admitted && leaseErrorCode === 'git-busy'
        ? 'not_started' as const
        : admitted || request.body?.op==='init' || request.body?.op==='recover-lease' || leaseErrorCode==='git-quarantined'
          ? 'may_have_effects' as const
          : 'not_started' as const
      const failure={success:false,error:error instanceof Error?error.message:String(error),...metadata,
        executionDisposition,
        ...(leaseErrorCode ? {errorCode:leaseErrorCode} : {})}
      return reply.code(200).send(fail(50000,failure.error,failure))
    }
  })

  fastify.get<{ Params: { op: string }; Querystring: Query }>('/git/:op', async (request, reply) => {
    try {
      const sessionId = text(request.query.sessionId || 'default', 'sessionId', 256) || 'default'
      const cwdRelative = request.query.cwd === '.' ? '' : relative(request.query.cwd || '', 'cwd')
      const op = request.params.op
      if(op==='lease')return reply.send(success({success:true,lease:await gitLeaseStatus({tenantId:tenant(request),sessionId},cwdRelative,expectedBinding(request.query,false))}))
      if (op === 'binding') return reply.send(success({ ...workspaceManager.getBindingSnapshot({ tenantId: tenant(request), sessionId }), contractVersion: 2, mutationRequiresBinding: true }))
      // A successful response must certify the native process scope and lease have closed.
      const data = await withGitBinding({ tenantId: tenant(request), sessionId }, cwdRelative, expectedBinding(request.query, false), async cwd => {
      if (!cwd.repository && op === 'branch-info') return success({ success: true, isRepo: false, info: null })
      if (op !== 'status' && !cwd.repository) throw new Error('The current workspace is not a Git repository')
      switch (op) {
        case 'status': {
          if (!cwd.repository) return success({ success: true, isRepo: false, files: [] })
          const raw = await run(cwd, ['status', '--porcelain=v1', '-z', '--branch', '--untracked-files=all'])
          const header = raw.split('\0').find((line) => line.startsWith('##')) ?? ''
          const branch = header.slice(3).replace(/^No commits yet on /, '').split('...')[0].split(' ')[0] || ''
          // Porcelain v1 -z always names paths from the repository root, while
          // task actions and relative numstat use the selected cwd instead.
          const repositoryRoot = cwd.repository.workTree
          const relativeToCwd = (filePath: string): string | undefined => {
            const relative = path.relative(cwd.cwd, path.resolve(repositoryRoot, filePath))
            if (!relative || path.isAbsolute(relative) || relative === '..' || relative.startsWith('..' + path.sep)) return undefined
            return relative.split(path.sep).join('/')
          }
          const files = parseStatus(raw).flatMap(file => {
            const relative = relativeToCwd(file.path)
            return relative ? [{ ...file, path: relative, ...(file.oldPath ? { oldPath: relativeToCwd(file.oldPath) } : {}) }] : []
          })
          await fillStatusStats(cwd.cwd, files, args => run(cwd, args))
          return success({ success: true, isRepo: true, files, branch, ...await mergeState(cwd) })
        }
        case 'branch-info': {
          const branch = (await run(cwd, ['branch', '--show-current'])).trim() || 'HEAD'
          let upstream: string | null = null; let ahead: number | null = null; let behind: number | null = null
          try { upstream = (await run(cwd, ['rev-parse', '--abbrev-ref', '@{u}'])).trim() || null; const counts = (await run(cwd, ['rev-list', '--left-right', '--count', 'HEAD...@{u}'])).trim().split(/\s+/); ahead = Number(counts[0] ?? 0); behind = Number(counts[1] ?? 0) } catch {}
          return success({ success: true, isRepo: true, info: { branch, upstream, ahead, behind } })
        }
        case 'divergence': { const counts = (await run(cwd, ['rev-list', '--left-right', '--count', 'HEAD...@{u}']).catch(() => '0 0')).trim().split(/\s+/).map(Number); return success({ success: true, ahead: counts[0] || 0, behind: counts[1] || 0 }) }
        case 'incoming': { const limit = Math.min(Math.max(Number(request.query.limit ?? 50), 1), 500); const out = await run(cwd, ['log', '--topo-order', `-${limit}`, '--date=iso-strict', '--pretty=format:%H%x1f%h%x1f%an%x1f%aI%x1f%s%x1f%b%x1f%P%x1f%D%x1e', 'HEAD..@{u}']).catch(() => ''); return success({ success: true, commits: parseLog(out) }) }
        case 'diff': {
          const file = relative(request.query.path, 'path')
          return success(await readDiff(run, cwd, file, request.query.staged === 'true', request.query.base))
        }
        case 'blame': return success(await blame(run, cwd, relative(request.query.path, 'path')))
        case 'user-name': return success(await userName(run, cwd))
        case 'list-authors': return success(await listAuthors(run, cwd))
        case 'list-branches': { const branches = (await run(cwd, ['for-each-ref', '--format=%(refname:short)', 'refs/heads'])).split(/\r?\n/).filter(Boolean); return success({ success: true, branches, current: (await run(cwd, ['branch', '--show-current'])).trim() }) }
        case 'list-remote-branches': { const branches = (await run(cwd, ['for-each-ref', '--format=%(refname:short)', 'refs/remotes'])).split(/\r?\n/).filter(Boolean); return success({ success: true, branches }) }
        // The lane graph consumes children before parents; timestamps alone
        // cannot preserve that contract for merges or machines with clock skew.
        case 'log': {
          const limit = Math.min(Math.max(Number(request.query.limit ?? 50), 1), 500)
          const skip = Math.max(Number(request.query.skip ?? 0), 0)
          const args = ['log', '--topo-order', `-${limit}`, `--skip=${skip}`, '--date=iso-strict', '--pretty=format:%H%x1f%h%x1f%an%x1f%aI%x1f%s%x1f%b%x1f%P%x1f%D%x1e']
          if (request.query.search) args.push(`--grep=${text(request.query.search, 'search', 1024)}`, '-i', '--fixed-strings')
          if (request.query.author) args.push(`--author=${text(request.query.author, 'author', 1024)}`, '-i', '--fixed-strings')
          if (request.query.refs) args.push(...(request.query.refs === 'all' ? ['--all'] : [gitName(request.query.refs, 'refs', 1024)]))
          try {
            return success({ success: true, commits: parseLog(await run(cwd, args)) })
          } catch (error) {
            // A newly initialized repository has no default history yet. Invalid
            // explicit refs and other Git failures must still reach the caller.
            if (!request.query.refs && /does not have any commits yet/i.test(error instanceof Error ? error.message : String(error)))
              return success({ success: true, commits: [] })
            throw error
          }
        }
        case 'commit-show': {
          const hash = commitHash(request.query.hash)
          const out = await run(cwd, ['show', '-s', '--date=iso-strict', '--pretty=format:%H%x1f%h%x1f%an%x1f%aI%x1f%s%x1f%b%x1f%P%x1f%D', hash])
          const [full, shortHash, author, date, subject, body, parents, refs] = out.split('\x1f')
          // The history preview compares the first parent. NUL records preserve
          // spaces/Unicode and retain both sides of a rename instead of a label.
          const comparison = (parents || '').split(' ').filter(Boolean)[0]
          const args = comparison
            ? ['diff', '--name-status', '-z', '-M', comparison, hash, '--']
            : ['diff-tree', '--root', '--no-commit-id', '-r', '--name-status', '-z', '-M', hash, '--']
          const fileChanges = parseCommitFiles(await run(cwd, args))
          return success({ success: true, commit: { hash: full, shortHash, author, date, subject, body: body || '', parents: (parents || '').split(' ').filter(Boolean), refs: refs ? refs.split(',').filter(Boolean).map((name) => ({ name: name.trim(), type: 'branch' })) : [], additions: 0, deletions: 0, fileChanges } })
        }
        case 'show-commit-file': { const hash = commitHash(request.query.hash); const file = relative(request.query.path, 'path'); const content = await run(cwd, ['show', `${hash}:${file}`]); return success({ success: true, content }) }
        case 'file-history': { const file = relative(request.query.path, 'path'); const limit = Math.min(Math.max(Number(request.query.limit ?? 50), 1), 500); const out = await run(cwd, ['log', `-${limit}`, '--follow', '--date=iso-strict', '--pretty=format:%H%x1f%h%x1f%an%x1f%aI%x1f%s%x1f%b%x1f%P%x1e', '--', file]); return success({ success: true, entries: parseLog(out).map((item: any) => ({ ...item, changeCode: 'M', changePath: file })) }) }
        case 'head-file': case 'head-file-content': { const file = relative(request.query.path, 'path'); const content = await run(cwd, ['show', `HEAD:${file}`]).catch(() => ''); return success({ success: true, content }) }
        case 'list-stashes': { const out = await run(cwd, ['stash', 'list', '--format=%gd%x09%H%x09%gs%x09%aI']); const stashes = out.split(/\r?\n/).filter(Boolean).map((line) => { const [ref, hash, message, date] = line.split('\t'); return { index: Number((ref ?? '').match(/\d+/)?.[0] ?? 0), hash, message, date } }); return success({ success: true, stashes }) }
        case 'stash-show': case 'stash-show-files': { const index = Number(request.query.index ?? 0); const ref = `stash@{${Number.isInteger(index) && index >= 0 ? index : 0}}`; const args = op === 'stash-show-files' ? ['-c', 'core.quotePath=false', 'stash', 'show', '--format=', '--name-only', ref] : ['stash', 'show', '-p', ref]; const content = await run(cwd, args); return success({ success: true, content }) }
        case 'list-tags': return success({ success: true, tags: (await run(cwd, ['tag', '--list'])).split(/\r?\n/).filter(Boolean) })
        case 'list-remotes': { const out = await run(cwd, ['remote', '-v']); return success({ success: true, remotes: parseGitRemotes(out) }) }
        default: return fail(40400, `不支持的 Git 查询: ${op}`)
      }
      // Read-only status/diff queries may share a repository with Code's
      // local Git refresh. Queue behind the physical repository lease instead
      // of failing immediately with a transient git-busy/orphan message;
      // mutations wait only for known readers and still refuse another writer.
      }, 30_000, false, false, 'read')
      return reply.send(data)
    } catch (error) { return reply.code(200).send(fail(50000, error instanceof Error ? error.message : String(error))) }
  })
}
