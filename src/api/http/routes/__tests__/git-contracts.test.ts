/** Actual Git/Fastify oracle: versions, hunk side effects, conflicts, scope. */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import Fastify, { type FastifyInstance } from 'fastify'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { gitRoutes } from '../git.js'
const scope = vi.hoisted(() => ({ base: '' }))
vi.mock('../../../../workspace/index.js', () => ({ workspaceManager: {
  getWorkingDirectory: (owner: { sessionId: string }) => owner.sessionId === 'session' ? scope.base : path.join(scope.base, 'other-owner'),
  getBindingSnapshot: (owner: { sessionId: string }) => ({ root: owner.sessionId === 'session' ? scope.base : path.join(scope.base, 'other-owner'), epoch: 'fixture-epoch' }),
  withBindingLease: async (owner: { sessionId: string }, _expected: unknown, action: (lease: { snapshot: { root: string; epoch: string }; assertCurrent(): void }) => Promise<unknown>) => action({ snapshot: { root: owner.sessionId === 'session' ? scope.base : path.join(scope.base, 'other-owner'), epoch: 'fixture-epoch' }, assertCurrent() {} }),
  resolveSafePath: (owner: { sessionId: string }, name: string) => path.resolve(owner.sessionId === 'session' ? scope.base : path.join(scope.base, 'other-owner'), name)
} }))
let app: FastifyInstance
let fixture: string
const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^GIT_/i.test(name)))
function git(args: string[], cwd = scope.base): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: cleanEnv(), windowsHide: true })
}
function write(file: string, content: string | Buffer): void { fs.mkdirSync(path.dirname(path.join(scope.base,file)),{recursive:true}); fs.writeFileSync(path.join(scope.base,file),content) }
function commit(message: string, author = 'Fixture'): void { git(['add','-A']); git(['-c',`user.name=${author}`,'-c',`user.email=${author}@example.invalid`,'-c','commit.gpgSign=false','commit','-m',message]) }
const baseText = () => Array.from({length:35},(_,index)=>`line ${index+1}`).join('\n')+'\n'
async function query(op: string, values: Record<string,string> = {}) { return (await app.inject({method:'GET',url:'/git/'+op+'?'+new URLSearchParams({sessionId:'session',...values})})).json() }
async function action(op: string, values: Record<string,unknown>) { return (await app.inject({method:'POST',url:'/git/action',payload:{sessionId:'session',expectedRoot:scope.base,bindingEpoch:'fixture-epoch',op,...values}})).json() }
beforeEach(async () => {
  fixture=path.resolve('.e2e-tmp','git-contracts-'+randomUUID()); scope.base=path.join(fixture,'session')
  fs.mkdirSync(scope.base,{recursive:true});git(['init','-b','main']);git(['config','core.autocrlf','false']);git(['config','user.name','Fixture']);git(['config','user.email','Fixture@example.invalid']);git(['config','commit.gpgSign','false'])
  write('file with space.txt',baseText());commit('initial')
  app=Fastify();await app.register(gitRoutes);await app.ready()
})
afterEach(async () => {
  await app.close()
  if (!fixture.startsWith(path.resolve('.e2e-tmp')+path.sep)||!path.basename(fixture).startsWith('git-contracts-')) throw new Error('Unsafe fixture cleanup')
  fs.rmSync(fixture,{recursive:true,force:true})
})
it('staged diff is HEAD→index while unstaged is index→worktree',async()=>{
  const head=baseText();const index=head.replace('line 2\n','INDEX second\n');const work=index.replace('line 30\n','WORK thirty\n')
  write('file with space.txt',index);git(['add','--','file with space.txt']);write('file with space.txt',work)
  const staged=await query('diff',{path:'file with space.txt',staged:'true'});const unstaged=await query('diff',{path:'file with space.txt',staged:'false'})
  expect(staged.code).toBe(200);expect(staged.data.diff).toMatchObject({oldContent:head,newContent:index})
  expect(unstaged.data.diff).toMatchObject({oldContent:index,newContent:work})
  expect(staged.data.diff.newContent).toBe(git(['show',':0:file with space.txt']))
  expect(staged.data.diff.newContent).not.toBe(fs.readFileSync(path.join(scope.base,'file with space.txt'),'utf8'))
})
it('separates actual hunks with accurate old/new line numbers',async()=>{
  write('file with space.txt',baseText().replace('line 2\n','changed second\n').replace('line 30\n','changed thirty\n'))
  const result=await query('diff',{path:'file with space.txt',staged:'false'});const hunks=result.data.diff.hunks
  expect(hunks).toHaveLength(2);expect(hunks[0].id).not.toBe(hunks[1].id)
  expect(hunks[0].lines).toContainEqual({type:'delete',oldLineNumber:2,newLineNumber:null,content:'line 2'})
  expect(hunks[1].lines).toContainEqual({type:'add',oldLineNumber:null,newLineNumber:30,content:'changed thirty'})
  expect(hunks.flatMap((h:{lines:Array<{content:string}>})=>h.lines).some((l:{content:string})=>/^iff --git|^@@|^-- a\//.test(l.content))).toBe(false)
})
it('discards only selected worktree hunk and leaves index untouched',async()=>{
  const changed=baseText().replace('line 2\n','changed second\n').replace('line 30\n','changed thirty\n');write('file with space.txt',changed)
  const before=fs.readFileSync(path.join(scope.base,'.git/index'));const diff=await query('diff',{path:'file with space.txt'})
  expect((await action('discard-hunk',{path:'file with space.txt',hunkId:diff.data.diff.hunks[0].id})).data.success).toBe(true)
  expect(fs.readFileSync(path.join(scope.base,'file with space.txt'),'utf8')).toBe(baseText().replace('line 30\n','changed thirty\n'))
  expect(fs.readFileSync(path.join(scope.base,'.git/index')).equals(before)).toBe(true)
})
it('stage and unstage selected hunks mutate index while retaining entire worktree',async()=>{
  const changed=baseText().replace('line 2\n','changed second\n').replace('line 30\n','changed thirty\n');write('file with space.txt',changed)
  const diff=await query('diff',{path:'file with space.txt'});expect((await action('stage-hunk',{path:'file with space.txt',hunkId:diff.data.diff.hunks[0].id})).data.success).toBe(true)
  expect(git(['show',':0:file with space.txt'])).toBe(baseText().replace('line 2\n','changed second\n'))
  expect(fs.readFileSync(path.join(scope.base,'file with space.txt'),'utf8')).toBe(changed)
  const staged=await query('diff',{path:'file with space.txt',staged:'true'});expect((await action('unstage-hunk',{path:'file with space.txt',hunkId:staged.data.diff.hunks[0].id})).data.success).toBe(true)
  expect(git(['show',':0:file with space.txt'])).toBe(baseText());expect(fs.readFileSync(path.join(scope.base,'file with space.txt'),'utf8')).toBe(changed)
})
it('rejects stale hunk ids with no index/worktree mutation',async()=>{
  write('file with space.txt',baseText().replace('line 2\n','changed\n'));const diff=await query('diff',{path:'file with space.txt'});write('file with space.txt',baseText().replace('line 2\n','newer\n'))
  const before=fs.readFileSync(path.join(scope.base,'.git/index'));const result=await action('stage-hunk',{path:'file with space.txt',hunkId:diff.data.diff.hunks[0].id})
  expect(result.code).not.toBe(200);expect(result.message).toContain('已变化');expect(git(['diff','--cached'])).toBe('');expect(fs.readFileSync(path.join(scope.base,'.git/index')).equals(before)).toBe(true)
})
it('nested cwd uses correct root-relative blobs and patch paths',async()=>{
  write('nested/child.txt',baseText());commit('nested');write('nested/child.txt',baseText().replace('line 2\n','nested edit\n'))
  const diff=await query('diff',{cwd:'nested',path:'child.txt'});expect(diff.data.diff.oldContent).toBe(baseText())
  expect((await action('stage-hunk',{cwd:'nested',path:'child.txt',hunkId:diff.data.diff.hunks[0].id})).data.success).toBe(true)
  expect(git(['show',':0:nested/child.txt'])).toContain('nested edit')
})
it('reports actual merge state, conflict and message; abort clears merge state',async()=>{
  git(['checkout','-b','side']);write('file with space.txt','side\n');commit('side change');git(['checkout','main']);write('file with space.txt','main\n');commit('main change')
  expect(()=>git(['merge','side'])).toThrow()
  const status=await query('status');expect(status.data.merging).toBe(true);expect(status.data.mergeMessage).toContain("Merge branch 'side'");expect(status.data.files).toContainEqual(expect.objectContaining({path:'file with space.txt',conflict:true}))
  expect((await action('merge-abort',{})).data.success).toBe(true);expect((await query('status')).data.merging).toBe(false)
})
it('blame matches committed hash, author, subject and line count',async()=>{
  write('file with space.txt',baseText().replace('line 2\n','by Alice\n'));commit('Alice edit','Alice')
  const result=await query('blame',{path:'file with space.txt'});expect(result.code).toBe(200);expect(result.data.head).toBe(git(['rev-parse','HEAD']).trim());expect(result.data.lines).toHaveLength(35)
  expect(result.data.lines[1]).toMatchObject({hash:result.data.head,author:'Alice',subject:'Alice edit'});expect(result.data.lines[0]).toMatchObject({author:'Fixture',subject:'initial',boundary:true})
})
it('user-name and authors have local-Code-compatible values and sorting',async()=>{
  write('a.txt','a');commit('Alice one','Alice');write('b.txt','b');commit('Alice two','Alice');write('z.txt','z');commit('Zoe one','Zoe')
  expect((await query('user-name')).data).toEqual({success:true,name:'Fixture',email:'Fixture@example.invalid'})
  expect((await query('list-authors')).data).toEqual({success:true,authors:['Alice','Fixture','Zoe']})
})
it('new staged file in unborn repo compares empty HEAD to exact index',async()=>{
  const unborn=path.join(scope.base,'unborn');fs.mkdirSync(unborn);git(['init'],unborn);fs.writeFileSync(path.join(unborn,'new.txt'),'INDEX\n');git(['add','new.txt'],unborn);fs.writeFileSync(path.join(unborn,'new.txt'),'WORK\n')
  const result=await query('diff',{cwd:'unborn',path:'new.txt',staged:'true'});expect(result.code).toBe(200);expect(result.data.diff).toMatchObject({changeType:'added',oldContent:'',newContent:'INDEX\n'})
})
it('binary diff and added/deleted empty contents do not mislabel a tracked empty file',async()=>{
  write('empty.txt','');commit('empty');write('empty.txt','text\n');expect((await query('diff',{path:'empty.txt'})).data.diff.changeType).toBe('modified')
  write('binary.bin',Buffer.from([1,0,2]));commit('binary');write('binary.bin',Buffer.from([1,0,3]));const binary=await query('diff',{path:'binary.bin'});expect(binary.data.diff).toMatchObject({binary:true,hunks:[]})
})
it('new read routes stay under authenticated session and reject path escapes',async()=>{
  expect((await query('blame',{path:'../private.txt'})).code).not.toBe(200)
  expect((await query('blame',{sessionId:'other-owner',path:'file with space.txt'})).code).not.toBe(200)
})
it('partial operations preserve no-final-newline bytes',async()=>{
  write('no-newline.txt','first\nsecond');commit('no newline');write('no-newline.txt','first\nchanged')
  const diff=await query('diff',{path:'no-newline.txt'});expect(diff.data.diff.hunks).toHaveLength(1)
  expect((await action('stage-hunk',{path:'no-newline.txt',hunkId:diff.data.diff.hunks[0].id})).data.success).toBe(true)
  expect(git(['show',':0:no-newline.txt'])).toBe('first\nchanged');expect(fs.readFileSync(path.join(scope.base,'no-newline.txt'),'utf8')).toBe('first\nchanged')
  const staged=await query('diff',{path:'no-newline.txt',staged:'true'});expect((await action('unstage-hunk',{path:'no-newline.txt',hunkId:staged.data.diff.hunks[0].id})).data.success).toBe(true)
  expect(git(['show',':0:no-newline.txt'])).toBe('first\nsecond')
})
it('insertions shift second hunk coordinates and partial stage retains both worktree changes',async()=>{
  const changed=baseText().replace('line 2\n','inserted\nline 2\n').replace('line 30\n','edited thirty\n');write('file with space.txt',changed)
  const diff=await query('diff',{path:'file with space.txt'});expect(diff.data.diff.hunks).toHaveLength(2)
  expect(diff.data.diff.hunks[1].lines).toContainEqual({type:'add',oldLineNumber:null,newLineNumber:31,content:'edited thirty'})
  expect((await action('stage-hunk',{path:'file with space.txt',hunkId:diff.data.diff.hunks[1].id})).data.success).toBe(true)
  expect(git(['show',':0:file with space.txt'])).toBe(baseText().replace('line 30\n','edited thirty\n'))
  expect(fs.readFileSync(path.join(scope.base,'file with space.txt'),'utf8')).toBe(changed)
})
it('staged deletion reads missing index instead of later recreated worktree',async()=>{
  git(['rm','--','file with space.txt']);write('file with space.txt','RECREATED\n')
  const diff=await query('diff',{path:'file with space.txt',staged:'true'});expect(diff.data.diff).toMatchObject({changeType:'deleted',oldContent:baseText(),newContent:''})
  expect((await action('unstage-hunk',{path:'file with space.txt',hunkId:diff.data.diff.hunks[0].id})).data.success).toBe(true)
  expect(git(['show',':0:file with space.txt'])).toBe(baseText());expect(fs.readFileSync(path.join(scope.base,'file with space.txt'),'utf8')).toBe('RECREATED\n')
})
it('unsupported untracked and binary partial staging refuses without staging the whole file',async()=>{
  write('untracked.txt','new\n');write('binary.bin',Buffer.from([1,0,2]));commit('binary base');write('binary.bin',Buffer.from([1,0,3]));write('new-untracked.txt','new\n')
  const before=fs.readFileSync(path.join(scope.base,'.git/index'))
  for(const file of ['new-untracked.txt','binary.bin']) expect((await action('stage-hunk',{path:file,hunkId:'h0'})).code).not.toBe(200)
  expect(fs.readFileSync(path.join(scope.base,'.git/index')).equals(before)).toBe(true);expect(git(['diff','--cached'])).toBe('')
})
