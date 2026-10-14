import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import { fileURLToPath } from 'node:url'

const packagedExecutable = fileURLToPath(new URL('./assets/repository-supervisor.exe', import.meta.url))
const packagedSha256 = "3d1e0c4a6b08bd260ff82b4585545376cf4e8b02e0f9ee649c0d07f30243679c"
let executable: string | undefined
let identity: ProcessIdentity | undefined
export interface ProcessIdentity { pid: number; birth: string; alive: boolean }
export interface NativeAudit { ownerAlive: boolean; supervisorAlive: boolean; jobExists: boolean; activeProcesses: number; empty: boolean; verified: boolean }
export interface RunAudit { jobName: string; empty: boolean; activeProcesses: number; killed: boolean; members: ProcessIdentity[][] }
interface Reply { kind: string; pid?: number; birth?: string; jobName?: string; id?: number; exitCode?: number; stdout?: string; stderr?: string; data?: string; failure?: string; message?: string; audit?: RunAudit; empty?: boolean }
export interface NativeRunOptions { cwd: string; env: NodeJS.ProcessEnv; input?: string; timeoutMs?: number; maxBytes?: number; signal?: AbortSignal; onStderr?: (chunk:string)=>void; beforeDispatch?:()=>void }
export interface RepositoryProcessScope {
  readonly supervisor: ProcessIdentity
  readonly audits: ReadonlyArray<RunAudit>
  run(file: string, args: string[], options: NativeRunOptions): Promise<string>
  close(): Promise<void>
}

/** Failure to establish process containment is an error, never a reason to
 * fall back to an untracked Git child while holding a writable repository. */
function supervisorExecutable(): string {
  if (executable) return executable
  if (process.platform !== 'win32') throw new Error('Audited Git process containment is unavailable on this platform')
  if (!fs.existsSync(packagedExecutable) || fs.lstatSync(packagedExecutable).isSymbolicLink() || createHash('sha256').update(fs.readFileSync(packagedExecutable)).digest('hex') !== packagedSha256) throw new Error('Packaged Git process supervisor is missing or its integrity check failed')
  return executable = packagedExecutable
}

function nativeQuery<T>(args: string[]): T {
  const output = execFileSync(supervisorExecutable(), args, { windowsHide:true, encoding:'utf8', timeout:15_000, maxBuffer:128*1024 })
  return JSON.parse(output.trim()) as T
}
export function repositoryOwnerIdentity(): Readonly<ProcessIdentity> {
  return identity ??= nativeQuery<ProcessIdentity>(['identity', String(process.pid)])
}
export function auditRepositoryJob(jobName: string, owner: ProcessIdentity, supervisor?: ProcessIdentity): NativeAudit {
  if (!/^Local\\AetherGit-[0-9a-f-]{36}$/i.test(jobName) || !Number.isSafeInteger(owner.pid) || !/^\d{15,20}$/.test(owner.birth)) throw new Error('Untrusted Git lease process identity')
  return nativeQuery<NativeAudit>(['audit',jobName,String(owner.pid),owner.birth,String(supervisor?.pid ?? 0),supervisor?.birth ?? '0'])
}

