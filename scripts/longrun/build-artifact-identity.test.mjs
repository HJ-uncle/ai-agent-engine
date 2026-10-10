import {test} from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {captureBuildArtifacts,compareBuildArtifacts} from './build-artifact-identity.mjs'
import {applyNodePtyPatch,receiptName} from '../apply-node-pty-patch.mjs'

function fixture({pty=true}={}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'aether-build-identity-'))
  const write=(relative,contents)=>{const file=path.join(root,relative);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,contents)}
  write('dist/main.js','export const built = true')
  write('dist/runtime/build-manifest.json',JSON.stringify({buildId:'fixture-build'}))
  write('dist/storage/sqlite/db.js','export const sqlite=true')
  write('dist/storage/sqlite/__tests__/db.test.js','excluded test')
  if(pty){
    write('node_modules/node-pty/package.json',JSON.stringify({name:'node-pty',version:'1.1.0'}))
    write('node_modules/node-pty/lib/windowsPtyAgent.js','exports.patched=true')
    write('node_modules/node-pty/lib/worker/reader.mjs','export const reader=true')
    write('node_modules/node-pty/lib/shared/events.cjs','exports.events=true')
    write('node_modules/node-pty/prebuilds/win32-x64/pty.node',Buffer.from([0,1,2,3]))
    write('node_modules/node-pty/prebuilds/win32-x64/conpty.dll',Buffer.from([4,5,6,7]))
    write('node_modules/node-pty/lib/windowsPtyAgent.test.js','excluded test')
    write('node_modules/node-pty/lib/windowsPtyAgent.js.map','excluded sourcemap')
    write('node_modules/node-pty/typings/node-pty.d.ts','excluded declaration')
    write('node_modules/node-pty/test/fixture.js','excluded test directory')
  }
  return {root,write}
}

test('node-pty captures sorted production JS, native binaries and package identity only',()=>{
  const {root}=fixture(),out=captureBuildArtifacts(root,{requireNodePty:true})
  assert.equal(out.nodePtyProduction.present,true);assert.equal(out.nodePtyProduction.fileCount,6)
  assert.deepEqual(out.nodePtyProduction.files.map(file=>file.path),[
    'node_modules/node-pty/lib/shared/events.cjs','node_modules/node-pty/lib/windowsPtyAgent.js','node_modules/node-pty/lib/worker/reader.mjs',
    'node_modules/node-pty/package.json','node_modules/node-pty/prebuilds/win32-x64/conpty.dll','node_modules/node-pty/prebuilds/win32-x64/pty.node',
  ])
  assert.ok(out.nodePtyProduction.files.every(file=>/^[a-f0-9]{64}$/.test(file.sha256)))
  assert.equal(compareBuildArtifacts(out,captureBuildArtifacts(root,{requireNodePty:true})).nodePtyCovered,true)
})

test('runtime patches, native bytes, package version and added or missing production files expose drift',()=>{
  for(const [relative,contents]of [
    ['node_modules/node-pty/lib/windowsPtyAgent.js','exports.patched=false'],
    ['node_modules/node-pty/prebuilds/win32-x64/pty.node',Buffer.from([9,9])],
    ['node_modules/node-pty/package.json','{"name":"node-pty","version":"changed"}'],
    ['node_modules/node-pty/lib/new-helper.mjs','export const added=true'],
  ]){
    const {root,write}=fixture(),before=captureBuildArtifacts(root,{requireNodePty:true});write(relative,contents)
    const difference=compareBuildArtifacts(before,captureBuildArtifacts(root,{requireNodePty:true}))
    assert.equal(difference.unchanged,false);assert.ok(difference.changedFiles.some(file=>file.path===relative));assert.notEqual(before.fingerprintSha256,difference.afterFingerprintSha256)
  }
  const {root}=fixture(),before=captureBuildArtifacts(root,{requireNodePty:true})
  fs.unlinkSync(path.join(root,'node_modules/node-pty/lib/worker/reader.mjs'))
  assert.equal(compareBuildArtifacts(before,captureBuildArtifacts(root,{requireNodePty:true})).changedFiles[0].kind,'removed')
})

test('filesystem timestamps and excluded tests/maps/types do not claim content drift',()=>{
  const {root,write}=fixture(),before=captureBuildArtifacts(root,{requireNodePty:true})
  for(const file of [before.main,before.manifest,...before.sqliteProduction.files,...before.nodePtyProduction.files])fs.utimesSync(path.join(root,file.path),new Date(0),new Date(0))
  write('node_modules/node-pty/lib/windowsPtyAgent.test.js','new ignored test')
  write('node_modules/node-pty/lib/windowsPtyAgent.js.map','new ignored map')
  write('node_modules/node-pty/typings/node-pty.d.ts','new ignored types')
  const after=captureBuildArtifacts(root,{requireNodePty:true})
  assert.notEqual(after.nodePtyProduction.files[0].modifiedAt,before.nodePtyProduction.files[0].modifiedAt)
  assert.equal(after.fingerprintSha256,before.fingerprintSha256);assert.equal(compareBuildArtifacts(before,after).unchanged,true)
})

