import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
import test from 'node:test'
import { canonicalEvents, overlapIntervals, runningIntervals, qualifyNodeEvidence, qualifyParentCommand, qualifyPermissionResolutions, qualifyDevelopment, qualifyModelCompaction, qualifyChildActualModel, qualifyFeatureProof, playwrightCases, qualifyClientEvidence, samplingCoverage, qualifyBuildFreeze, analyzeContinuation } from './analyze-continuation.mjs'
import { captureBuildArtifacts, compareBuildArtifacts } from './build-artifact-identity.mjs'
import { applyNodePtyPatch } from '../apply-node-pty-patch.mjs'

const sha = value => createHash('sha256').update(value).digest('hex')
const tap = ({ tests = 2, pass = 2, fail = 0, skipped = 0, cancelled = 0, todo = 0 } = {}) => Object.entries({ tests, pass, fail, skipped, cancelled, todo }).map(([key, value]) => `# ${key} ${value}`).join('\n')
const processProof = () => ({ exitCode: 0, signal: null, timedOut: false, startedAt: 50, finishedAt: 100 })
const fixture = t => { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'continuation-qualify-')); t.after(() => { assert.equal(path.dirname(root), os.tmpdir()); assert.match(path.basename(root), /^continuation-qualify-/); fs.rmSync(root, { recursive: true, force: true }) }); return root }

test('elapsed duration and a passed flag cannot replace actual complete assertions', () => {
  assert.equal(qualifyNodeEvidence(processProof(), tap(), 2).passed, true)
  assert.equal(qualifyNodeEvidence({ ...processProof(), contractPassed: true }, '', 2).passed, false)
  assert.equal(qualifyNodeEvidence(processProof(), tap({ skipped: 1, pass: 1 }), 2).passed, false)
  assert.equal(qualifyNodeEvidence(processProof(), tap(), 3).passed, false)
  assert.equal(qualifyNodeEvidence({ ...processProof(), timedOut: true }, tap(), 2).passed, false)
  assert.equal(qualifyNodeEvidence(processProof(), tap(), 2, 53).passed, false)
})

test('raw SSE replay duplicate IDs are deduplicated and contradictory data is rejected', () => {
  const event = { id: 'one', at: 100, event: 'content', data: { content: 'actual' } }
  assert.equal(canonicalEvents([event, { ...event, at: 200 }]).events.length, 1)
  assert.equal(canonicalEvents([event, { ...event, data: { content: 'changed' } }]).errors.length, 1)
  assert.equal(canonicalEvents([null, [], { data: 'bad' }]).errors.length, 3)
})

function parentCommandFixture() {
  const workspace = path.resolve('.tmp/parent-command-fixture'), command = { command: 'node', args: ['check.mjs', workspace] }
  const rootRun = { runId: 'root', sessionId: 'session', turnId: 'turn', createdAt: 10, finishedAt: 100 }
  const job = { schemaVersion: 1, jobId: 'job', sessionId: 'session', ownerSessionId: 'session', runId: 'root', ownerRunId: 'root', turnId: 'turn', toolCallId: 'call', version: 3,
    ...command, cwd: workspace, status: 'succeeded', exitCode: 0, signal: null, background: false, createdAt: 50, updatedAt: 80, finishedAt: 80, cursor: 1, earliestCursor: 0 }
  const call = { toolCallId: 'call', name: 'execute_cmd', rootRunId: 'root', turnId: 'turn', args: { ...command, cwd: workspace } }
  const end = { ...call, status: 'succeeded', success: true, output: tap(), metadata: { commandJob: structuredClone(job), rootRunId: 'root', turnId: 'turn', outputTruncated: false, exitCode: 0 } }
  return { job, retained: structuredClone(job), events: [{ at: 49, data: { toolCall: call } }, { at: 81, data: { toolEnd: end } }], rootRun, sessionId: 'session', workspace, command, expected: 2, after: 40 }
}

