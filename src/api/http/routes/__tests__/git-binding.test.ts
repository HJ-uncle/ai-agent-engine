/** Actual binding epoch/CAS, Git side effects, blocking hook and new-process oracle. */
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import Fastify, { type FastifyInstance } from 'fastify'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { WorkspaceManager } from '../../../../workspace/manager.js'
import { acquireResourceLease } from '../../../../workspace/binding-lease.js'
import { gitRoutes } from '../git.js'

const holder = vi.hoisted(() => ({ manager: undefined as WorkspaceManager | undefined }))
vi.mock('../../../../workspace/index.js', () => ({ workspaceManager: {
  getBindingSnapshot: (...args: Parameters<WorkspaceManager['getBindingSnapshot']>) => holder.manager!.getBindingSnapshot(...args),
  withBindingLease: (...args: Parameters<WorkspaceManager['withBindingLease']>) => holder.manager!.withBindingLease(...args),
  getWorkingDirectory: (...args: Parameters<WorkspaceManager['getWorkingDirectory']>) => holder.manager!.getWorkingDirectory(...args),
  resolveSafePath: (...args: Parameters<WorkspaceManager['resolveSafePath']>) => holder.manager!.resolveSafePath(...args)
} }))
let fixture: string, a: string, b: string, state: string, app: FastifyInstance
const ctx = (sessionId = 'session') => ({ tenantId: 'default', sessionId })
const env = () => Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^GIT_/i.test(name)))
function git(cwd: string, args: string[]) { return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: env(), windowsHide: true }) }
function init(cwd: string) { fs.mkdirSync(cwd, { recursive: true }); git(cwd, ['init','-b','main']); git(cwd,['config','user.name','Fixture']); git(cwd,['config','user.email','fixture@example.invalid']); git(cwd,['config','commit.gpgSign','false']); git(cwd,['config','core.autocrlf','false']); fs.writeFileSync(path.join(cwd,'tracked.txt'),'initial\n');git(cwd,['add','-A']);git(cwd,['commit','-m','initial']) }
async function mutation(op: string, fields: Record<string,unknown> = {}, sessionId = 'session') { const snapshot=holder.manager!.getBindingSnapshot(ctx(sessionId));return (await app.inject({method:'POST',url:'/git/action',payload:{sessionId,expectedRoot:snapshot.root,bindingEpoch:snapshot.epoch,op,...fields}})).json() }
function newProcess(script: string) {
  const managerUrl=pathToFileURL(path.join(process.env.AETHER_GIT_TEST_COMPILED_ROOT ?? path.resolve('../owned-compiled'),'workspace/manager.js')).href
  const result=spawnSync(process.execPath,['--input-type=module','--eval',`import {WorkspaceManager} from ${JSON.stringify(managerUrl)};const m=new WorkspaceManager(process.env.WORKSPACE_ROOT),ctx={tenantId:'default',sessionId:'session'};${script}`],{cwd:path.resolve('.'),env:env(),encoding:'utf8',windowsHide:true,timeout:15000})
  expect(result.error).toBeUndefined();expect(result.status,result.stderr).toBe(0);return JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1)!)
}
beforeEach(async()=>{
  fixture=path.resolve('.e2e-tmp','git-binding-'+randomUUID());const privateRoot=path.join(fixture,'private'),projects=path.join(fixture,'projects');a=path.join(projects,'a');b=path.join(projects,'b');state=path.join(fixture,'state','bindings.json');fs.mkdirSync(privateRoot,{recursive:true});init(a);init(b)
  vi.stubEnv('WORKSPACE_ROOT',privateRoot);vi.stubEnv('AETHER_ALLOWED_WORKSPACE_ROOTS',projects);vi.stubEnv('AETHER_WORKSPACE_BINDINGS_FILE',state);vi.stubEnv('AUTH_ENABLED','true')
  holder.manager=new WorkspaceManager(privateRoot);holder.manager.bind(ctx(),a);app=Fastify();await app.register(gitRoutes);await app.ready()
})
afterEach(async()=>{
  await app.close();vi.restoreAllMocks();vi.unstubAllEnvs()
  if(!fixture.startsWith(path.resolve('.e2e-tmp')+path.sep)||!path.basename(fixture).startsWith('git-binding-'))throw new Error('Unsafe fixture cleanup')
  fs.rmSync(fixture,{recursive:true,force:true})
})
it('binding capability returns a trusted canonical root and persistent epoch in another process',async()=>{
  const response=(await app.inject({method:'GET',url:'/git/binding?sessionId=session'})).json();const snapshot=holder.manager!.getBindingSnapshot(ctx())
  expect(response.data).toEqual({...snapshot,contractVersion:2,mutationRequiresBinding:true});expect(fs.realpathSync(a)).toBe(snapshot.root)
  const remote=newProcess('console.log(JSON.stringify({pid:process.pid,...m.getBindingSnapshot(ctx)}))');expect(remote.pid).not.toBe(process.pid);expect(remote.root).toBe(snapshot.root);expect(remote.epoch).toBe(snapshot.epoch)
})
it('missing or forged binding CAS refuses mutation with exact index bytes untouched',async()=>{
  fs.writeFileSync(path.join(a,'tracked.txt'),'edit\n');const before=fs.readFileSync(path.join(a,'.git/index'))
  for(const fields of [{}, {expectedRoot:fs.realpathSync(a),bindingEpoch:'forged'}, {expectedRoot:fs.realpathSync(b),bindingEpoch:holder.manager!.getBindingSnapshot(ctx()).epoch}]) {
    const result=(await app.inject({method:'POST',url:'/git/action',payload:{sessionId:'session',op:'stage',path:'tracked.txt',...fields}})).json();expect(result.code).not.toBe(200)
  }
  expect(fs.readFileSync(path.join(a,'.git/index'))).toEqual(before);expect(git(a,['diff','--cached'])).toBe('')
})
it('A→B→A epoch invalidates the original task snapshot without mutating either repository',async()=>{
  const snapshot=holder.manager!.getBindingSnapshot(ctx());const beforeA=fs.readFileSync(path.join(a,'.git/index')),beforeB=fs.readFileSync(path.join(b,'.git/index'));fs.writeFileSync(path.join(a,'tracked.txt'),'edit\n')
  holder.manager!.bind(ctx(),b);holder.manager!.bind(ctx(),a);expect(holder.manager!.getBindingSnapshot(ctx()).epoch).not.toBe(snapshot.epoch)
  const result=await mutation('stage',{path:'tracked.txt',expectedRoot:snapshot.root,bindingEpoch:snapshot.epoch});expect(result.code).not.toBe(200);expect(result.message).toContain('binding changed')
  expect(fs.readFileSync(path.join(a,'.git/index'))).toEqual(beforeA);expect(fs.readFileSync(path.join(b,'.git/index'))).toEqual(beforeB)
  expect((await mutation('stage',{path:'tracked.txt'})).data.success).toBe(true)
})
it('external epoch replacement during asynchronous repository resolution is rejected before Git dispatch',async()=>{
  fs.writeFileSync(path.join(a,'tracked.txt'),'edit\n');const before=fs.readFileSync(path.join(a,'.git/index')),manager=holder.manager!,resolve=manager.resolveSafePath.bind(manager)
  vi.spyOn(manager,'resolveSafePath').mockImplementation((owner,file)=>{const result=resolve(owner,file),stored=JSON.parse(fs.readFileSync(state,'utf8'));stored.bindings[0].epoch=randomUUID();fs.writeFileSync(state,JSON.stringify(stored)+'\n');return result})
  const result=await mutation('stage',{path:'tracked.txt'});expect(result.code).not.toBe(200);expect(result.message).toContain('before dispatch');expect(fs.readFileSync(path.join(a,'.git/index'))).toEqual(before)
})
it('actual Git child holds session and physical repository through close; other repositories proceed',async()=>{
  const manager=holder.manager!;manager.bind(ctx('peer'),a);manager.bind(ctx('independent'),b)
  const marker=path.join(fixture,'hook-started'),release=path.join(fixture,'hook-release'),hookScript=path.join(fixture,'hook-wait.cjs')
  fs.writeFileSync(hookScript,`const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(marker)},String(process.pid));const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)})){clearInterval(timer);process.exit(0)}},20);setTimeout(()=>{clearInterval(timer);process.exit(2)},20000);`)
  const shellQuote=(value:string)=>"'"+value.replaceAll("'","'\\''")+"'"
  fs.writeFileSync(path.join(a,'.git/hooks/pre-commit'),`#!/bin/sh\n${shellQuote(process.execPath.replaceAll('\\','/'))} ${shellQuote(hookScript.replaceAll('\\','/'))}\n`,{mode:0o755})
  fs.writeFileSync(path.join(a,'tracked.txt'),'commit edit\n');git(a,['add','tracked.txt']);const running=mutation('commit',{message:'held commit'})
  try {
    await vi.waitFor(()=>expect(fs.existsSync(marker)).toBe(true),{timeout:10000,interval:20})
    expect(()=>new WorkspaceManager(process.env.WORKSPACE_ROOT).bind(ctx(),b)).toThrow(/busy/)
    const rejected=newProcess(`try{m.bind(ctx,${JSON.stringify(b)});console.log(JSON.stringify({bound:true}))}catch(e){console.log(JSON.stringify({bound:false,message:e.message}))}`);expect(rejected.bound).toBe(false);expect(rejected.message).toContain('busy')
    fs.writeFileSync(path.join(a,'peer.txt'),'must not stage\n');const before=fs.readFileSync(path.join(a,'.git/index'))
    const peer=await mutation('stage',{path:'peer.txt'},'peer');expect(peer.code).not.toBe(200);expect(peer.message).toContain('Git repository');expect(fs.readFileSync(path.join(a,'.git/index'))).toEqual(before)
    fs.writeFileSync(path.join(b,'independent.txt'),'independent\n');expect((await mutation('stage',{path:'independent.txt'},'independent')).data.success).toBe(true);expect(git(b,['show',':0:independent.txt'])).toBe('independent\n')
  } finally {fs.writeFileSync(release,'release');await running}
  expect(git(a,['log','-1','--format=%s']).trim()).toBe('held commit');expect(manager.bind(ctx(),b)).toBe(fs.realpathSync(b))
  expect((await mutation('stage',{path:'peer.txt'},'peer')).data.success).toBe(true)
},40000)
it('generation mismatch never releases a newer lease; orphan diagnostics retain the file',()=>{
  const file=path.join(fixture,'diagnostic.lock'),held=acquireResourceLease(file,'test resource',ctx());const replacement={...held.owner,generation:randomUUID()};fs.writeFileSync(file,JSON.stringify(replacement)+'\n')
  expect(()=>held.release()).toThrow(/ownership changed/);expect(JSON.parse(fs.readFileSync(file,'utf8')).generation).toBe(replacement.generation)
  expect(()=>acquireResourceLease(file,'test resource',ctx())).toThrow(new RegExp(replacement.generation));expect(fs.existsSync(file)).toBe(true)
})
it('verified Git recovery retains a stale binding lease from another session',()=>{
  const manager=holder.manager!, expected=manager.getBindingSnapshot(ctx()), external=ctx('other-session')
  const leaseFile=(manager as unknown as { sessionLeaseFile(context: { tenantId:string; sessionId:string }): string }).sessionLeaseFile.bind(manager)
  const file=leaseFile(external)
  const held=acquireResourceLease(file,'workspace session',external)
  try {
    const retained=manager.recoverInterruptedGitBinding(ctx(),expected,{file,generation:held.owner.generation,pid:held.owner.pid,root:expected.root,epoch:expected.epoch},held.owner.pid)
    expect(retained).toBe(false)
    expect(fs.existsSync(file)).toBe(true)
    expect(JSON.parse(fs.readFileSync(file,'utf8')).generation).toBe(held.owner.generation)
  } finally { held.release() }
})
it('verified Git recovery retains a newer lease replacing the interrupted generation',()=>{
  const manager=holder.manager!, expected=manager.getBindingSnapshot(ctx())
  const leaseFile=(manager as unknown as { sessionLeaseFile(context: { tenantId:string; sessionId:string }): string }).sessionLeaseFile.bind(manager)
  const file=leaseFile(ctx()), held=acquireResourceLease(file,'workspace session',ctx())
  try {
    const retained=manager.recoverInterruptedGitBinding(ctx(),expected,{file,generation:randomUUID(),pid:held.owner.pid,root:expected.root,epoch:expected.epoch},held.owner.pid)
    expect(retained).toBe(false)
    expect(fs.existsSync(file)).toBe(true)
  } finally { held.release() }
})
it('parallel status and branch reads queue without losing their binding or leaking a lock',async()=>{
  const snapshot=holder.manager!.getBindingSnapshot(ctx()),query=new URLSearchParams({sessionId:'session',expectedRoot:snapshot.root,bindingEpoch:snapshot.epoch})
  const [status,branch]=await Promise.all(['status','branch-info'].map(op=>app.inject({method:'GET',url:'/git/'+op+'?'+query})))
  expect(status.json()).toMatchObject({code:200,data:{isRepo:true}});expect(branch.json()).toMatchObject({code:200,data:{info:{branch:'main'}}})
  expect(holder.manager!.bind(ctx(),b)).toBe(fs.realpathSync(b));expect(fs.existsSync(path.join(a,'.git/.aether-operation.lock'))).toBe(false)
})
