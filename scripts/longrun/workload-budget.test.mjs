import {test} from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {spawnSync} from 'node:child_process'
import {workloadBudget, orchestrationBudget} from './workload-budget.mjs'

test('coordinator and driver share explicit 120-minute workload and 20-minute attempts',()=>{
  const coordinator=orchestrationBudget({})
  assert.deepEqual(coordinator,{maxMs:7200000,stageTimeoutMs:1200000,maxAttempts:3,finalizationGraceMs:60000,totalDeadlineMs:8460000})
  const env={LONGRUN_MAX_MS:String(coordinator.maxMs),LONGRUN_STAGE_TIMEOUT_MS:String(coordinator.stageTimeoutMs)}
  assert.deepEqual(workloadBudget(env),{maxMs:7200000,stageTimeoutMs:1200000,maxAttempts:3})
  assert.deepEqual(orchestrationBudget({LONGRUN_MAX_MINUTES:'60',LONGRUN_STAGE_TIMEOUT_MS:'480000'}),{maxMs:3600000,stageTimeoutMs:480000,maxAttempts:3,finalizationGraceMs:60000,totalDeadlineMs:4860000})
})

test('invalid duration configurations fail rather than yielding endless or overflowed timers',()=>{
  for(const value of ['0','-1','NaN','Infinity','-Infinity','no-time','999999999999']){
    assert.throws(()=>orchestrationBudget({LONGRUN_MAX_MINUTES:value}))
    assert.throws(()=>orchestrationBudget({LONGRUN_STAGE_TIMEOUT_MS:value}))
    assert.throws(()=>workloadBudget({LONGRUN_MAX_MS:value}))
  }
  assert.throws(()=>workloadBudget({LONGRUN_STAGE_TIMEOUT_MS:'0.5'}),/positive Node timer/)
  assert.throws(()=>orchestrationBudget({LONGRUN_MAX_MINUTES:String(2147483647/60000)}),/totalDeadlineMs/)
})

test('real orchestrator rejects NaN or Infinity before creating a run directory or starting processes',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'aether-budget-rejection-'))
  for(const invalid of [{LONGRUN_MAX_MINUTES:'NaN'},{LONGRUN_STAGE_TIMEOUT_MS:'Infinity'}]){
    const out=spawnSync(process.execPath,['scripts/longrun/orchestrate.mjs'],{cwd:path.resolve('.'),env:{...process.env,LONGRUN_PROJECT_ROOT:root,...invalid},encoding:'utf8',windowsHide:true,timeout:10000})
    assert.equal(out.status,1);assert.match(out.stderr,/finite positive duration/);assert.deepEqual(fs.readdirSync(root),[])
  }
})

test('real coordinator writes concrete budget evidence even when missing test assets stop startup',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'aether-budget-evidence-'))
  const expected=orchestrationBudget({LONGRUN_MAX_MINUTES:'120',LONGRUN_STAGE_TIMEOUT_MS:'1200000'})
  const out=spawnSync(process.execPath,['scripts/longrun/orchestrate.mjs'],{cwd:path.resolve('.'),env:{...process.env,LONGRUN_PROJECT_ROOT:root,LONGRUN_MODEL_DB:path.join(root,'missing.db'),LONGRUN_ENGINE_ROOT:path.join(root,'missing-engine'),LONGRUN_MAX_MINUTES:'120',LONGRUN_STAGE_TIMEOUT_MS:'1200000'},encoding:'utf8',windowsHide:true,timeout:20000})
  assert.equal(out.status,2,out.stderr)
  const result=JSON.parse(out.stdout.trim().split(/\r?\n/).at(-1)),runRoot=result.root
  const recorded=JSON.parse(fs.readFileSync(path.join(runRoot,'test-budget.json'),'utf8'))
  const final=JSON.parse(fs.readFileSync(path.join(runRoot,'orchestrator-result.json'),'utf8'))
  const {at,...actual}=recorded;assert.ok(at);assert.deepEqual(actual,expected);assert.deepEqual(final.budget,expected)
  assert.equal(final.engineExit,null);assert.equal(final.driverExit,null);assert.equal(final.monitorExit,null)
  assert.ok(fs.readFileSync(path.join(runRoot,'orchestrator-errors.jsonl'),'utf8').includes('required-file-missing'))
})