test('parent raw tests bind the exact invocation, owner, terminal signature and post-review chronology', () => {
  const input = parentCommandFixture()
  assert.equal(qualifyParentCommand(input).passed, true)
  const pruned = qualifyParentCommand({ ...input, retained: undefined })
  assert.equal(pruned.passed, true); assert.equal(pruned.dbRetentionGap, true)
  input.events[0].data.toolCall.args = JSON.stringify(input.events[0].data.toolCall.args)
  input.events[1].data.toolResult = input.events[1].data.toolEnd; delete input.events[1].data.toolEnd
  assert.equal(qualifyParentCommand(input).passed, true)
})

test('wrong raw argv/cwd, child ownership, truncated output, changed durable jobs and stale commands cannot pass', () => {
  const mutations = [
    x => { x.events = [] }, x => { x.events.shift() },
    x => { x.events[0].data.toolCall.args.args = ['unrelated.mjs'] }, x => { x.events[0].data.toolCall.args.cwd = path.dirname(x.workspace) },
    x => { x.events[0].data.toolCall.rootRunId = 'foreign' }, x => { x.events[1].data.toolEnd.turnId = 'other' },
    x => { x.events[1].data.toolEnd.metadata.commandJob.version++ }, x => { x.retained.cwd = path.dirname(x.workspace) },
    x => { x.retained.args = ['other.mjs'] }, x => { x.job.ownerSessionId = 'child' }, x => { x.job.ownerRunId = 'child' },
    x => { x.events[1].data.toolEnd.metadata.outputTruncated = true }, x => { x.events[1].data.toolEnd.output = tap({ skipped: 1, pass: 1 }) },
    x => { x.events[1].data.toolEnd.metadata.rootRunId = 'other' }, x => { x.events[1].data.toolEnd.metadata.exitCode = 1 },
    x => { x.rootRun.finishedAt = 70 }, x => { x.after = 60 }, x => { x.expected = 3 }, x => { x.job.signal = 'SIGTERM' },
  ]
  for (const mutate of mutations) { const input = parentCommandFixture(); mutate(input); assert.equal(qualifyParentCommand(input).passed, false, mutate.toString()) }
})

test('waiting, preparation and replay wall clocks do not inflate running time', () => {
  const root = { runId: 'root', sessionId: 'session', status: 'succeeded', createdAt: 0, finishedAt: 200 }
  const events = [{ at: 10, data: { run: { runId: 'root', status: 'queued' } } }, { at: 20, data: { run: { runId: 'root', status: 'running' } } },
    { at: 40, data: { run: { runId: 'root', status: 'waiting_permission' } } }, { at: 150, data: { run: { runId: 'root', status: 'running' } } }, { at: 190, data: { run: { runId: 'root', status: 'succeeded' } } }]
  const intervals = runningIntervals(events, root)
  assert.deepEqual(intervals.map(row => [row.from, row.to]), [[20, 40], [150, 190]])
  assert.equal(overlapIntervals(intervals).unionActiveMs, 60)
  assert.deepEqual(runningIntervals([], root), [])
})

test('overlap counts unique sessions, merges duplicate intervals and requires actual positive five-way overlap', () => {
  const intervals = Array.from({ length: 5 }, (_, index) => ({ sessionId: 's' + index, from: 10, to: 30 }))
  const proof = overlapIntervals([...intervals, intervals[0]])
  assert.equal(proof.maxConcurrentSessions, 5)
  assert.equal(proof.allFiveOverlapMs, 20)
  assert.equal(proof.perSessionMs.s0, 20)
  assert.equal(overlapIntervals(intervals.map((row, index) => ({ ...row, from: index * 20, to: index * 20 + 20 }))).allFiveOverlapMs, 0)
})

function developmentRound() {
  const before = [{ file: 'src.mjs', sha256: 'a'.repeat(64) }]
  return { item: { expectedTests: 2 }, rootRun: { createdAt: 50 }, before, files: [{ file: 'src.mjs', sha256: 'b'.repeat(64) }] }
}
const redBaseline = () => ({ ...processProof(), exitCode: 1, startedAt: 0, finishedAt: 20, stdout: tap({ pass: 1, fail: 1 }) })