test('every production adapter and prompt byte participates in runtime freeze identity',()=>{
  const {root,write}=fixture()
  write('dist/core/llm-adapter/anthropic.js','export const window=100000')
  write('dist/core/agent-loop/prompt.mjs','export const prompt="frozen"')
  write('dist/core/__tests__/ignored.test.js','ignored')
  const before=captureBuildArtifacts(root)
  write('dist/core/llm-adapter/anthropic.js','export const window=200000')
  write('dist/core/__tests__/ignored.test.js','new ignored')
  const diff=compareBuildArtifacts(before,captureBuildArtifacts(root))
  assert.equal(diff.unchanged,false)
  assert.deepEqual(diff.changedFiles.map(file=>file.path),['dist/core/llm-adapter/anthropic.js'])
  assert.equal(before.runtimeProduction.files.some(file=>file.path.includes('__tests__')),false)
})

test('absence is explicit for fake fixtures while formal captures require a real runtime',()=>{
  const {root}=fixture({pty:false}),absent=captureBuildArtifacts(root)
  assert.deepEqual(absent.nodePtyProduction,{directory:'node_modules/node-pty',present:false,fileCount:0,files:[],sha256:null,patchReceipt:{present:false,valid:false}})
  assert.throws(()=>captureBuildArtifacts(root,{requireNodePty:true}),/required-but-absent/)
  const {root:presentRoot}=fixture(),present=captureBuildArtifacts(presentRoot)
  assert.equal(compareBuildArtifacts(absent,present).nodePtyCoverageChanged,true)
  const legacy={...present};delete legacy.nodePtyProduction
  assert.equal(compareBuildArtifacts(legacy,present).unchanged,false)
  assert.equal(compareBuildArtifacts(legacy,legacy).nodePtyCovered,false)
})

test('formal capture rejects a package missing its native runtime',()=>{
  const {root}=fixture()
  fs.unlinkSync(path.join(root,'node_modules/node-pty/prebuilds/win32-x64/pty.node'))
  fs.unlinkSync(path.join(root,'node_modules/node-pty/prebuilds/win32-x64/conpty.dll'))
  assert.throws(()=>captureBuildArtifacts(root,{requireNodePty:true}),/native-runtime-empty/)
})

function patchedFixture(){
  const out=fixture(),assets=new URL('../patches/node-pty-1.1.0/',import.meta.url),manifest=JSON.parse(fs.readFileSync(new URL('manifest.json',assets),'utf8'))
  out.write('node_modules/node-pty/package.json',fs.readFileSync(new URL('../../node_modules/node-pty/package.json',import.meta.url)))
  for(const entry of manifest.files)out.write('node_modules/node-pty/'+entry.path,fs.readFileSync(new URL(entry.asset,assets)))
  applyNodePtyPatch({packageDir:path.join(out.root,'node_modules/node-pty')})
  return out
}

test('formal patch capture reads deterministic receipt and verifies actual patched JS and typing hashes without writes',()=>{
  const {root}=patchedFixture(),packageDir=path.join(root,'node_modules/node-pty'),receiptPath=path.join(packageDir,receiptName),before=fs.readFileSync(receiptPath)
  const out=captureBuildArtifacts(root,{requireNodePty:true,requireNodePtyPatch:true}),receipt=out.nodePtyProduction.patchReceipt
  assert.equal(receipt.valid,true);assert.equal(receipt.patchId,'aether-system-conpty-close-v1');assert.equal(receipt.verifiedFiles.length,5)
  assert.equal(receipt.file.path,'node_modules/node-pty/.aether-node-pty-patch.json');assert.match(receipt.file.sha256,/^[a-f0-9]{64}$/)
  assert.ok(out.nodePtyProduction.files.some(file=>file.path===receipt.file.path));assert.deepEqual(fs.readFileSync(receiptPath),before)
})

test('missing or forged receipts and drift in declared typing targets prevent formal startup',()=>{
  const {root:absent}=fixture();assert.throws(()=>captureBuildArtifacts(absent,{requireNodePty:true,requireNodePtyPatch:true}),/receipt-required-but-absent/)
  const {root,write}=patchedFixture(),receiptPath=path.join(root,'node_modules/node-pty',receiptName),before=fs.readFileSync(receiptPath)
  const receipt=JSON.parse(before);receipt.patchId='unverified-patch';fs.writeFileSync(receiptPath,JSON.stringify(receipt))
  assert.throws(()=>captureBuildArtifacts(root,{requireNodePty:true,requireNodePtyPatch:true}),/receipt differs/)
  fs.writeFileSync(receiptPath,before);write('node_modules/node-pty/typings/node-pty.d.ts','unexpected typing target')
  assert.throws(()=>captureBuildArtifacts(root,{requireNodePty:true,requireNodePtyPatch:true}),/unknown installed hash/)
})
