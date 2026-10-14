import fs from 'node:fs'
import path from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { repositoryOwnerIdentity, openRepositoryProcessScope, auditRepositoryJob, type ProcessIdentity, type RepositoryProcessScope, type NativeAudit } from './repository-process.js'

export interface RepositoryLeaseOwner {
  schema: 3; protocol: 'windows-job-v1'; generation: string; acquiredAt: string; resource: string
  owner: ProcessIdentity; supervisor?: ProcessIdentity; jobName: string
  phase: 'reserved' | 'supervising' | 'quarantined'; diagnostic?: string
  bindingLease?: {file:string;generation:string;pid:number;root:string;epoch:string}
}
export interface RepositoryLeaseState { busy: boolean; recoverable: boolean; reason?: string; generation?: string; owner?: RepositoryLeaseOwner; native?: NativeAudit }
export interface RepositoryLease { readonly owner: RepositoryLeaseOwner; assertOwned(): void; update(patch: Pick<RepositoryLeaseOwner,'phase'> & Partial<Pick<RepositoryLeaseOwner,'supervisor'|'diagnostic'>>): void; release(): void }

export type RepositoryExecutionDisposition = 'not_started' | 'may_have_effects'
/** Only an admission refusal certifies replay safety. Native closure and lease
 * recovery certify that writers stopped, never that their changes rolled back. */
export function repositoryFailureMetadata(error: unknown): { executionDisposition: RepositoryExecutionDisposition; errorCode?: 'git-busy' | 'git-orphan' | 'git-quarantined' } {
  const value=error as {executionDisposition?:unknown;code?:unknown;errorCode?:unknown} | null
  return {executionDisposition:value?.executionDisposition==='not_started'?'not_started':'may_have_effects',
    ...(value?.code==='GIT_REPOSITORY_BUSY'?{errorCode:value.errorCode==='git-orphan'?'git-orphan' as const:'git-busy' as const}:
      value?.code==='GIT_REPOSITORY_QUARANTINED'?{errorCode:'git-quarantined' as const}:{})}
}

function nativeClosure(owner: RepositoryLeaseOwner): unknown {
  const file=`${owner.resource}.native-close-${owner.generation}.json`
  const stat=fs.lstatSync(file)
  if(stat.isSymbolicLink() || stat.size>16*1024)throw new Error('Native closure receipt is untrusted')
  const value: unknown=JSON.parse(fs.readFileSync(file,'utf8'))
  if(!value || typeof value!=='object')throw new Error('Native closure receipt is invalid')
  const receipt=value as {protocol?:string;jobName?:string;ownerPid?:number;ownerBirth?:string;supervisorPid?:number;supervisorBirth?:string;activeProcesses?:number}
  if(receipt.protocol!==owner.protocol || receipt.jobName!==owner.jobName || receipt.ownerPid!==owner.owner.pid || receipt.ownerBirth!==owner.owner.birth ||
    !owner.supervisor || receipt.supervisorPid!==owner.supervisor.pid || receipt.supervisorBirth!==owner.supervisor.birth || receipt.activeProcesses!==0)throw new Error('Native closure identity does not match this lease')
  return value
}