test('fresh development requires the original raw red baseline and owned implementation change', () => {
  const round = developmentRound()
  assert.equal(qualifyDevelopment(round, redBaseline(), null, ['src.mjs']).passed, true)
  assert.equal(qualifyDevelopment(round, { ...redBaseline(), stdout: tap() }, null, ['src.mjs']).passed, false)
  assert.equal(qualifyDevelopment(round, { ...redBaseline(), finishedAt: 70 }, null, ['src.mjs']).passed, false)
  assert.equal(qualifyDevelopment({ ...round, files: round.before }, redBaseline(), null, ['src.mjs']).passed, false)
  assert.equal(qualifyDevelopment(round, redBaseline(), null, ['src.mjs', 'peer.mjs']).passed, false)
})

test('maintenance completion uses original immutable before hashes without inventing fresh development', t => {
  const root = fixture(t), file = path.join(root, 'original-result.json'), round = developmentRound()
  fs.writeFileSync(file, JSON.stringify({ before: round.before }))
  const recovery = { before: round.before, evidenceFile: file, evidenceSha256: sha(fs.readFileSync(file)) }
  round.before = round.files
  const proof = qualifyDevelopment(round, redBaseline(), recovery, ['src.mjs'])
  assert.equal(proof.passed, true)
  assert.equal(proof.recoveryCompletion, true)
  assert.deepEqual(proof.freshChangedOwnedFiles, [])
  assert.deepEqual(proof.cumulativeChangedOwnedFiles, ['src.mjs'])
  assert.equal(qualifyDevelopment(round, redBaseline(), { ...recovery, before: [{ file: 'src.mjs', sha256: 'c'.repeat(64) }] }, ['src.mjs']).passed, false)
  const invocation = { workspace: root, command: { command: 'node', args: ['check.mjs', root] } }
  const legacy = qualifyDevelopment(round, redBaseline(), recovery, ['src.mjs'], invocation)
  assert.equal(legacy.passed, true); assert.equal(legacy.freshEligible, false); assert.equal(legacy.historicalLimitations.length, 1)
  assert.equal(qualifyDevelopment(developmentRound(), redBaseline(), null, ['src.mjs'], invocation).passed, false)
  assert.equal(qualifyDevelopment(developmentRound(), { ...redBaseline(), command: invocation.command, cwd: root, executable: process.execPath }, null, ['src.mjs'], invocation).freshEligible, true)
  fs.writeFileSync(file, 'changed source proof')
  assert.equal(qualifyDevelopment(round, redBaseline(), recovery, ['src.mjs']).passed, false)
})

const compactFixture = () => ({ model: 'qwen3.8-flash', log: { msg: 'Compression done', time: 100, sessionId: 'session', runId: 'root', preRequestTokens: 95000, postRequestTokens: 50000 },
  round: { modelId: 'qwen3.8-flash', runId: 'root', sessionId: 'session', dispatchId: 'dispatch', kind: 'development', independentlyQualified: true,
    rootRun: { sessionId: 'session', actualModelId: 'qwen3.8-flash', createdAt: 20, finishedAt: 300 }, developmentQualification: { recoveryCompletion: false },
    toolPairs: [{ name: 'edit_file', at: 120, result: { success: true } }] } })

test('each actual model needs real auto-compaction budgets followed by qualified development', () => {
  const { model, log, round } = compactFixture()
  assert.equal(qualifyModelCompaction(model, [log], [round]).passed, true)
  assert.equal(qualifyModelCompaction('glm-5.3', [log], [round]).passed, false)
  assert.equal(qualifyModelCompaction(model, [{ ...log, msg: 'Micro-compact done' }], [round]).passed, false)
  assert.equal(qualifyModelCompaction(model, [{ ...log, postRequestTokens: 100000 }], [round]).passed, false)
  assert.equal(qualifyModelCompaction(model, [{ ...log, preRequestTokens: 30000 }], [round]).passed, false)
  assert.equal(qualifyModelCompaction(model, [{ ...log, postRequestTokens: undefined }], [round]).passed, false)
})