export async function openRepositoryProcessScope(jobName: string, receipt: string, onReady: (supervisor: ProcessIdentity) => void): Promise<RepositoryProcessScope> {
  const owner = repositoryOwnerIdentity()
  // The helper must survive Node's own kill-on-close child job long enough to
  // audit and persist closure. Its parent birth handle is the watchdog gate.
  const child: ChildProcessWithoutNullStreams = spawn(supervisorExecutable(), ['serve',jobName,String(owner.pid),owner.birth,receipt], {windowsHide:true,detached:true,stdio:'pipe'})
  const audits: RunAudit[] = []
  let closed = false, closing = false, acknowledgedClose = false, sequence = 0, stdout = '', diagnostic = ''
  let queue: Promise<void> = Promise.resolve()
  let closePromise: Promise<void> | undefined
  let pending: {id:number;resolve:(reply:Reply)=>void;reject:(error:Error)=>void;onStderr?: (data:string)=>void} | undefined
  let resolveReady!: (identity:ProcessIdentity)=>void, rejectReady!: (error:Error)=>void
  const ready = new Promise<ProcessIdentity>((resolve,reject)=>{resolveReady=resolve;rejectReady=reject})
  let resolveExit!: ()=>void
  const exited = new Promise<void>(resolve=>{resolveExit=resolve})
  const decoder = new StringDecoder('utf8')
  const startupDeadline=setTimeout(()=>{child.kill();rejectReady(new Error('Git supervisor did not establish its job'))},15_000)
  child.stderr.on('data',(chunk:Buffer)=>{if(diagnostic.length<128*1024) diagnostic+=String(chunk)})
  child.stdout.on('data',(chunk:Buffer)=>{
    stdout+=decoder.write(chunk)
    if(stdout.length > 64*1024*1024) {child.kill();pending?.reject(new Error('Git supervisor protocol output exceeded its bound'));return}
    let boundary: number
    while((boundary=stdout.indexOf('\n'))>=0) {
      const line=stdout.slice(0,boundary).trim();stdout=stdout.slice(boundary+1);if(!line)continue
      let reply: Reply
      try {reply=JSON.parse(line) as Reply} catch {child.kill();rejectReady(new Error('Git supervisor protocol was invalid'));pending?.reject(new Error('Git supervisor protocol was invalid'));continue}
      if(reply.kind==='ready' && typeof reply.pid==='number' && reply.pid===child.pid && typeof reply.birth==='string' && reply.jobName===jobName) {
        clearTimeout(startupDeadline)
        const value={pid:reply.pid,birth:reply.birth,alive:true}
        try {onReady(value);resolveReady(value)} catch(error) {child.kill();rejectReady(error instanceof Error?error:new Error(String(error)))}
      } else if(reply.kind==='stderr' && pending && pending.id===reply.id && typeof reply.data==='string') {try{pending.onStderr?.(reply.data)}catch{/* A view can disappear without interrupting the owned operation. */}}
      else if(reply.kind==='result' && pending && pending.id===reply.id) {const completion=pending;pending=undefined;completion.resolve(reply)}
      else if(reply.kind==='closed') acknowledgedClose=reply.empty===true
      else if(reply.kind==='fatal') {const error=new Error(reply.message || 'Git supervisor failed');rejectReady(error);pending?.reject(error);pending=undefined}
    }
  })
  child.once('error',(error)=>{rejectReady(error);pending?.reject(error);pending=undefined})
  child.stdin.on('error',(error)=>{pending?.reject(error);pending=undefined})
  child.once('close',()=>{clearTimeout(startupDeadline);closed=true;resolveExit();rejectReady(new Error(`Git supervisor closed before ready: ${diagnostic}`));pending?.reject(new Error(`Git supervisor closed unexpectedly: ${diagnostic}`));pending=undefined})
  let supervisor: ProcessIdentity
  try {supervisor=await ready} catch(error) {child.kill();await Promise.race([exited,new Promise(resolve=>setTimeout(resolve,10_000))]);throw error}
  const scope: RepositoryProcessScope = {
    supervisor, audits,
    run(file,args,options) {
      if(closed || closing) return Promise.reject(new Error('Git supervisor cannot accept another command'))
      const beforeDispatch=options.beforeDispatch
      // Compound actions may collect independent values with Promise.all. The
      // native job executes those admitted reads in order under the same lease.
      const execute=async():Promise<string>=>{
      if(closed || pending) throw new Error('Git supervisor cannot dispatch another command')
      if(options.signal?.aborted) throw Object.assign(new Error('Git command cancelled before dispatch'),{code:'ABORT_ERR'})
      const id=++sequence
      const env=Object.fromEntries(Object.entries(options.env).filter((pair):pair is [string,string]=>typeof pair[1]==='string'))
      const candidate = path.isAbsolute(file) ? file : (options.env.PATH || options.env.Path || '').split(path.delimiter).map(directory => path.join(directory, /\.exe$/i.test(file) ? file : `${file}.exe`)).find(candidate=>fs.existsSync(candidate))
      if (!candidate) throw new Error(`Git executable was not found: ${file}`)
      const cancelPath=`${receipt}.command-${id}.cancel`
      const stderrDecoder=new StringDecoder('utf8')
      const abort=()=>{try{fs.writeFileSync(cancelPath,'cancel\n',{flag:'wx',mode:0o600})}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')child.kill()}}
      options.signal?.addEventListener('abort',abort,{once:true})
      const command={op:'start',id,jobName,file:candidate,args,cwd:options.cwd,env,input:Buffer.from(options.input??'').toString('base64'),timeoutMs:options.timeoutMs??30_000,maxBytes:options.maxBytes??16*1024*1024,cancelPath,streamStderr:!!options.onStderr}
      let reply:Reply
      try {
        // Admission happens before an asynchronous queue. Check the captured
        // binding and physical lease again before the native writer is admitted.
        beforeDispatch?.()
        const response=new Promise<Reply>((resolve,reject)=>{pending={id,resolve,reject,onStderr:options.onStderr?(data)=>options.onStderr?.(stderrDecoder.write(Buffer.from(data,'base64'))):undefined}})
        child.stdin.write(JSON.stringify(command)+'\n',(error)=>{if(error){pending?.reject(error);pending=undefined}})
        if(options.signal?.aborted)abort()
        reply=await response
        const tail=stderrDecoder.end();if(tail)try{options.onStderr?.(tail)}catch{/* The progress observer is optional. */}
      } finally {options.signal?.removeEventListener('abort',abort);try{fs.rmSync(cancelPath,{force:true})}catch{/* A retained marker is diagnostic evidence, never a release certificate. */}}
      if(!reply.audit?.empty || reply.audit.activeProcesses!==0) throw new Error('Git descendant cleanup could not be verified; repository remains quarantined')
      audits.push(reply.audit)
      const out=Buffer.from(reply.stdout??'','base64').toString('utf8'),err=Buffer.from(reply.stderr??'','base64').toString('utf8')
      if(reply.failure || reply.exitCode!==0) {
        const problem=new Error(reply.failure || err.trim() || `Git exited with ${reply.exitCode}`)
        Object.assign(problem,{stdout:out,stderr:err,killed:!!reply.failure,cmd:`git ${args.join(' ')}`,code:reply.failure==='cancelled'?'ABORT_ERR':reply.failure==='timeout'?'ETIMEDOUT':reply.failure==='output-limit'?'GIT_OUTPUT_LIMIT':reply.exitCode})
        throw problem
      }
      return out
      }
      const result=queue.then(execute)
      queue=result.then(()=>undefined,()=>undefined)
      return result
    },
    close() {
      if(closePromise)return closePromise
      closing=true
      closePromise=(async()=>{
      await queue
      if(!closed) child.stdin.end(JSON.stringify({op:'close'})+'\n')
      const deadline=setTimeout(()=>child.kill(),12_000)
      let completionDeadline: ReturnType<typeof setTimeout> | undefined
      await Promise.race([exited,new Promise<void>((_,reject)=>{completionDeadline=setTimeout(()=>reject(new Error('Git supervisor exit was not confirmed')),15_000)})]).finally(()=>{clearTimeout(deadline);clearTimeout(completionDeadline)})
      const final=auditRepositoryJob(jobName,owner,supervisor)
      if(final.jobExists || final.supervisorAlive || !final.empty) throw new Error('Git process group remains unverified; repository lease is retained')
      const receiptStat=fs.lstatSync(receipt)
      if(receiptStat.isSymbolicLink() || receiptStat.size>16*1024)throw new Error('Native Git closure receipt is untrusted')
      const closure:unknown=JSON.parse(fs.readFileSync(receipt,'utf8'))
      if(!closure || typeof closure!=='object')throw new Error('Native Git closure receipt is invalid')
      const proof=closure as {protocol?:string;jobName?:string;ownerPid?:number;ownerBirth?:string;supervisorPid?:number;supervisorBirth?:string;activeProcesses?:number}
      if(proof.protocol!=='windows-job-v1' || proof.jobName!==jobName || proof.ownerPid!==owner.pid || proof.ownerBirth!==owner.birth || proof.supervisorPid!==supervisor.pid || proof.supervisorBirth!==supervisor.birth || proof.activeProcesses!==0)throw new Error('Native Git closure does not certify this scope')
      // A fatal/native crash can still close its kill-on-close job. OS audit,
      // rather than the protocol acknowledgement alone, decides release.
      if(!acknowledgedClose && audits.length) diagnostic += '\nSupervisor closed without ACK; OS job absence was independently confirmed.'
      })()
      return closePromise
    }
  }
  return scope
}
