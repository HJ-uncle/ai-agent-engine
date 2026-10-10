import test from 'node:test'
import assert from 'node:assert/strict'
import { qualifiedDevelopmentStart } from './continuation-driver.mjs'
test('six-hour qualified development clock excludes prior audits, failure and recovered work',()=>{
  const round={kind:'development',success:true,rootRun:{createdAt:1000},development:{recoveryCompletion:false}}
  for(const changed of [{...round,kind:'retained-audit'},{...round,success:false},{...round,development:{recoveryCompletion:true}},{...round,development:{freshEligible:false}},{...round,rootRun:{}}])assert.equal(qualifiedDevelopmentStart(null,changed),null)
  const first=qualifiedDevelopmentStart(null,round);assert.equal(first,new Date(1000).toISOString())
  assert.equal(qualifiedDevelopmentStart(first,{...round,rootRun:{createdAt:2000}}),first)
  assert.equal(qualifiedDevelopmentStart(first,{...round,rootRun:{createdAt:500}}),new Date(500).toISOString())
})