test('audit-only, unqualified, before-compaction or recovery-only work cannot qualify compression continuation', () => {
  const { model, log, round } = compactFixture()
  for (const mutation of [{ kind: 'retained-audit' }, { independentlyQualified: false }, { developmentQualification: { recoveryCompletion: true } },
    { toolPairs: [{ name: 'edit_file', at: 90, result: { success: true } }] }, { rootRun: { ...round.rootRun, actualModelId: 'wrong' } }]) {
    assert.equal(qualifyModelCompaction(model, [log], [{ ...round, ...mutation }]).passed, false)
  }
})

test('requested child model alone is not provider evidence; actual assistant must match child, parent root, turn and execution time', () => {
  const child = { runId: 'child-run', childSessionId: 'child-session', rootSessionId: 'session', parentSessionId: 'session', parentConversationId: 'turn', modelId: 'glm-5.3', startedAt: 40, finishedAt: 200 }
  const roots = [{ runId: 'root', sessionId: 'session', turnId: 'turn' }]
  const row = { uuid: 'assistant', type: 'assistant', sessionId: 'child-session', tenantId: 'default', payload: { id: 'assistant', modelId: 'glm-5.3', createdAt: 100, metadata: { rootRunId: 'root', turnId: 'turn' } } }
  assert.equal(qualifyChildActualModel(child, [row], roots).passed, true)
  assert.equal(qualifyChildActualModel(child, [], roots).passed, false)
  for (const mutation of [{ sessionId: 'foreign' }, { tenantId: 'private' }, { payload: { ...row.payload, modelId: 'qwen3.8-flash' } },
    { payload: { ...row.payload, createdAt: 20 } }, { payload: { ...row.payload, metadata: { rootRunId: 'other', turnId: 'turn' } } },
    { payload: { ...row.payload, metadata: { rootRunId: 'root', turnId: 'other' } } }]) assert.equal(qualifyChildActualModel(child, [{ ...row, ...mutation }], roots).passed, false)
})

test('semantic feature coverage requires hashed independent assertions and actual post-result tool bindings', t => {
  const root = fixture(t), report = { ...processProof(), independent: true, buildId: 'fixture-build', stdout: tap() }, context = { buildId: 'fixture-build' }
  fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify(report)); fs.writeFileSync(path.join(root, 'assertions.mjs'), 'assertions consume the actual engine result'); fs.writeFileSync(path.join(root, 'events.jsonl'), 'actual retained tool evidence')
  const entry = { feature: 'files.crud', mode: 'agent-semantic', bindings: [{ dispatchId: 'dispatch', toolCallId: 'call', name: 'read_file' }],
    proof: { checker: 'node-test', buildId: 'fixture-build', file: 'report.json', sha256: sha(fs.readFileSync(path.join(root, 'report.json'))), sourceFile: 'assertions.mjs', sourceSha256: sha(fs.readFileSync(path.join(root, 'assertions.mjs'))),
      inputFiles: [{ file: 'events.jsonl', sha256: sha(fs.readFileSync(path.join(root, 'events.jsonl'))) }], expectedTests: 2 } }
  const calls = [{ dispatchId: 'dispatch', id: 'call', name: 'read_file', resultAt: 30, eventsFile: path.join(root, 'events.jsonl') }]
  assert.equal(qualifyFeatureProof(entry, root, calls, context).passed, true)
  assert.equal(qualifyFeatureProof(entry, root, [], context).passed, false)
  assert.equal(qualifyFeatureProof({ ...entry, mode: 'regression-only' }, root, calls, context).passed, false)
  assert.equal(qualifyFeatureProof(entry, root, [{ ...calls[0], resultAt: 60 }], context).passed, false)
  assert.equal(qualifyFeatureProof({ ...entry, bindings: [null] }, root, calls, context).passed, false)
  assert.equal(qualifyFeatureProof({}, root, calls, context).passed, false)
  assert.equal(qualifyFeatureProof(entry, root, calls, { buildId: 'previous-build' }).passed, false)
  assert.equal(qualifyFeatureProof(entry, root, [{ ...calls[0], eventsFile: path.join(root, 'absent.jsonl') }], context).passed, false)
  const regression = qualifyFeatureProof({ ...entry, mode: 'engine-regression' }, root, calls, context)
  assert.equal(regression.passed, false); assert.equal(regression.regressionPassed, true)
  fs.writeFileSync(path.join(root, 'events.jsonl'), 'tampered evidence')
  assert.equal(qualifyFeatureProof(entry, root, calls, context).passed, false)
})