function readOwner(file: string, resourceFile=file): RepositoryLeaseOwner | undefined {
  try {
    const stat=fs.lstatSync(file)
    if(stat.isSymbolicLink() || stat.size>16*1024) throw new Error('Repository lease metadata is untrusted')
    const value: unknown=JSON.parse(fs.readFileSync(file,'utf8'))
    if(!value || typeof value!=='object') throw new Error('Repository lease metadata is untrusted')
    const item=value as Partial<RepositoryLeaseOwner>
    if(item.schema!==3 || item.protocol!=='windows-job-v1' || typeof item.generation!=='string' || !/^[0-9a-f-]{36}$/i.test(item.generation) ||
       item.jobName!==`Local\\AetherGit-${item.generation}` || typeof item.resource!=='string' || !path.isAbsolute(item.resource) ||
       !item.owner || !Number.isSafeInteger(item.owner.pid) || item.owner.pid<=0 || !/^\d{15,20}$/.test(item.owner.birth) ||
       !['reserved','supervising','quarantined'].includes(item.phase??'') || typeof item.acquiredAt!=='string') throw new Error('Repository lease is legacy or unverifiable; verified migration is required')
    if(item.supervisor && (!Number.isSafeInteger(item.supervisor.pid) || item.supervisor.pid<=0 || !/^\d{15,20}$/.test(item.supervisor.birth))) throw new Error('Repository supervisor identity is untrusted')
    if(path.resolve(item.resource)!==path.resolve(resourceFile)) throw new Error('Repository lease resource identity does not match')
    return item as RepositoryLeaseOwner
  } catch(error) {if((error as NodeJS.ErrnoException).code==='ENOENT') return undefined;throw error}
}
export function recoveredRepositoryOwner(file: string, generation: string): RepositoryLeaseOwner {
  if(!/^[0-9a-f-]{36}$/i.test(generation))throw new Error('Recovery requires the current lease generation')
  const owner=readOwner(`${file}.recovered-${generation}.json`,file)
  if(!owner || owner.generation!==generation || !auditRepositoryJob(owner.jobName,owner.owner,owner.supervisor).verified)throw new Error('Archived Git recovery is unverified')
  if(owner.supervisor)nativeClosure(owner)
  return owner
}
export function repositoryLeaseStatus(file: string): RepositoryLeaseState {
  let owner: RepositoryLeaseOwner | undefined
  try {owner=readOwner(file)} catch(error) {return{busy:true,recoverable:false,reason:error instanceof Error?error.message:String(error)}}
  if(!owner) return{busy:false,recoverable:false}
  try {
    const native=auditRepositoryJob(owner.jobName,owner.owner,owner.supervisor)
    const verified=native.verified && (owner.phase==='reserved' && !owner.supervisor || !!nativeClosure(owner))
    return{busy:true,recoverable:verified,generation:owner.generation,owner,native,reason:verified?'Original owner and supervisor have ended; native closure recorded zero members and the named job no longer exists.':'The original operation is still running or its process group has not been verified closed.'}
  } catch(error) {return{busy:true,recoverable:false,generation:owner.generation,owner,reason:error instanceof Error?error.message:String(error)}}
}
function busy(file: string): Error {
  const state=repositoryLeaseStatus(file)
  const error=new Error(state.recoverable?'Git operation left a verified orphan lease. Recover the interrupted operation, then retry.':`Git repository is busy. Retry after the current operation ends. ${state.reason??''}`)
  Object.assign(error,{code:'GIT_REPOSITORY_BUSY',errorCode:state.recoverable?'git-orphan':'git-busy',executionDisposition:'not_started',leaseFile:file,leaseState:state})
  return error
}
export function rejectBusyRepositoryLease(file:string):never {throw busy(file)}

/** Clone has no .git common directory yet. Its destination reservation is
 * outside the empty target, and remains visible until native audit and any
 * owned partial-directory cleanup finish. Ordinary operations retry/re-resolve
 * after that reservation ends rather than adopting its temporary lock path. */
