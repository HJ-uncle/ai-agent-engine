import path from 'node:path'
import fs from 'node:fs'
import { workspaceManager } from '../../../workspace/index.js'
import { withRepositoryLease, repositoryLeaseStatus, recoverRepositoryLease, recoveredRepositoryOwner, activeCloneRepositoryLease, rejectBusyRepositoryLease } from '../../../workspace/repository-lease.js'
import type { WorkspaceBindingSnapshot } from '../../../workspace/manager.js'
import { resolveGitWorkspace, type GitWorkspace } from './git-workspace.js'

export function expectedBinding(value: { expectedRoot?: string; bindingEpoch?: string }, required: boolean): WorkspaceBindingSnapshot | undefined {
  if (!required && value.expectedRoot === undefined && value.bindingEpoch === undefined) return undefined
  if (typeof value.expectedRoot !== 'string' || !path.isAbsolute(value.expectedRoot) || value.expectedRoot.length > 4096 ||
      /[\u0000-\u001f\u007f]/.test(value.expectedRoot) || typeof value.bindingEpoch !== 'string' || !value.bindingEpoch || value.bindingEpoch.length > 128) {
    throw new Error('Git mutation requires expectedRoot and bindingEpoch from the task binding snapshot')
  }
  return { root: value.expectedRoot, epoch: value.bindingEpoch }
}

/** Session selection and physical repository are separate resources: two
 * sessions may share one index and must not execute simultaneous Git actions.
 *
 * The workspace lease is a short-lived coordination lock shared with the
 * Explorer and Work workspace panels.  Those readers can legitimately hold
 * it while Git is starting, so Git waits for that lease.  The repository lease
 * remains fail-fast (`waitMs`) for mutations: queuing a second write could
 * replay a side effect after the first operation has already changed the
 * index. */
export async function withGitBinding<T>(context: { tenantId: string; sessionId: string }, cwdRelative: string,
  expected: WorkspaceBindingSnapshot | undefined, action: (workspace: GitWorkspace) => Promise<T>, waitMs = 0, prepareInit = false, cloneOnly = false): Promise<T> {
  const bindingWaitMs = 30_000
  return workspaceManager.withBindingLease(context, expected, async binding => {
    const cwd=workspaceManager.resolveSafePath(context,cwdRelative||'.')
    const cloning=scopedCloneLease(binding.snapshot.root,cwd);if(cloning)rejectBusyRepositoryLease(cloning)
    const workspace = await resolveGitWorkspace(binding.snapshot.root, cwd)
    binding.assertCurrent()
    workspace.assertBinding = binding.assertCurrent
    workspace.bindingResource={...binding.resource,root:binding.snapshot.root,epoch:binding.snapshot.epoch}
    if(cloneOnly)return action(workspace)
    if(prepareInit && !workspace.repository) fs.mkdirSync(path.join(workspace.cwd,'.git'),{recursive:true})
    const lock = repositoryLock(workspace,prepareInit)
    return withRepositoryLease(lock,async(scope,assertOwned)=>{
      const assertBinding=()=>{binding.assertCurrent();assertOwned()}
      workspace.assertBinding=assertBinding
      workspace.processScope={...scope,run(file,args,options){
        const beforeDispatch=options.beforeDispatch
        return scope.run(file,args,{...options,beforeDispatch:()=>{assertBinding();beforeDispatch?.()}})
      }}
      workspace.assertBinding();return action(workspace)
    },waitMs,{...binding.resource,root:binding.snapshot.root,epoch:binding.snapshot.epoch})
  }, bindingWaitMs)
}

function scopedCloneLease(root:string,cwd:string):string|undefined {
  const canonicalRoot=fs.realpathSync(root),canonical=fs.realpathSync(cwd)
  const relative=path.relative(canonicalRoot,canonical)
  if(relative==='..' || relative.startsWith('..'+path.sep) || path.isAbsolute(relative))throw new Error('Clone lease inspection leaves the task workspace')
  return activeCloneRepositoryLease(canonical)
}
function inspectCloneBinding(context:{tenantId:string;sessionId:string},cwdRelative:string,expected:WorkspaceBindingSnapshot|undefined):string|undefined {
  const snapshot=workspaceManager.getBindingSnapshot(context)
  if(expected && (expected.root!==snapshot.root || expected.epoch!==snapshot.epoch))throw new Error('Workspace binding changed before clone inspection')
  const file=scopedCloneLease(snapshot.root,workspaceManager.resolveSafePath(context,cwdRelative||'.'))
  const current=workspaceManager.getBindingSnapshot(context)
  if(current.root!==snapshot.root || current.epoch!==snapshot.epoch)throw new Error('Workspace binding changed during clone inspection')
  return file
}

function repositoryLock(workspace: GitWorkspace, prepareInit=false): string {
  return workspace.repository ? path.join(workspace.repository.commonDir ?? workspace.repository.gitDir,'.aether-operation.lock') : prepareInit ? path.join(workspace.cwd,'.git','.aether-operation.lock') : path.join(workspace.base,'.ae','git-operation.lock')
}
/** Inspection does not run Git or mutate a repository. It remains usable when
 * an interrupted session lease is blocking normal operations. */
async function inspectGitBinding(context: {tenantId:string;sessionId:string},cwdRelative:string,expected:WorkspaceBindingSnapshot|undefined):Promise<GitWorkspace> {
  const snapshot=workspaceManager.getBindingSnapshot(context)
  if(expected && (expected.root!==snapshot.root || expected.epoch!==snapshot.epoch))throw new Error('Workspace binding changed before lease inspection')
  const workspace=await resolveGitWorkspace(snapshot.root,workspaceManager.resolveSafePath(context,cwdRelative||'.'))
  const current=workspaceManager.getBindingSnapshot(context)
  if(current.root!==snapshot.root || current.epoch!==snapshot.epoch)throw new Error('Workspace binding changed during lease inspection')
  return workspace
}
export async function gitLeaseStatus(context:{tenantId:string;sessionId:string},cwdRelative:string,expected:WorkspaceBindingSnapshot|undefined) {
  return repositoryLeaseStatus(inspectCloneBinding(context,cwdRelative,expected)??repositoryLock(await inspectGitBinding(context,cwdRelative,expected)))
}
export async function recoverGitLease(context:{tenantId:string;sessionId:string},cwdRelative:string,expected:WorkspaceBindingSnapshot|undefined,generation:string) {
  if(!expected)throw new Error('Recovery requires the current binding snapshot')
  const file=inspectCloneBinding(context,cwdRelative,expected)??repositoryLock(await inspectGitBinding(context,cwdRelative,expected))
  let state=repositoryLeaseStatus(file)
  if(!state.busy) {
    state={busy:true,recoverable:true,generation,owner:recoveredRepositoryOwner(file,generation)}
  } else recoverRepositoryLease(file,generation)
  // Repository recovery is independently fenced by the native audit.  A
  // binding receipt from an old engine/session is retained when it cannot be
  // proven to belong to this request; only an exact current-session match is
  // released by recoverInterruptedGitBinding.
  if(state.owner?.bindingLease) workspaceManager.recoverInterruptedGitBinding(context,expected,state.owner.bindingLease,state.owner.owner.pid)
  return {busy:false,recoverable:false}
}