test('client and API semantics must bind exact fresh candidate inputs and cannot qualify Agent execution', t => {
  const root = fixture(t), context = { buildId: 'fixture-build', frozenAt: 0, base: 'http://127.0.0.1:19001', clientPassed: true, client: { finishedAt: 30, checks: [{ name: 'composer :: selection hydration', passed: true }] }, clientFile: path.join(root, 'client.json') }
  const report = { ...processProof(), independent: true, buildId: context.buildId, stdout: tap() }
  fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify(report)); fs.writeFileSync(path.join(root, 'assertions.mjs'), 'assert actual retained HTTP and client outputs'); fs.writeFileSync(context.clientFile, JSON.stringify(context.client))
  const request = { requestId: 'http-1', base: context.base, method: 'POST', route: '/knowledge/documents', buildId: context.buildId, startedAt: 10, finishedAt: 20, httpStatus: 200, response: { id: 'actual-document' } }
  fs.writeFileSync(path.join(root, 'http.jsonl'), JSON.stringify(request) + '\n')
  const entry = { feature: 'client.composer-hydration', mode: 'client-semantic', clientChecks: ['composer :: selection hydration'], proof: { checker: 'node-test', buildId: context.buildId, file: 'report.json', sha256: hash('report.json'), sourceFile: 'assertions.mjs', sourceSha256: hash('assertions.mjs'), expectedTests: 2, inputFiles: ['client.json', 'http.jsonl'].map(file => ({ file, sha256: hash(file) })) } }
  function hash(file) { return sha(fs.readFileSync(path.join(root, file))) }
  assert.equal(qualifyFeatureProof(entry, root, [], context).passed, true)
  assert.equal(qualifyFeatureProof({ ...entry, feature: 'skills.agent-injection' }, root, [], context).passed, false)
  assert.equal(qualifyFeatureProof({ ...entry, clientChecks: ['unknown workflow'] }, root, [], context).passed, false)
  assert.equal(qualifyFeatureProof(entry, root, [], { ...context, clientPassed: false }).passed, false)
  const api = { ...entry, feature: 'knowledge.crud', mode: 'live-api-semantic', httpBindings: [{ requestId: request.requestId, method: request.method, route: request.route }], proof: { ...entry.proof, httpEvidenceFile: 'http.jsonl' } }
  assert.equal(qualifyFeatureProof(api, root, [], context).passed, true)
  assert.equal(qualifyFeatureProof(api, root, [], { ...context, base: 'http://different-instance' }).passed, false)
  assert.equal(qualifyFeatureProof({ ...api, feature: 'tool:mcp_continuation_checkpoint' }, root, [], context).passed, false)
})

