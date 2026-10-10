import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { permissionResolutionEvidence } from './continuation-driver.mjs'
const sha=bytes=>createHash('sha256').update(bytes).digest('hex')

test('historical permission only resolves with exact accepted review and durable approved state',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'continuation-permission-'))
  t.after(()=>{assert.equal(path.dirname(root),os.tmpdir());assert.match(path.basename(root),/^continuation-permission-/);fs.rmSync(root,{recursive:true,force:true})})
  const pending={kind:'permission',requestId:'request',toolCallId:'call',toolName:'execute_cmd',args:{command:'node',args:['check.mjs'],cwd:root},status:'answered',output:'approved'}
  const run={runId:'run',sessionId:'session',createdAt:100,finishedAt:500,pending:[pending]}
  const reviewFile=path.join(root,'permission-review-1.json');fs.writeFileSync(reviewFile,JSON.stringify({args:pending.args}))
  const reviewedRequest={runId:run.runId,requestId:pending.requestId,toolCallId:pending.toolCallId,name:pending.toolName,args:pending.args}
  const receipt={schemaVersion:1,sessionId:run.sessionId,runId:run.runId,decision:'approved',reviewedRequest,requestBody:{sessionId:run.sessionId,toolResponse:{runId:run.runId,requestId:pending.requestId,toolCallId:pending.toolCallId,name:pending.toolName,output:'approved'}},method:'POST',route:'/api/v1/chat',httpStatus:200,contentType:'text/event-stream',startedAt:200,finishedAt:201,reviewFile,reviewSha256:sha(fs.readFileSync(reviewFile)),manualReview:{approved:true,authority:'root-agent',reviewedAt:190,requestHash:sha(JSON.stringify(reviewedRequest))}}
  const receiptFile=reviewFile+'.receipt.json',save=value=>fs.writeFileSync(receiptFile,JSON.stringify(value))
  save(receipt);assert.equal(permissionResolutionEvidence(root,run)[0].decision,'approved')
  for(const mutate of [x=>delete x.finishedAt,x=>delete x.startedAt,x=>{x.httpStatus=500},x=>{x.manualReview.approved=false},x=>{x.requestBody.toolResponse.output='rejected'},x=>{x.reviewedRequest.args.args=['other.mjs']},x=>{x.manualReview.reviewedAt=205},x=>{x.finishedAt=600}]){
    const changed=structuredClone(receipt);mutate(changed);save(changed);assert.equal(permissionResolutionEvidence(root,run)[0].decision,'unresolved',mutate.toString())
  }
  save(receipt);pending.output='rejected';assert.equal(permissionResolutionEvidence(root,run)[0].decision,'rejected')
  pending.output='approved';pending.status='pending';assert.equal(permissionResolutionEvidence(root,run)[0].decision,'unresolved')
  pending.status='answered';fs.writeFileSync(reviewFile,'changed');assert.equal(permissionResolutionEvidence(root,run)[0].decision,'unresolved')
})
