import test from 'node:test'
import assert from 'node:assert/strict'
import { developmentEvidence } from './continuation-driver.mjs'

const item={expectedTests:4,baseline:{exitCode:1,testSummary:{complete:true,tests:4,fail:3,skipped:0}}}
const original=[{file:'src/feature.mjs',sha256:'red'}],current=[{file:'src/feature.mjs',sha256:'green'}]
test('partly implemented maintenance work can complete original red contract without inventing a fresh mutation',()=>{
  const result=developmentEvidence(item,current,current,{before:original,evidenceFile:'original.json',evidenceSha256:'known'})
  assert.equal(result.baselineRed,true)
  assert.deepEqual(result.freshChangedOwnedFiles,[])
  assert.deepEqual(result.changedOwnedFiles,['src/feature.mjs'])
  assert.equal(result.recoveryCompletion,true)
})
test('fresh implementation and absent/green baseline cannot masquerade as recovery development',()=>{
  const result=developmentEvidence(item,original,current)
  assert.equal(result.recoveryCompletion,false)
  assert.deepEqual(result.freshChangedOwnedFiles,['src/feature.mjs'])
  assert.equal(developmentEvidence({...item,baseline:{exitCode:0,testSummary:{complete:true,tests:4,fail:0,skipped:0}}},original,current).baselineRed,false)
  assert.equal(developmentEvidence({...item,baseline:undefined},original,current).baselineRed,false)
})