test('full client qualification verifies actual Playwright results for every registered identity rather than wrapper flags or stats', t => {
  const root = fixture(t), file = path.join(root, 'client-acceptance.json'), listFile = path.join(root, 'list.json'), rawFile = path.join(root, 'execution.json')
  const specs = ['create and read', 'edit and delete'].map(title => ({ file: 'crud.spec.ts', title, ok: true, tests: [{ projectName: '', expectedStatus: 'passed', status: 'expected', results: [{ status: 'passed' }] }] }))
  const raw = { suites: [{ title: 'crud.spec.ts', specs }], errors: [], stats: { startTime: 40, duration: 10, expected: 2, skipped: 0, unexpected: 0, flaky: 0 } }
  const list = structuredClone(raw); for (const spec of list.suites[0].specs) { spec.tests[0].results = []; spec.tests[0].status = 'skipped' }
  fs.writeFileSync(listFile, JSON.stringify(list)); fs.writeFileSync(rawFile, JSON.stringify(raw))
  const client = { scope: 'full-client', fullSuite: true, passed: true, buildId: 'build', exitCode: 0, signal: null, timedOut: false, startedAt: 30, finishedAt: 80, listFile, listSha256: sha(fs.readFileSync(listFile)), rawReportFile: rawFile, rawReportSha256: sha(fs.readFileSync(rawFile)), listTotal: 2,
    checks: playwrightCases(raw).map(row => ({ name: row.name, project: row.project, passed: true })), proofFiles: [rawFile] }
  assert.equal(qualifyClientEvidence(client, file, 'build', 20).passed, true)
  assert.equal(qualifyClientEvidence({ ...client, fullSuite: false }, file, 'build', 20).passed, false)
  assert.equal(qualifyClientEvidence({ ...client, checks: client.checks.slice(0, 1), listTotal: 1 }, file, 'build', 20).passed, false)
  assert.equal(qualifyClientEvidence(client, file, 'previous-build', 20).passed, false)
  assert.equal(qualifyClientEvidence({ ...client, exitCode: 1 }, file, 'build', 20).passed, false)
  assert.equal(qualifyClientEvidence({ ...client, timedOut: true }, file, 'build', 20).passed, false)
  const bad = structuredClone(raw); bad.suites[0].specs[1].tests[0].results = [{ status: 'skipped' }]
  fs.writeFileSync(rawFile, JSON.stringify(bad))
  assert.equal(qualifyClientEvidence({ ...client, rawReportSha256: sha(fs.readFileSync(rawFile)) }, file, 'build', 20).passed, false)
  assert.equal(qualifyClientEvidence(client, file, 'build', 20).passed, false)
})

