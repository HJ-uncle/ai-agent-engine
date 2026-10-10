import {test} from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {prepare} from './prepare-r4-profile.mjs'
import {expectedContractTests,protectedEvidence,verifyProtectedEvidence} from './project-driver.mjs'

function fixture(){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'aether-r4-profile-'))
  const projects=[{id:'ops-board',roles:['ops-domain','ops-view','ops-storage']},{id:'ledger-api',roles:['ledger-domain','ledger-api']}].map(p=>({id:p.id,path:path.join(root,p.id),roles:p.roles.map(id=>({id,allowedFiles:['src/'+id+'.mjs'],stages:Array.from({length:10},(_,i)=>({index:i+1,title:'stage',dependencies:[{role:'old',stage:1}]}))}))}))
  for(const project of projects){
    fs.mkdirSync(path.join(project.path,'tests'),{recursive:true});fs.mkdirSync(path.join(project.path,'contracts'))
    fs.writeFileSync(path.join(project.path,'contracts/r4.md'),'protected contract')
    fs.writeFileSync(path.join(project.path,'tests/old-test.mjs'),'check(1,"old",f);check(10,"retained",f);')
    for(const name of ['domain','view','storage','api'])fs.writeFileSync(path.join(project.path,'tests/r4-'+name+'-test.mjs'),'// baseline-contract: tests/old-test.mjs 10\ncheck(1,"new",f);check(10,"final",f);')
  }
  const manifest={projects,protectedPaths:[]};fs.writeFileSync(path.join(root,'manifest.json'),JSON.stringify(manifest));return {root,manifest}
}
test('R4 preparation preserves original manifest, derives counts, keeps all five S1 independent and protects profile integrations',()=>{
  const {root}=fixture(),original=fs.readFileSync(path.join(root,'manifest.json'))
  const out=prepare(root),manifest=JSON.parse(fs.readFileSync(out.filename))
  assert.deepEqual(fs.readFileSync(path.join(root,'manifest.json')),original)
  const roles=manifest.projects.flatMap(p=>p.roles)
  assert.equal(roles.length,5);assert.ok(roles.every(r=>r.requiresDevelopment&&r.stages[0].dependencies.length===0))
  const domain=roles.find(r=>r.id==='ledger-domain'),api=roles.find(r=>r.id==='ledger-api')
  assert.match(domain.stages[3].prompt,/有效无变化盘点也必须产生一个新 revision/)
  assert.deepEqual(api.stages.slice(1).map(s=>s.dependencies[0].stage),[1,3,3,4,5,6,5,7,10])
  assert.deepEqual(out.counts.map(p=>p.integration),[12,8])
  assert.ok(out.counts.every(p=>p.roles.every(r=>r.first===3&&r.final===4)))
  const protectedFiles=protectedEvidence(root,manifest,out.filename)
  assert.ok(protectedFiles.files.has(out.filename));assert.ok(protectedFiles.files.has(path.join(root,'manifest.json')))
  assert.deepEqual(verifyProtectedEvidence(protectedFiles),[])
  fs.appendFileSync(out.filename,' ');assert.ok(verifyProtectedEvidence(protectedFiles).some(v=>v.file===out.filename))
})
test('missing contracts, missing runner and escaping project path fail before any profile/integration mutation',()=>{
  for(const mutation of [
    f=>fs.unlinkSync(path.join(f.manifest.projects[1].path,'contracts/r4.md')),
    f=>fs.unlinkSync(path.join(f.manifest.projects[1].path,'tests/r4-api-test.mjs')),
    f=>{f.manifest.projects[0].path=path.dirname(f.root);fs.writeFileSync(path.join(f.root,'manifest.json'),JSON.stringify(f.manifest))},
  ]){
    const f=fixture();mutation(f);assert.throws(()=>prepare(f.root))
    assert.equal(fs.existsSync(path.join(f.root,'manifest-r4.json')),false)
    assert.ok(f.manifest.projects.every(p=>!fs.existsSync(path.join(p.path,'tests/r4-integration.mjs'))))
  }
})
test('baseline inheritance rejects cycles and path escape instead of accepting an arbitrary test count',()=>{
  const {root,manifest}=fixture(),workspace=manifest.projects[0].path,file=path.join(workspace,'tests/r4-domain-test.mjs')
  fs.writeFileSync(file,'// baseline-contract: tests/r4-domain-test.mjs 10\ncheck(1,"new",f);')
  assert.throws(()=>expectedContractTests(workspace,{args:['tests/r4-domain-test.mjs','1']}),/Cyclic/)
  fs.writeFileSync(file,'// baseline-contract: ../outside.mjs 10\ncheck(1,"new",f);')
  assert.throws(()=>expectedContractTests(workspace,{args:['tests/r4-domain-test.mjs','1']}),/Missing baseline/)
})