export function cloneDestinationLock(target:string):string {
  const parent=fs.realpathSync(path.dirname(target))
  const canonical=path.join(parent,path.basename(target))
  const key=createHash('sha256').update(process.platform==='win32'?canonical.toLowerCase():canonical).digest('hex')
  return path.join(parent,'.ae','git-clones',`${key}.lock`)
}
export function activeCloneRepositoryLease(cwd:string):string|undefined {
  let current=fs.realpathSync(cwd)
  for(;;) {
    const file=cloneDestinationLock(current)
    if(fs.existsSync(file))return file
    const parent=path.dirname(current);if(parent===current)break;current=parent
  }
  return undefined
}
export function prepareCloneDestinationLock(target:string):string {
  const file=cloneDestinationLock(target)
  for(const directory of [path.dirname(path.dirname(file)),path.dirname(file)]) {
    try{const stat=fs.lstatSync(directory);if(stat.isSymbolicLink() || !stat.isDirectory())throw new Error('Clone reservation directory is not a physical owned directory')}
    catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;fs.mkdirSync(directory)}
  }
  return file
}
export async function acquireRepositoryLease(file: string, waitMs=0, bindingLease?: RepositoryLeaseOwner['bindingLease']): Promise<RepositoryLease> {
  const deadline=Date.now()+Math.max(0,Math.min(waitMs,30_000))
  for(;;) {
    if(fs.existsSync(file+'.recovery.lock')) {if(Date.now()>=deadline)throw new Error('Git recovery is in progress; retry after it completes');await new Promise(resolve=>setTimeout(resolve,25));continue}
    const owner: RepositoryLeaseOwner={schema:3,protocol:'windows-job-v1',generation:randomUUID(),acquiredAt:new Date().toISOString(),resource:path.resolve(file),owner:{...repositoryOwnerIdentity()},jobName:'',phase:'reserved',...(bindingLease?{bindingLease}:{})}
    owner.jobName=`Local\\AetherGit-${owner.generation}`
    fs.mkdirSync(path.dirname(file),{recursive:true})
    let descriptor: number
    try {descriptor=fs.openSync(file,'wx',0o600)} catch(error) {
      if((error as NodeJS.ErrnoException).code!=='EEXIST') throw error
      if(Date.now()>=deadline) throw busy(file)
      await new Promise(resolve=>setTimeout(resolve,Math.min(25,deadline-Date.now())));continue
    }
    try {fs.writeFileSync(descriptor,JSON.stringify(owner)+'\n');fs.fsyncSync(descriptor)} finally {fs.closeSync(descriptor)}
    if(fs.existsSync(file+'.recovery.lock')) {if(readOwner(file)?.generation===owner.generation)fs.unlinkSync(file);if(Date.now()>=deadline)throw new Error('Git recovery is in progress; retry after it completes');continue}
    let released=false
    const assertOwned=()=>{if(released || readOwner(file)?.generation!==owner.generation) throw new Error('Repository lease generation changed; operation rejected')}
    return {owner,assertOwned,update(patch) {
      assertOwned(); const next={...owner,...patch};const temporary=`${file}.${owner.generation}.tmp`
      fs.writeFileSync(temporary,JSON.stringify(next)+'\n',{flag:'wx',mode:0o600})
      try {const descriptor=fs.openSync(temporary,'r+');try{fs.fsyncSync(descriptor)}finally{fs.closeSync(descriptor)};assertOwned();fs.renameSync(temporary,file);Object.assign(owner,patch)}
      catch(error){fs.rmSync(temporary,{force:true});throw error}
    },release(){if(released)return;assertOwned();fs.unlinkSync(file);released=true}}
  }
}

/** Recovery is explicit and fenced by generation. PID absence alone cannot
 * prove a detached hook stopped: the OS must also report the named job absent. */
export function recoverRepositoryLease(file: string, expectedGeneration: string): RepositoryLeaseState {
  if(!/^[0-9a-f-]{36}$/i.test(expectedGeneration)) throw new Error('Recovery requires the current lease generation')
  const recoveryFile=file+'.recovery.lock';let descriptor: number
  try {descriptor=fs.openSync(recoveryFile,'wx',0o600)} catch(error) {if((error as NodeJS.ErrnoException).code==='EEXIST')throw new Error('Git recovery is already running');throw error}
  try {
    fs.writeFileSync(descriptor,JSON.stringify({pid:process.pid,generation:expectedGeneration})+'\n');fs.fsyncSync(descriptor)
    const state=repositoryLeaseStatus(file)
    if(!state.busy || state.generation!==expectedGeneration || !state.owner || !state.recoverable || !state.native?.verified) throw new Error(`Git lease recovery was refused: ${state.reason??'generation changed'}`)
    // Recheck immediately before moving evidence: a newly acquired lease is
    // never removed on the strength of a previous owner's audit.
    const current=readOwner(file)
    if(current?.generation!==expectedGeneration || !auditRepositoryJob(current.jobName,current.owner,current.supervisor).verified) throw new Error('Git lease recovery identity changed')
    const archive=`${file}.recovered-${expectedGeneration}.json`
    if(fs.existsSync(archive))throw new Error('Recovery archive already exists')
    fs.renameSync(file,archive)
    fs.writeFileSync(archive+'.audit.json',JSON.stringify({recoveredAt:new Date().toISOString(),state},null,2)+'\n',{flag:'wx',mode:0o600})
    return{busy:false,recoverable:false}
  } finally {fs.closeSync(descriptor);fs.unlinkSync(recoveryFile)}
}