test('resolved approvals require complete review hashes and the actual resume running-to-execution stream', t => {
  const root = fixture(t), args = { command: 'node', args: ['check.mjs'], cwd: root }, pending = { kind: 'permission', requestId: 'request', toolCallId: 'call', toolName: 'execute_cmd', args, status: 'answered', output: 'approved' }
  const run = { runId: 'run', sessionId: 'session', turnId: 'turn', createdAt: 10, finishedAt: 100, pending: [pending] }, reviewFile = path.join(root, 'permission-review-one.json'), receiptFile = reviewFile + '.receipt.json', streamFile = reviewFile + '.sse', traceFile = reviewFile + '.events.jsonl'
  const review = { runId: run.runId, sessionId: run.sessionId, requestId: pending.requestId, args, authority: 'root-agent', reviewedAt: 40 }
  const reviewedRequest = { runId: run.runId, requestId: pending.requestId, toolCallId: pending.toolCallId, name: pending.toolName, args }
  fs.writeFileSync(reviewFile, JSON.stringify(review))
  const receipt = { schemaVersion: 1, ...reviewedRequest, sessionId: run.sessionId, decision: 'approved', reviewedRequest,
    requestBody: { sessionId: run.sessionId, toolResponse: { runId: run.runId, requestId: pending.requestId, toolCallId: pending.toolCallId, name: pending.toolName, output: 'approved' } },
    method: 'POST', route: '/api/v1/chat', httpStatus: 200, contentType: 'text/event-stream', startedAt: 50, finishedAt: 51, reviewFile, reviewSha256: sha(fs.readFileSync(reviewFile)), streamFile, traceFile,
    manualReview: { approved: true, authority: 'root-agent', reviewedAt: 40, requestHash: sha(JSON.stringify(reviewedRequest)) } }
  const job = { jobId: 'job', sessionId: run.sessionId, ownerSessionId: run.sessionId, runId: run.runId, toolCallId: pending.toolCallId, ...args, status: 'succeeded', createdAt: 55, finishedAt: 80 }
  const frames = [{ run: { ...run, status: 'running' } }, { toolResult: { toolCallId: pending.toolCallId, name: pending.toolName, rootRunId: run.runId, turnId: run.turnId, metadata: { rootRunId: run.runId, turnId: run.turnId, commandJob: job } } }]
  const persist = (value, stream = frames) => { fs.writeFileSync(receiptFile, JSON.stringify(value)); fs.writeFileSync(streamFile, stream.map(data => 'data: ' + JSON.stringify(data) + '\n\n').join('')); fs.writeFileSync(traceFile, stream.map((data, index) => JSON.stringify({ at: index === 0 ? 51 : 81, event: 'message', data }) + '\n').join('')); return [{ ...reviewedRequest, sessionId: run.sessionId, decision: 'approved', source: 'manual-review', receiptFile, receiptSha256: sha(fs.readFileSync(receiptFile)) }] }
  const resolutions = persist(receipt)
  assert.equal(qualifyPermissionResolutions(root, run, [{ requestId: 'request' }], resolutions).passed, true)
  assert.equal(qualifyPermissionResolutions(root, { ...run, pending: [{ ...pending, status: 'pending' }] }, [], resolutions).passed, false)
  assert.equal(qualifyPermissionResolutions(root, { ...run, pending: [{ ...pending, output: 'rejected' }] }, [], resolutions).passed, false)
  assert.equal(qualifyPermissionResolutions(root, run, [], persist({ ...receipt, manualReview: { ...receipt.manualReview, reviewedAt: undefined } })).passed, false)
  assert.equal(qualifyPermissionResolutions(root, run, [], persist(receipt, [frames[0]])).passed, false)
  const bad = structuredClone(frames); bad[1].toolResult.metadata.commandJob.args = ['unreviewed.mjs']
  assert.equal(qualifyPermissionResolutions(root, run, [], persist(receipt, bad)).passed, false)
  assert.equal(qualifyPermissionResolutions(root, run, [], persist({ ...receipt, requestBody: { ...receipt.requestBody, toolResponse: { ...receipt.requestBody.toolResponse, runId: 'foreign' } } })).passed, false)
  persist(receipt); fs.writeFileSync(traceFile, JSON.stringify({ at: 52, event: 'message', data: frames[1] }))
  assert.equal(qualifyPermissionResolutions(root, run, [], resolutions).passed, false)
  persist(receipt); fs.unlinkSync(traceFile)
  assert.equal(qualifyPermissionResolutions(root, run, [], resolutions).passed, false)
  persist(receipt); fs.writeFileSync(reviewFile, JSON.stringify({ ...review, args: { ...args, args: ['changed-after-review.mjs'] } }))
  assert.equal(qualifyPermissionResolutions(root, run, [], resolutions).passed, false)
})

test('telemetry must cover the completed active interval with known cadence and no long missing segment', () => {
  const lifecycle = [{ at: 100, phase: 'active' }, { at: 1000, phase: 'cleanup' }]
  const rows = Array.from({ length: 9 }, (_, index) => ({ at: 150 + index * 100, sequence: index }))
  const result = samplingCoverage(rows, lifecycle, 100)
  assert.equal(result.passed, true); assert.equal(result.activeSpanMs, 900); assert.equal(result.intervals[0].maxGapMs, 100)
  assert.equal(samplingCoverage(rows.slice(0, 2), lifecycle, 100).passed, false)
  assert.equal(samplingCoverage(rows, lifecycle.slice(0, 1), 100).passed, false)
  assert.equal(samplingCoverage(rows, lifecycle, undefined).passed, false)
  assert.equal(samplingCoverage([{ at: 150, sequence: 1 }, { at: 250, sequence: 1 }], lifecycle, 100).passed, false)
  assert.equal(samplingCoverage([...rows].reverse(), lifecycle, 100).passed, false)
})

