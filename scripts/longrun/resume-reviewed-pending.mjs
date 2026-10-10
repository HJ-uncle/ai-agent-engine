import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { consumeSSE } from './project-driver.mjs'

// Human/agent review supplies the COMPLETE exact argv in a retained evidence
// file. Never grant on a command prefix or approve unknown queued requests.
const root = path.resolve(process.argv[2]), base = process.argv[3], reviewFile = path.resolve(process.argv[4])
const review = JSON.parse(fs.readFileSync(reviewFile, 'utf8'))
const output = review.output ?? 'approved'
if (!['approved', 'rejected'].includes(output)) throw new Error('Explicit approve or reject decision required')
const token = fs.readFileSync(path.join(root, '.instance-token'), 'utf8').trim()
const headers = { 'content-type': 'application/json', 'x-aether-instance-token': token, 'x-aether-tool-profile': 'code' }
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const snapshot = await fetch(base + '/api/v1/chat/snapshot?sessionId=' + encodeURIComponent(review.sessionId), { headers }).then(response => response.json())
if (snapshot.code !== 200) throw new Error('Snapshot observation failed')
const run = snapshot.data.run, pending = run?.pending?.find(item => item.requestId === review.requestId && item.status === 'pending')
if (run?.runId !== review.runId || pending?.toolName !== 'execute_cmd' || JSON.stringify(pending.args) !== JSON.stringify(review.args)) throw new Error('Exact reviewed pending payload changed; no approval sent')
const requestBody = { sessionId: review.sessionId, toolResponse: { runId: run.runId, requestId: pending.requestId, toolCallId: pending.toolCallId, name: pending.toolName, output } }
const startedAt = new Date().toISOString()
const response = await fetch(base + '/api/v1/chat', { method: 'POST', headers, body: JSON.stringify(requestBody) })
if (!response.ok || !response.headers.get('content-type')?.includes('text/event-stream')) throw new Error('Resume not accepted: ' + response.status)
const reviewedRequest = { runId: run.runId, requestId: pending.requestId, toolCallId: pending.toolCallId, name: pending.toolName, args: pending.args }
fs.writeFileSync(reviewFile + '.receipt.json', JSON.stringify({ schemaVersion: 1, sessionId: review.sessionId, runId: run.runId, requestId: pending.requestId, toolCallId: pending.toolCallId, name: pending.toolName, decision: output, reviewedRequest, requestBody, route: '/api/v1/chat', method: 'POST', httpStatus: response.status, contentType: response.headers.get('content-type'), startedAt, finishedAt: new Date().toISOString(), reviewFile, reviewSha256: hash(fs.readFileSync(reviewFile)), manualReview: { approved: output === 'approved', authority: review.authority ?? 'root-agent', reviewedAt: review.reviewedAt ?? fs.statSync(reviewFile).mtime.toISOString(), requestHash: hash(JSON.stringify(reviewedRequest)) }, streamFile: reviewFile + '.sse', traceFile: reviewFile + '.events.jsonl' }, null, 2) + '\n', { flag: 'wx' })
console.log(JSON.stringify({ reviewedPayloadMatched: true, decision: output, status: response.status, runId: run.runId, requestId: pending.requestId }))
const file = fs.createWriteStream(reviewFile + '.sse', { flags: 'wx' })
const traceFile=reviewFile+'.events.jsonl'
fs.writeFileSync(traceFile,'',{flag:'wx'})
const [raw,parsed]=response.body.tee()
await Promise.all([
  (async()=>{try{for await(const chunk of raw)if(!file.write(chunk))await new Promise(resolve=>file.once('drain',resolve))}finally{await new Promise((resolve,reject)=>{file.once('error',reject);file.end(resolve)})}})(),
  consumeSSE(parsed,event=>fs.appendFileSync(traceFile,JSON.stringify({at:new Date().toISOString(),...event})+'\n'))
])