export async function withRepositoryLease<T>(file: string, action: (scope: RepositoryProcessScope, assertOwned:()=>void)=>Promise<T>, waitMs=0, bindingLease?: RepositoryLeaseOwner['bindingLease']): Promise<T> {
  const lease=await acquireRepositoryLease(file,waitMs,bindingLease)
  let scope: RepositoryProcessScope | undefined, result: T | undefined, failure: unknown
  try {
    scope=await openRepositoryProcessScope(lease.owner.jobName,`${file}.native-close-${lease.owner.generation}.json`,supervisor=>lease.update({phase:'supervising',supervisor}))
    const containedScope=scope
    const leasedScope:RepositoryProcessScope={...scope,run(file,args,options){
      const beforeDispatch=options.beforeDispatch
      return containedScope.run(file,args,{...options,beforeDispatch:()=>{lease.assertOwned();beforeDispatch?.()}})
    }}
    lease.assertOwned();result=await action(leasedScope,lease.assertOwned)
  } catch(error) {failure=error}
  let cleanupFailure: unknown
  try {
    if(scope) await scope.close()
    const proof=auditRepositoryJob(lease.owner.jobName,lease.owner.owner,lease.owner.supervisor)
    if(proof.jobExists || proof.supervisorAlive || !proof.empty) throw new Error('Git process scope cleanup is unconfirmed')
    const closure=lease.owner.supervisor?nativeClosure(lease.owner):undefined
    fs.writeFileSync(file+'.last-audit.json',JSON.stringify({generation:lease.owner.generation,finishedAt:new Date().toISOString(),scopeAudits:scope?.audits??[],proof,closure,failure:failure instanceof Error?failure.message:failure?String(failure):undefined},null,2)+'\n',{mode:0o600})
    lease.release()
    if(closure)try{fs.rmSync(`${file}.native-close-${lease.owner.generation}.json`,{force:true})}catch{/* Completed proof may remain for audit if a filesystem observer briefly holds it. */}
  } catch(error) {
    cleanupFailure=error
    try {lease.update({phase:'quarantined',diagnostic:error instanceof Error?error.message:String(error)})} catch { /* Changed ownership must not overwrite the new generation. */ }
  }
  if(cleanupFailure) {const error=new Error(`Git repository remains quarantined: ${cleanupFailure instanceof Error?cleanupFailure.message:String(cleanupFailure)}`);Object.assign(error,{code:'GIT_REPOSITORY_QUARANTINED',executionDisposition:'may_have_effects',leaseFile:file,cause:failure});throw error}
  if(failure) throw Object.assign(failure instanceof Error?failure:new Error(String(failure)),{executionDisposition:'may_have_effects'})
  if(result && typeof result==='object' && 'success' in result && result.success===false)Object.assign(result,{executionDisposition:'may_have_effects'})
  return result as T
}

/** Read metadata rather than executing Git before taking its repository lock.
 * Linked worktrees resolve to their canonical shared common directory. */
export function physicalRepositoryLock(cwd: string, prepareInit=false): string {
  const canonical=fs.realpathSync(cwd)
  const clone=activeCloneRepositoryLease(canonical);if(clone)rejectBusyRepositoryLease(clone)
  if(prepareInit && !fs.existsSync(path.join(canonical,'.git'))) fs.mkdirSync(path.join(canonical,'.git'))
  let candidate=canonical
  for(;;) {
    const marker=path.join(candidate,'.git')
    if(fs.existsSync(marker)) {
      let directory: string
      if(fs.statSync(marker).isDirectory()) directory=fs.realpathSync(marker)
      else {const match=/^gitdir: ([^\r\n]+)\r?\n?$/.exec(fs.readFileSync(marker,'utf8'));if(!match)throw new Error('Git directory pointer is invalid');directory=fs.realpathSync(path.resolve(candidate,match[1]))}
      const commonFile=path.join(directory,'commondir')
      if(fs.existsSync(commonFile)) directory=fs.realpathSync(path.resolve(directory,fs.readFileSync(commonFile,'utf8').trim()))
      return path.join(directory,'.aether-operation.lock')
    }
    const parent=path.dirname(candidate);if(parent===candidate)break;candidate=parent
  }
  return path.join(canonical,'.ae','git-operation.lock')
}
