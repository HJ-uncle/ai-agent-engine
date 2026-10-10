import {test} from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {spawn} from 'node:child_process'
import {awaitDriverFinalization} from './driver-finalization.mjs'

function childFixture(){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'aether-driver-finalization-')),file=path.join(root,'driver.mjs'),report=path.join(root,'active-report.json')
  fs.writeFileSync(file,"import fs from 'node:fs';process.stdout.write('ready\\n');setTimeout(()=>{fs.writeFileSync(process.argv[2],JSON.stringify({cancelled:true,reportWritten:true}));process.exitCode=0},350)")
  const child=spawn(process.execPath,[file,report],{windowsHide:true,stdio:['ignore','pipe','pipe']})
  child.closedResult=null;const completion=new Promise(resolve=>child.once('close',(code,signal)=>{child.closedResult={code,signal};resolve(child.closedResult)}))
  const ready=new Promise((resolve,reject)=>{child.stdout.once('data',resolve);child.once('error',reject)})
  return {child,completion,ready,report}
}

test('actual child finishes cancellation/report after model deadline and is awaited before cleanup',async()=>{
  const {child,completion,ready,report}=childFixture();await ready
  const workloadUntil=Date.now()+100,events=[]
  try{
    const result=await awaitDriverFinalization({driver:child,workloadUntil,graceMs:1500,pollMs:10,onGrace:event=>events.push(event)})
    assert.equal(result.usedGrace,true);assert.equal(events.length,1);assert.equal(result.exit.code,0)
    assert.ok(result.endedAt>workloadUntil);assert.ok(result.endedAt<workloadUntil+1500)
    assert.deepEqual(JSON.parse(fs.readFileSync(report,'utf8')),{cancelled:true,reportWritten:true})
    assert.equal((await completion).signal,null)
  }finally{if(!child.closedResult)child.kill()}
})

test('unsettled closing is rejected at the independent bounded grace without starting more work',async()=>{
  const {child,completion,ready,report}=childFixture();await ready
  const start=Date.now(),workloadUntil=start+25,events=[]
  try{
    await assert.rejects(awaitDriverFinalization({driver:child,workloadUntil,graceMs:70,pollMs:5,onGrace:event=>events.push(event)}),/driver-finalization-deadline/)
    assert.equal(events.length,1);assert.equal(child.closedResult,null);assert.equal(fs.existsSync(report),false)
    assert.ok(Date.now()-start>=95);assert.ok(Date.now()-start<300)
  }finally{if(!child.closedResult)child.kill();await completion}
})

test('already completed driver preserves its actual failure and does not enter grace',async()=>{
  const exit={code:2,signal:null},events=[]
  const result=await awaitDriverFinalization({driver:{closedResult:exit},workloadUntil:Date.now()+1000,graceMs:60000,onGrace:event=>events.push(event)})
  assert.deepEqual(result.exit,exit);assert.equal(result.usedGrace,false);assert.deepEqual(events,[])
  await assert.rejects(awaitDriverFinalization({driver:{closedResult:exit},workloadUntil:Date.now()+1000,graceMs:60001}),/bounded/)
})