test('final actual source and client bytes are rehashed even when all recorded unchanged flags claim success', t => {
  const root = fixture(t), sourceRoot = path.join(root, 'source'), stageRoot = path.join(root, 'stage')
  const write = (directory, filename, value) => { const file = path.join(directory, filename); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value) }
  const engine = path.resolve(new URL('../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
  const patchDirectory = path.resolve(engine, 'scripts/patches/node-pty-1.1.0'), patch = JSON.parse(fs.readFileSync(path.join(patchDirectory, 'manifest.json'), 'utf8'))
  for (const directory of [sourceRoot, stageRoot]) {
    write(directory, 'dist/main.js', 'export const source=true')
    write(directory, 'dist/storage/sqlite/db.js', 'export const sqlite=true')
    write(directory, 'dist/runtime/build-manifest.json', JSON.stringify({ buildId: 'frozen-build' }))
    write(directory, 'dist/core/prompt.mjs', 'export const prompt="frozen"')
    write(directory, 'node_modules/node-pty/package.json', fs.readFileSync(path.join(engine, 'node_modules/node-pty/package.json')))
    for (const entry of patch.files) write(directory, 'node_modules/node-pty/' + entry.path, fs.readFileSync(path.join(patchDirectory, entry.asset)))
    write(directory, 'node_modules/node-pty/prebuilds/win32-x64/pty.node', Buffer.from([1, 2, 3]))
    applyNodePtyPatch({ packageDir: path.join(directory, 'node_modules/node-pty') })
  }
  const source = captureBuildArtifacts(sourceRoot, { requireNodePty: true, requireNodePtyPatch: true }), stage = captureBuildArtifacts(stageRoot, { requireNodePty: true, requireNodePtyPatch: true })
  const freeze = { artifactRoot: sourceRoot, stageRoot, source, stage, synchronized: compareBuildArtifacts(source, stage) }
  assert.equal(qualifyBuildFreeze(freeze).passed, true)
  write(stageRoot, 'dist/core/prompt.mjs', 'export const prompt="drift after last sample"')
  const changed = qualifyBuildFreeze(freeze)
  assert.equal(changed.passed, false); assert.ok(changed.stage.changedFiles.some(file => file.path === 'dist/core/prompt.mjs'))
  assert.equal(qualifyBuildFreeze({ synchronized: { unchanged: true }, source, stage }).passed, false)
})

test('a seven-hour claimed completed fixture with no actual development or semantic gates never passes or rewrites evidence', t => {
  const root = fixture(t), sessions = Array.from({ length: 5 }, (_, index) => ({ index: index + 1, sessionId: 's' + index, roleId: 'r' + index, workspace: path.join(root, index < 3 ? 'a' : 'b'), accepted: [], rounds: [], errors: [], status: 'duration_reached' }))
  for (const [name, value] of Object.entries({
    'continuation-state.json': { root, contextWindow: 100000 },
    'checkpoint.json': { root, durationMs: 360 * 60000, firstDispatchAt: 0, sessions },
    'active-report.json': { root, sessions, finishedAt: 7 * 3600000, elapsedFromFirstRequestsMs: 7 * 3600000, acceptance: { passed: true } },
    'supervisor-status.json': { phase: 'stopped' }, 'continuation-cleanup.json': { inventoryComplete: true, remaining: [], errors: [] },
  })) fs.writeFileSync(path.join(root, name), JSON.stringify(value))
  const before = fs.readdirSync(root).map(file => [file, sha(fs.readFileSync(path.join(root, file)))])
  const proof = analyzeContinuation(root)
  assert.equal(proof.passed, false)
  assert.equal(proof.sevenByTwentyFour.established, false)
  assert.equal(proof.duration.actualRunning.unionActiveMs, 0)
  assert.ok(proof.features.every(feature => feature.feature !== 'context.auto-compaction' || feature.status !== 'qualified'))
  assert.ok(proof.problems.some(reason => reason.includes('six-hour')))
  assert.deepEqual(fs.readdirSync(root).map(file => [file, sha(fs.readFileSync(path.join(root, file)))]), before)
})
