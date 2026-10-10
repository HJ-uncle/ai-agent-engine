// Independent qualification for retained multi-model continuation runs.
// This reader never rewrites driver, original-run, checkpoint or test evidence.
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { MODELS, evaluateRecall, evaluateRetrieval, strictReviews, reviewsPassed, freshParentTests } from './continuation-driver.mjs'
import { nodeTestSummary, ownershipViolations, verifyProtectedEvidence, expectedContractTests } from './project-driver.mjs'
import { continuationDatabaseAudit } from './continuation-database-audit.mjs'
import { captureBuildArtifacts, compareBuildArtifacts } from './build-artifact-identity.mjs'

const sha = value => createHash('sha256').update(value).digest('hex')
const time = value => typeof value === 'number' ? value : Date.parse(value)
const terminal = value => ['succeeded', 'failed', 'cancelled', 'blocked', 'interrupted', 'timed_out'].includes(value)
const equalPath = (a, b) => typeof a === 'string' && typeof b === 'string' && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
const json = file => JSON.parse(fs.readFileSync(file, 'utf8'))
const optional = file => { try { return json(file) } catch { return undefined } }
const text = file => { try { return fs.readFileSync(file, 'utf8') } catch { return '' } }
const hashFile = file => { try { return sha(fs.readFileSync(file)) } catch { return null } }
const within = (root, file) => { const relative = path.relative(path.resolve(root), path.resolve(file)); return !relative.startsWith('..') && !path.isAbsolute(relative) }
const normalText = content => typeof content === 'string' ? content : JSON.stringify(content ?? '')
const array = value => Array.isArray(value) ? value : []
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const COMMAND_JOB_FIELDS = ['schemaVersion', 'jobId', 'sessionId', 'ownerSessionId', 'runId', 'ownerRunId', 'turnId', 'toolCallId', 'version', 'status', 'command', 'args', 'cwd', 'background', 'createdAt', 'updatedAt', 'finishedAt', 'exitCode', 'signal', 'cursor', 'earliestCursor']
const commandSignature = job => JSON.stringify(COMMAND_JOB_FIELDS.map(field => job?.[field] ?? null))
const ownedRegularFile = (root, file) => typeof file === 'string' && within(root, file) && fs.existsSync(file) && !fs.lstatSync(file).isSymbolicLink() && fs.lstatSync(file).isFile()

export const REQUIRED_FEATURES = [
  'models.cross-provider', 'chat.streaming', 'chat.restart', 'chat.output-continuation', 'context.auto-compaction',
  'history.raw-archive', 'history.native-images', 'memory.session-crud', 'memory.global-crud', 'memory.semantic',
  'skills.crud', 'skills.file-import', 'skills.archive-drag-import', 'skills.agent-injection',
  'mcp.config-json', 'mcp.stdio', 'mcp.http', 'mcp.cas', 'knowledge.crud', 'knowledge.format-extraction', 'knowledge.agent-rag',
  'subagents.reviews', 'subagents.cancellation', 'terminal.execution', 'terminal.background-cancel', 'terminal.interactive-clipboard-resize',
  'files.crud', 'files.cas', 'todos.crud', 'codegraph', 'code-diagnose', 'browser.workflow', 'http-web',
  'client.remote-token', 'client.source-isolation', 'client.composer-hydration', 'client.history-pagination',
  'storage.database-cleanup', 'runtime.telemetry', 'build.two-end',
]

function readLines(file) {
  const rows = [], errors = []
  for (const [index, line] of text(file).split(/\r?\n/).entries()) {
    if (!line.trim()) continue
    try { const row = JSON.parse(line); if (!record(row)) throw new Error('Record required'); rows.push(row) } catch { errors.push({ file, line: index + 1 }) }
  }
  return { rows, errors }
}

/** SSE replay duplicates have one identity. Changed duplicate data is an error. */
export function canonicalEvents(rows) {
  const found = new Map(), events = [], errors = []
  for (const row of array(rows)) {
    if (!record(row) || !record(row.data)) { errors.push('Malformed SSE record'); continue }
    if (row.id) {
      const signature = sha(JSON.stringify({ event: row.event, data: row.data }))
      if (found.has(row.id)) { if (found.get(row.id) !== signature) errors.push('Contradictory replay event ' + row.id); continue }
      found.set(row.id, signature)
    }
    events.push(row)
  }
  return { events, errors }
}

export function overlapIntervals(intervals) {
  const points = intervals.filter(row => Number.isFinite(row.from) && Number.isFinite(row.to) && row.to > row.from)
    .flatMap(row => [{ at: row.from, id: row.sessionId, delta: 1 }, { at: row.to, id: row.sessionId, delta: -1 }]).sort((a, b) => a.at - b.at)
  const active = new Map(), durationByCountMs = {}, perSessionMs = {}; let previous, max = 0
  for (let index = 0; index < points.length;) {
    const at = points[index].at
    if (previous !== undefined && at > previous) {
      durationByCountMs[active.size] = (durationByCountMs[active.size] ?? 0) + at - previous
      for (const id of active.keys()) perSessionMs[id] = (perSessionMs[id] ?? 0) + at - previous
      max = Math.max(max, active.size)
    }
    while (index < points.length && points[index].at === at) {
      const point = points[index++], next = (active.get(point.id) ?? 0) + point.delta
      if (next > 0) active.set(point.id, next); else active.delete(point.id)
    }
    previous = at
  }
  return { maxConcurrentSessions: max, durationByCountMs, perSessionMs, allFiveOverlapMs: durationByCountMs[5] ?? 0,
    unionActiveMs: Object.entries(durationByCountMs).filter(([count]) => Number(count) > 0).reduce((sum, [, value]) => sum + value, 0) }
}

/** Reconstruct running intervals from retained SSE timestamps, never driver replay clocks. */
export function runningIntervals(events, root) {
  const rows = events.filter(row => row.data?.run?.runId === root?.runId && Number.isFinite(time(row.at))).sort((a, b) => time(a.at) - time(b.at))
  const intervals = []; let start
  for (const row of rows) {
    const at = terminal(root?.status) && Number.isFinite(time(root?.finishedAt)) ? Math.min(time(row.at), time(root.finishedAt)) : time(row.at), state = row.data.run.status
    if (state === 'running' && start === undefined) start = at
    if (state !== 'running' && start !== undefined) { if (at > start) intervals.push({ sessionId: root.sessionId, runId: root.runId, from: start, to: at }); start = undefined }
  }
  if (start !== undefined && terminal(root?.status) && time(root.finishedAt) > start) intervals.push({ sessionId: root.sessionId, runId: root.runId, from: start, to: time(root.finishedAt) })
  return intervals
}

export function qualifyNodeEvidence(process, raw, expected, after = -Infinity) {
  const summary = nodeTestSummary(typeof raw === 'string' ? raw : '', expected), reasons = []
  if (!Number.isSafeInteger(expected) || expected < 1 || !summary.passed) reasons.push('Raw TAP totals are incomplete, wrong, skipped, cancelled or failing')
  if (process?.exitCode !== 0 || process.timedOut !== false || process.signal != null || process.error) reasons.push('Independent test process did not exit normally and successfully')
  if (!Number.isFinite(time(process?.startedAt)) || !Number.isFinite(time(process?.finishedAt)) || time(process.finishedAt) < time(process.startedAt) || time(process.startedAt) + 2 < after) reasons.push('Independent test chronology is absent or stale')
  return { passed: !reasons.length, reasons, summary }
}

export function playwrightCases(report) {
  const cases = []
  const walk = (suites, ancestors = []) => { for (const suite of array(suites)) {
    const titles = [...ancestors, suite.title]
    for (const spec of array(suite.specs)) for (const test of array(spec.tests)) {
      const name = `${spec.file ?? suite.file} :: ${[...titles, spec.title].join(' > ')}`, results = array(test.results), project = test.projectName ?? ''
      cases.push({ name, project, key: name + '\u0000' + project, passed: spec.ok === true && test.status === 'expected' && test.expectedStatus === 'passed' && results.length > 0 && results.every(result => result.status === 'passed'),
        attempts: results.length, statuses: results.map(result => result.status) })
    }
    walk(suite.suites, titles)
  } }
  walk(report?.suites); return cases
}

export function qualifyClientEvidence(client, file, buildId, frozenAt) {
  const reasons = [], resolve = value => typeof value === 'string' ? path.resolve(path.dirname(file), value) : undefined
  const listFile = resolve(client?.listFile), rawFile = resolve(client?.rawReportFile), list = listFile && optional(listFile), raw = rawFile && optional(rawFile)
  const expected = playwrightCases(list), actual = playwrightCases(raw), indexed = new Map(actual.map(row => [row.key, row]))
  const digest = value => typeof value === 'string' ? value.replace(/^sha256:/, '') : value
  if (client?.scope !== 'full-client' || client.fullSuite !== true || client.passed !== true || !buildId || client.buildId !== buildId) reasons.push('Actual full client scope or frozen candidate build identity absent')
  if (client?.exitCode !== 0 || client.timedOut !== false || client.signal != null || !Array.isArray(raw?.errors) || raw.errors.length) reasons.push('Actual full client process failed, timed out or reported global errors')
  if (!list || hashFile(listFile) !== digest(client?.listSha256) || !raw || hashFile(rawFile) !== digest(client?.rawReportSha256)) reasons.push('Complete original registration and execution reports missing or changed')
  if (!expected.length || expected.length !== client?.listTotal || new Set(expected.map(row => row.key)).size !== expected.length || indexed.size !== actual.length || actual.length !== expected.length
    || expected.some(row => !indexed.get(row.key)?.passed)) reasons.push('Every uniquely registered client check must have actual successful unskipped execution')
  if (!array(client?.checks).length || client.checks.length !== expected.length || client.checks.some(check => check.passed !== true || !indexed.get(check.name + '\u0000' + (check.project ?? ''))?.passed)) reasons.push('Wrapper check identities do not match all actual executed full-suite assertions')
  if (raw?.stats?.expected !== expected.length || raw.stats.skipped !== 0 || raw.stats.unexpected !== 0 || raw.stats.flaky !== 0) reasons.push('Raw full client report has skipped, failing, flaky or incomplete totals')
  if (!Number.isFinite(time(client?.startedAt)) || !Number.isFinite(time(client?.finishedAt)) || time(client.finishedAt) <= time(client.startedAt)
    || !Number.isFinite(time(raw?.stats?.startTime)) || !Number.isFinite(Number(raw?.stats?.duration)) || Number(raw.stats.duration) < 0 || time(raw.stats.startTime) < time(frozenAt) || time(raw.stats.startTime) + Number(raw.stats.duration) > time(client?.finishedAt) + 2) reasons.push('Actual complete client execution chronology is missing or predates the frozen candidate')
  const proofFiles = [...array(client?.screenshots), ...array(client?.proofFiles)]
  if (!proofFiles.length || proofFiles.some(proof => { const target = resolve(typeof proof === 'string' ? proof : proof?.path); return !target || !fs.existsSync(target) || fs.lstatSync(target).isSymbolicLink() })) reasons.push('Actual full client workflow artifacts are missing')
  return { passed: !reasons.length, reasons, expectedChecks: expected.length, actualChecks: actual.length, failedChecks: expected.filter(row => !indexed.get(row.key)?.passed).map(row => ({ name: row.name, project: row.project })), listFile, rawReportFile: rawFile }
}

/** Bind raw tests to the exact parent invocation, terminal snapshot and retained job. */
export function qualifyParentCommand({ job, retained, events, rootRun, sessionId, workspace, command, expected, after }) {
  const reasons = [], inRun = at => Number.isFinite(time(at)) && time(at) >= time(rootRun?.createdAt) && time(at) <= time(rootRun?.finishedAt) + 2
  const invocation = args => args?.command === command?.command && Array.isArray(args?.args) && JSON.stringify(args.args) === JSON.stringify(command?.args)
    && typeof args.cwd === 'string' && path.isAbsolute(args.cwd) && equalPath(args.cwd, workspace)
  const owned = value => value?.toolCallId === job?.toolCallId && value.rootRunId === rootRun?.runId && value.turnId === rootRun?.turnId && (value.name ?? value.toolName) === 'execute_cmd'
  if (!job?.jobId || job.schemaVersion !== 1 || job.sessionId !== sessionId || job.ownerSessionId !== sessionId || job.runId !== rootRun?.runId || job.turnId !== rootRun?.turnId
    || !job.toolCallId || job.ownerRunId != null && job.ownerRunId !== rootRun?.runId || !invocation(job) || job.status !== 'succeeded' || job.exitCode !== 0 || job.signal != null
    || !inRun(job.createdAt) || !inRun(job.finishedAt) || time(job.finishedAt) < time(job.createdAt) || time(job.createdAt) + 2 < after) reasons.push('Parent job signature, ownership, invocation, successful outcome or post-review chronology is invalid')
  if (retained && commandSignature(retained) !== commandSignature(job)) reasons.push('Retained database job contradicts the full terminal snapshot signature')
  const starts = array(events).filter(event => {
    const call = event?.data?.toolCall
    let args = call?.args
    if (typeof args === 'string') { try { args = JSON.parse(args) } catch { return false } }
    return owned(call) && invocation(args) && inRun(event.at) && time(event.at) <= time(job?.finishedAt)
  })
  if (!starts.length) reasons.push('Matching raw parent SSE invocation absent')
  const ends = array(events).filter(event => {
    const end = event?.data?.toolEnd ?? event?.data?.toolResult, metadata = end?.metadata
    return owned(end) && end.success === true && end.status === 'succeeded' && metadata?.exitCode === 0 && metadata.outputTruncated === false
      && metadata.rootRunId === rootRun?.runId && metadata.turnId === rootRun?.turnId && commandSignature(metadata.commandJob) === commandSignature(job)
      && inRun(event.at) && time(event.at) + 2 >= time(job?.finishedAt) && starts.some(start => time(start.at) <= time(event.at))
      && nodeTestSummary(end.output ?? '', expected).passed
  })
  if (!ends.length) reasons.push('Matching complete raw parent SSE terminal test result absent')
  return { passed: !reasons.length, reasons, jobId: job?.jobId, dbRetentionGap: !retained }
}

function rawSseFrames(file) {
  const frames = [], errors = []; let current = { event: 'message', data: [] }
  const flush = () => {
    if (current.data.length) { try { const data = JSON.parse(current.data.join('\n')); if (!record(data)) throw new Error('Object required'); frames.push({ id: current.id, event: current.event, data }) } catch { errors.push('Malformed raw approval-resume SSE frame') } }
    current = { event: 'message', data: [] }
  }
  for (const line of text(file).split(/\r?\n/)) {
    if (!line) flush()
    else if (line.startsWith('data:')) current.data.push(line.slice(5).trimStart())
    else if (line.startsWith('id:')) current.id = line.slice(3).trim()
    else if (line.startsWith('event:')) current.event = line.slice(6).trim()
  }
  flush(); return { frames, errors }
}

/** A historical approval request is observational, not failure after exact resolution. */
export function qualifyPermissionResolutions(root, rootRun, requests, resolutions) {
  const pending = array(rootRun?.pending).filter(item => item.kind === 'permission'), ids = new Set([...pending.map(item => item.requestId), ...array(requests).map(item => item?.requestId)])
  const proofs = [...ids].map(requestId => {
    const reasons = [], item = pending.find(item => item.requestId === requestId), resolution = array(resolutions).find(item => item?.requestId === requestId)
    const expected = item && { runId: rootRun.runId, requestId, toolCallId: item.toolCallId, name: item.toolName, args: item.args }
    const receiptFile = resolution?.receiptFile, receipt = ownedRegularFile(root, receiptFile) ? optional(receiptFile) : undefined
    const review = receipt?.reviewFile && ownedRegularFile(root, receipt.reviewFile) ? optional(receipt.reviewFile) : undefined
    const body = item && { sessionId: rootRun.sessionId, toolResponse: { runId: rootRun.runId, requestId, toolCallId: item.toolCallId, name: item.toolName, output: 'approved' } }
    if (!requestId || !item || item.status !== 'answered' || item.output !== 'approved') reasons.push('Final approval is missing, rejected or unresolved')
    if (resolution?.decision !== 'approved' || resolution.source !== 'manual-review' || resolution.runId !== rootRun?.runId || resolution.sessionId !== rootRun?.sessionId
      || resolution.toolCallId !== item?.toolCallId || resolution.name !== item?.toolName || !receipt || hashFile(receiptFile) !== resolution.receiptSha256) reasons.push('Exact owned resolution receipt is absent or changed')
    if (!receipt || receipt.schemaVersion !== 1 || receipt.decision !== 'approved' || receipt.sessionId !== rootRun?.sessionId || receipt.runId !== rootRun?.runId
      || JSON.stringify(receipt.reviewedRequest) !== JSON.stringify(expected) || JSON.stringify(receipt.requestBody) !== JSON.stringify(body)
      || receipt.method !== 'POST' || receipt.route !== '/api/v1/chat' || receipt.httpStatus !== 200 || !receipt.contentType?.includes('text/event-stream')) reasons.push('Actual resume POST does not match the exact approved request')
    if (!review || hashFile(receipt.reviewFile) !== receipt.reviewSha256 || review.runId !== rootRun?.runId || review.sessionId !== rootRun?.sessionId || review.requestId !== requestId
      || JSON.stringify(review.args) !== JSON.stringify(item?.args) || receipt.manualReview?.approved !== true || !['root-agent', 'human-user'].includes(receipt.manualReview?.authority)
      || receipt.manualReview.requestHash !== sha(JSON.stringify(expected ?? null)) || !Number.isFinite(time(receipt.manualReview.reviewedAt)) || !Number.isFinite(time(receipt.startedAt)) || !Number.isFinite(time(receipt.finishedAt))
      || time(receipt.manualReview.reviewedAt) > time(receipt.startedAt) || time(receipt.startedAt) < time(rootRun?.createdAt) || time(receipt.finishedAt) < time(receipt.startedAt) || time(receipt.finishedAt) > time(rootRun?.finishedAt)) reasons.push('Complete retained review or actual resume chronology is invalid')
    const streamFile = receipt?.streamFile, raw = ownedRegularFile(root, streamFile) ? rawSseFrames(streamFile) : { frames: [], errors: ['Raw resume stream absent'] }
    const traceFile = receipt?.traceFile, trace = ownedRegularFile(root, traceFile) ? readLines(traceFile) : { rows: [], errors: ['Original receive-time trace absent'] }
    const canonical = canonicalEvents(raw.frames), traceCanonical = canonicalEvents(trace.rows), signature = events => JSON.stringify(events.map(({ id, event, data }) => ({ id, event, data })))
    if (trace.errors.length || traceCanonical.errors.length || !traceCanonical.events.length || signature(traceCanonical.events) !== signature(canonical.events)
      || traceCanonical.events.some((event, index, rows) => !Number.isFinite(time(event.at)) || time(event.at) < time(receipt?.startedAt) || index > 0 && time(event.at) < time(rows[index - 1].at))) reasons.push('Original receive-time trace is absent, malformed, stale or contradicts raw resume SSE')
    const runningAt = canonical.events.findIndex(event => event.data.run?.runId === rootRun?.runId && event.data.run?.sessionId === rootRun?.sessionId
      && event.data.run?.status === 'running' && array(event.data.run?.pending).some(item => item.requestId === requestId && item.status === 'answered' && item.output === 'approved'))
    const executed = canonical.events.some((event, index) => {
      const end = event.data.toolEnd ?? event.data.toolResult, job = end?.metadata?.commandJob
      return index > runningAt && runningAt >= 0 && end?.toolCallId === item?.toolCallId && (end.name ?? end.toolName) === item?.toolName && end.rootRunId === rootRun?.runId && end.turnId === rootRun?.turnId
        && end.metadata?.rootRunId === rootRun?.runId && end.metadata?.turnId === rootRun?.turnId && job?.jobId && job.toolCallId === item?.toolCallId && job.runId === rootRun?.runId
        && job.sessionId === rootRun?.sessionId && job.ownerSessionId === rootRun?.sessionId && job.command === item?.args?.command && JSON.stringify(job.args) === JSON.stringify(item?.args?.args)
        && equalPath(job.cwd, item?.args?.cwd) && terminal(job.status) && Number.isFinite(time(job.createdAt)) && time(job.createdAt) >= time(receipt?.startedAt) && time(job.finishedAt) <= time(rootRun?.finishedAt)
    })
    if (raw.errors.length || canonical.errors.length || runningAt < 0 || !executed) reasons.push('Raw resume stream does not prove running recovery and execution of this exact approved tool')
    return { requestId, passed: !reasons.length, reasons, receiptFile, receiptSha256: hashFile(receiptFile), streamFile, streamSha256: hashFile(streamFile), traceFile, traceSha256: hashFile(traceFile), authority: receipt?.manualReview?.authority }
  })
  return { passed: proofs.every(proof => proof.passed), observedRequests: ids.size, proofs }
}

export function qualifyDevelopment(round, baseline, recovery, allowedFiles, invocation) {
  const reasons = [], historicalLimitations = [], files = array(round.files), before = array(round.before)
  const complete = rows => Array.isArray(rows) && JSON.stringify(rows.map(row => row.file).sort()) === JSON.stringify([...allowedFiles].sort())
    && rows.every(row => row.sha256 === null || /^[a-f0-9]{64}$/.test(row.sha256 ?? ''))
  const summary = nodeTestSummary(baseline?.stdout ?? '', round.item?.expectedTests)
  if (!summary.complete || summary.tests !== round.item?.expectedTests || summary.fail < 1 || summary.pass + summary.fail !== summary.tests || summary.skipped || summary.cancelled || summary.todo
    || !Number.isInteger(baseline?.exitCode) || baseline.exitCode === 0 || baseline.timedOut !== false || baseline.signal != null || baseline.error
    || !Number.isFinite(time(baseline?.finishedAt)) || time(baseline.finishedAt) > time(round.rootRun?.createdAt)) reasons.push('Original independent red baseline is incomplete, not failing, or postdates model work')
  if (!complete(files) || !complete(before)) reasons.push('Owned before/after file hash coverage is incomplete')
  const changed = previous => complete(previous) ? files.filter(file => previous.find(old => old.file === file.file)?.sha256 !== file.sha256).map(file => file.file) : []
  const freshChangedOwnedFiles = changed(before)
  const recoveryValid = !!recovery && recovery.evidenceSha256 === hashFile(recovery.evidenceFile) && complete(recovery.before)
    && JSON.stringify(optional(recovery.evidenceFile)?.before) === JSON.stringify(recovery.before)
  const cumulativeChangedOwnedFiles = recoveryValid ? changed(recovery.before) : []
  if (recovery && !recoveryValid) reasons.push('Original recovery implementation proof changed or lacks complete hashes')
  const recoveryCompletion = freshChangedOwnedFiles.length === 0 && cumulativeChangedOwnedFiles.length > 0
  if (!freshChangedOwnedFiles.length && !cumulativeChangedOwnedFiles.length) reasons.push('No fresh or independently retained cumulative implementation change')
  const baselineInvocationObserved = !invocation || baseline?.command?.command === invocation.command?.command && JSON.stringify(baseline.command.args) === JSON.stringify(invocation.command?.args)
    && equalPath(baseline.cwd, invocation.workspace) && typeof baseline.executable === 'string' && path.isAbsolute(baseline.executable)
  if (!baselineInvocationObserved) {
    if (recoveryValid && !baseline?.command && !baseline?.cwd && !baseline?.executable) historicalLimitations.push('Retained original red baseline predates argv/cwd/executable observation; never overwritten or fabricated')
    else reasons.push('Original independent red baseline does not bind the exact frozen Node argv, cwd and executable')
  }
  return { passed: !reasons.length, reasons, historicalLimitations, baselineInvocationObserved, freshEligible: baselineInvocationObserved && !recovery,
    freshChangedOwnedFiles, cumulativeChangedOwnedFiles, recoveryCompletion, baselineSummary: summary }
}

function toolPairs(events) {
  const calls = new Map()
  for (const event of events) {
    const data = event.data ?? event, call = data.toolCall, result = data.toolResult ?? data.toolEnd
    if (call) calls.set(call.toolCallId ?? call.id, { id: call.toolCallId ?? call.id, name: call.name ?? call.toolName, args: call.args, at: time(event.at), call, result: null })
    if (result) { const found = calls.get(result.toolCallId ?? result.id); if (found) { found.resultAt = time(event.at); found.result = { ...found.result, ...result, metadata: { ...found.result?.metadata, ...result.metadata } } } }
  }
  return [...calls.values()]
}

/** Micro-compaction or compression-only audits cannot qualify model development. */
export function qualifyModelCompaction(model, logRows, rounds, contextWindow = 100000) {
  const attempted = rounds.filter(round => round.modelId === model), candidates = [], rejected = []
  for (const event of logRows.filter(row => row.msg === 'Compression done')) {
    const at = time(event.time ?? event.at)
    const owners = attempted.filter(round => round.rootRun?.sessionId === event.sessionId && (event.runId ? round.runId === event.runId : time(round.rootRun?.createdAt) <= at && at <= time(round.rootRun?.finishedAt)))
    if (owners.length !== 1 || owners[0].rootRun?.actualModelId !== model) continue
    const reasons = [], pre = Number(event.preRequestTokens), post = Number(event.postRequestTokens)
    if (!Number.isFinite(at) || !Number.isFinite(pre) || !Number.isFinite(post) || pre <= post || post >= contextWindow || post < 0) reasons.push('Actual pre/post request budgets are missing or did not shrink below 100K')
    const continued = attempted.find(round => round.independentlyQualified && round.kind === 'development' && !round.developmentQualification?.recoveryCompletion && round.developmentQualification?.freshEligible !== false
      && round.sessionId === event.sessionId && time(round.rootRun?.finishedAt) > at
      && round.toolPairs?.some(call => call.result?.success === true && call.at > at && ['write_file', 'edit_file', 'execute_cmd'].includes(call.name)))
    if (!continued) reasons.push('No independently qualified subsequent real development with this model and session')
    const proof = { sessionId: event.sessionId, runId: owners[0].runId, at, preRequestTokens: pre, postRequestTokens: post,
      continuationDispatchId: continued?.dispatchId, passed: !reasons.length, reasons }
    if (proof.passed) candidates.push(proof); else rejected.push(proof)
  }
  return { modelId: model, passed: candidates.length > 0, qualifiedCompactions: candidates, rejectedCompactions: rejected,
    actualModelObserved: attempted.some(round => round.rootRun?.actualModelId === model), qualifiedDevelopmentAttempts: attempted.filter(round => round.independentlyQualified && round.kind === 'development').length }
}

export function qualifyChildActualModel(child, rows, roots) {
  const owners = roots.filter(root => root.sessionId === (child.rootSessionId ?? child.parentSessionId) && root.turnId === child.parentConversationId)
  const owner = owners.length === 1 ? owners[0] : undefined
  const messages = owner ? rows.filter(row => row.sessionId === child.childSessionId && row.tenantId === (child.tenantId ?? 'default') && row.type === 'assistant'
    && row.payload?.modelId && row.payload.metadata?.rootRunId === owner.runId
    && (row.payload.metadata?.turnId ?? row.payload.conversationId ?? row.conversationId) === child.parentConversationId
    && time(row.payload.createdAt ?? row.timestamp) >= time(child.startedAt) && time(row.payload.createdAt ?? row.timestamp) <= time(child.finishedAt) + 2) : []
  const modelIds = [...new Set(messages.map(row => row.payload.modelId))]
  return { passed: !!owner && messages.length > 0 && modelIds.length === 1 && modelIds[0] === child.modelId,
    runId: child.runId, childSessionId: child.childSessionId, requestedModelId: child.modelId, actualAssistantModelIds: modelIds,
    messageIds: messages.map(row => row.payload.id ?? row.uuid), qualification: messages.length ? 'Actual assistant payload modelId, scoped child session, parent root/turn and child execution timestamps' : 'Actual child provider model remains unobserved; configuration is not execution evidence' }
}

function childActualModel(root, child, roots) {
  const file = typeof child?.childSessionId === 'string' ? path.join(root, 'sessions', 'default', child.childSessionId + '.jsonl') : undefined
  const safe = !!file && within(path.join(root, 'sessions', 'default'), file) && fs.existsSync(file) && !fs.lstatSync(file).isSymbolicLink()
  const raw = safe ? readLines(file) : { rows: [], errors: [] }, proof = qualifyChildActualModel(child, raw.rows, roots)
  return { ...proof, passed: safe && !raw.errors.length && proof.passed, evidenceFile: safe ? file : null }
}

function publicDatabaseStates(root, stage) {
  const Database = createRequire(path.join(stage, 'package.json'))('libsql'), uri = pathToFileURL(path.join(root, 'agent.db')); uri.searchParams.set('mode', 'ro')
  const db = new Database(uri.href)
  try {
    db.exec('PRAGMA query_only=ON')
    const select = (table, column, fields) => db.prepare(`SELECT ${fields.map(field => `CASE WHEN json_valid(${column}) THEN json_extract(${column}, '$.${field}') END AS "${field}"`).join(',')} FROM ${table}`).all()
    return { roots: select('root_runs', 'state', ['runId', 'sessionId', 'turnId', 'status', 'modelId', 'actualModelId', 'createdAt', 'startedAt', 'finishedAt', 'pending']).map(row => ({ ...row, pending: typeof row.pending === 'string' ? JSON.parse(row.pending) : row.pending })),
      children: select('subagent_runs', 'snapshot', ['runId', 'tenantId', 'rootSessionId', 'childSessionId', 'parentSessionId', 'parentConversationId', 'parentRunId', 'parentTurnId', 'status', 'modelId', 'actualModelId', 'description', 'createdAt', 'startedAt', 'finishedAt', 'resultSummary', 'partialOutput']),
      jobs: select('command_jobs', 'snapshot', COMMAND_JOB_FIELDS).map(row => ({ ...row, background: row.background == null ? null : Boolean(row.background), args: typeof row.args === 'string' ? JSON.parse(row.args) : row.args })) }
  } finally { db.close() }
}

function publicMemorySources(root, stage, sessionId) {
  const Database = createRequire(path.join(stage, 'package.json'))('libsql'), uri = pathToFileURL(path.join(root, 'memory', 'memory.db')); uri.searchParams.set('mode', 'ro')
  const db = new Database(uri.href)
  try {
    db.exec('PRAGMA query_only=ON')
    // Memory timestamps have one-second resolution. Use the end of that second
    // so a memory created/edited in the current root cannot be called older.
    return db.prepare("SELECT id,summary,detail,created_at,updated_at FROM memory_nodes WHERE tenant_id='default' AND scope='session' AND session_id=?").all(sessionId)
      .map(row => ({ id: row.id, createdAt: (Math.max(Number(row.created_at), Number(row.updated_at)) + 1) * 1000, text: [row.summary, row.detail].filter(Boolean).join('\n') }))
  } finally { db.close() }
}

function archiveSources(root, sessionId) {
  const file = path.join(root, 'sessions', 'default', sessionId + '.jsonl'), rows = readLines(file), messages = new Map()
  for (const row of rows.rows) {
    if (row.type === 'tombstone') {
      if (row.scope === 'clear') messages.clear()
      else if (row.scope === 'message') messages.delete(row.targetUuid)
      else if (row.scope === 'conversation') { for (const [id, message] of messages) if (message.conversationId === row.conversationId) messages.delete(id) }
      else if (row.scope === 'truncate') { for (const [id, message] of messages) if (message.dbSeq > row.afterSeq) messages.delete(id) }
    } else if (row.type === 'update') {
      const previous = messages.get(row.targetUuid)
      if (previous && row.content !== undefined) { previous.text = normalText(row.archiveContent ?? row.modelInputContent ?? row.content) }
    } else if (row.payload) messages.set(row.uuid, { id: row.payload.id ?? row.uuid, createdAt: row.payload.createdAt ?? row.timestamp,
      text: normalText(row.payload.modelInputContent ?? row.payload.content), conversationId: row.conversationId ?? row.payload.conversationId, dbSeq: row.dbSeq })
  }
  return { sources: [...messages.values()], errors: rows.errors }
}

function qualifyRound(root, session, round, db, allChildren) {
  const reasons = [], directory = path.dirname(round.evidenceFile), raw = readLines(path.join(directory, 'events.jsonl')); let canonical = canonicalEvents(raw.rows)
  reasons.push(...raw.errors.map(row => 'Malformed SSE line ' + row.line), ...canonical.errors)
  const request = optional(path.join(directory, 'request.json')), snapshot = optional(path.join(directory, 'snapshot.json'))
  const persisted = db.roots.find(row => row.runId === round.runId), engineRoot = snapshot?.run
  if (!persisted || !engineRoot || snapshot?.sessionId !== session.sessionId || snapshot.finished !== true || persisted.status !== 'succeeded' || engineRoot.status !== 'succeeded' || persisted.runId !== engineRoot.runId
    || persisted.turnId !== engineRoot.turnId || engineRoot.sessionId !== session.sessionId || persisted.sessionId !== session.sessionId || persisted.actualModelId !== round.modelId || engineRoot.actualModelId !== persisted.actualModelId) reasons.push('Actual successful durable model/root identity is missing or contradictory')
  if (request?.sessionId !== session.sessionId || request?.model !== round.modelId || request?.metadata?.continuationDispatchId !== round.dispatchId || request.memoryScope !== 'session') reasons.push('Actual chat request identity/model/session-memory settings do not match')
  if (round.success !== true || round.failureKinds?.length) reasons.push('Driver did not accept this attempt')
  if (!Number.isFinite(time(persisted?.createdAt)) || !Number.isFinite(time(persisted?.finishedAt)) || time(persisted.finishedAt) <= time(persisted.createdAt)) reasons.push('Durable root chronology is missing')
  round.rootRun = persisted ?? engineRoot
  const permissionQualification = qualifyPermissionResolutions(root, round.rootRun, array(round.permissionRequests), round.permissionResolutions)
  if (!permissionQualification.passed) reasons.push('Rejected, unresolved or unproven approval recovery remains')
  if (JSON.stringify(persisted?.pending ?? []) !== JSON.stringify(engineRoot?.pending ?? [])) reasons.push('Final durable pending approvals contradict snapshot state')
  const traces = permissionQualification.proofs.filter(proof => proof.passed).flatMap(proof => readLines(proof.traceFile).rows)
  canonical = canonicalEvents([...raw.rows, ...traces].sort((a, b) => time(a.at) - time(b.at)))
  reasons.push(...canonical.errors)
  const files = array(round.files), children = allChildren.filter(child => child.parentSessionId === session.sessionId && child.description?.startsWith('continuation/review/' + round.requirementId + '/')).sort((a, b) => time(a.startedAt) - time(b.startedAt))
  const reviews = strictReviews(null, children, 'continuation/review/' + round.requirementId + '/', files)
  if (!reviewsPassed(reviews)) reasons.push('Two current successful read-only reviews did not pass')
  const childIds = new Set([...array(round.children).map(child => child.runId), ...Object.values(reviews).map(review => review.runId)])
  const childModels = [...childIds].map(id => allChildren.find(child => child.runId === id)).filter(Boolean).map(child => childActualModel(root, child, db.roots))
  if (childModels.length !== childIds.size || childModels.some(proof => !proof.passed)) reasons.push('Actual child assistant model/root/turn execution evidence missing or contradictory')
  if (array(round.children).some(child => child.modelId !== round.modelId || child.actualModelId && child.actualModelId !== round.modelId)) reasons.push('Current child model mismatch')
  const after = Math.max(0, ...files.map(file => file.modifiedAtMs ?? 0), ...Object.values(reviews).map(review => review.finishedAt ?? 0))
  const verifications = array(round.verifications).map((verification, index) => {
    const expected = expectedContractTests(session.workspace, verification.command ?? { args: [] })
    const check = qualifyNodeEvidence(verification, text(path.join(directory, 'verification-' + (index + 1) + '.txt')), expected, time(persisted?.finishedAt))
    if (!check.passed) reasons.push('Independent contract ' + index + ': ' + check.reasons.join('; '))
    const snapshotJobs = array(snapshot?.commandJobs)
    const fresh = freshParentTests(snapshotJobs, round.runId, session.workspace, verification.command ?? {}, after)
    const parentCommands = fresh.map(job => {
      const retained = db.jobs.find(row => row.jobId === (job.jobId ?? job.id))
      return qualifyParentCommand({ job, retained, events: canonical.events, rootRun: persisted, sessionId: session.sessionId,
        workspace: session.workspace, command: verification.command, expected, after })
    })
    const matched = parentCommands.filter(proof => proof.passed)
    if (!matched.length) reasons.push('Fresh post-review parent contract command lacks agreeing raw SSE + durable/snapshot evidence')
    return { passed: check.passed && matched.length > 0, summary: check.summary, parentJobIds: matched.map(proof => proof.jobId), parentCommands }
  })
  if (!verifications.length) reasons.push('No independent project contracts')
  let developmentQualification
  if (round.kind === 'development') {
    const baseline = optional(path.join(root, 'requirements', 'frozen', round.requirementId, 'baseline.json'))
    developmentQualification = qualifyDevelopment(round, baseline, session.recoveryImplementation?.[round.requirementId], array(session.role?.allowedFiles), { workspace: session.workspace, command: { command: 'node', args: [round.item?.testFile, session.workspace] } })
    reasons.push(...developmentQualification.reasons)
    for (const proof of Object.values(round.item?.frozenHashes ?? {})) if (!proof?.path || hashFile(proof.path) !== proof.sha256) reasons.push('Frozen contract/design/test hash changed')
    if (!Object.keys(round.item?.frozenHashes ?? {}).length) reasons.push('No frozen independent contract hashes')
  }
  const calls = toolPairs(canonical.events)
  const ownerViolations = ownershipViolations(session.workspace, array(session.role?.allowedFiles), canonical.events.map(row => row.data), array(round.children))
  if (ownerViolations.length || round.protectedViolations?.length || round.errors?.length) reasons.push('Ownership, protected source or runtime failure')
  return { ...round, independentlyQualified: !reasons.length, qualificationReasons: [...new Set(reasons)], developmentQualification, verificationsQualification: verifications,
    toolPairs: calls.map(call => ({ ...call, sourceEventFiles: [path.join(directory, 'events.jsonl'), ...permissionQualification.proofs.filter(proof => proof.passed).map(proof => proof.traceFile)] })), rawEvents: canonical.events, childModelEvidence: childModels, permissionQualification, advertisedTools: array(request?.allowedTools).filter(name => typeof name === 'string'), runningIntervals: runningIntervals(canonical.events, round.rootRun) }
}

/** Supplemental proof requires independent raw assertions consuming hashed engine evidence. */
export function qualifyFeatureProof(entry, root, successfulCalls, context = {}) {
  const reasons = [], proof = entry?.proof
  const modes = ['agent-semantic', 'client-semantic', 'live-api-semantic', 'engine-regression']
  if (!modes.includes(entry?.mode) || proof?.checker !== 'node-test') reasons.push('Unknown semantic scope or independent checker')
  const file = typeof proof?.file === 'string' ? path.resolve(root, proof.file) : undefined, report = file && optional(file)
  const ownedFile = filename => typeof filename === 'string' && within(root, path.resolve(root, filename)) && fs.existsSync(path.resolve(root, filename)) && !fs.lstatSync(path.resolve(root, filename)).isSymbolicLink()
  if (!file || !ownedFile(proof?.file) || hashFile(file) !== proof?.sha256 || !report?.independent) reasons.push('Independent semantic report is missing, changed, or unowned')
  if (!ownedFile(proof?.sourceFile) || hashFile(path.resolve(root, proof.sourceFile)) !== proof.sourceSha256) reasons.push('Independent assertion source hash missing or changed')
  if (!Array.isArray(proof?.inputFiles) || !proof.inputFiles.length || proof.inputFiles.some(item => !ownedFile(item?.file) || hashFile(path.resolve(root, item.file)) !== item.sha256)) reasons.push('Actual asserted engine/fixture input hashes missing or changed')
  const checked = qualifyNodeEvidence(report, report?.stdout ?? '', proof?.expectedTests)
  reasons.push(...checked.reasons)
  if (!context.buildId || proof?.buildId !== context.buildId || report?.buildId !== context.buildId || Number.isFinite(time(context.frozenAt)) && time(report?.startedAt) < time(context.frozenAt)) reasons.push('Actual candidate build identity or fresh frozen chronology does not match semantic proof')
  const inputFiles = array(proof?.inputFiles).filter(record), includesInput = file => typeof file === 'string' && inputFiles.some(item => item.sha256 === hashFile(file))
  const management = ['memory.session-crud', 'memory.global-crud', 'skills.crud', 'skills.file-import', 'mcp.config-json', 'knowledge.crud', 'knowledge.format-extraction']
  if (entry?.mode === 'agent-semantic') {
    if (!Array.isArray(entry?.bindings) || !entry.bindings.length || entry.bindings.some(binding => !record(binding) || !successfulCalls.some(call => call.dispatchId === binding.dispatchId && call.id === binding.toolCallId && (!binding.name || binding.name === call.name)))) reasons.push('No matching successful raw Agent tool invocation for semantic assertion')
    const bound = array(entry?.bindings).map(binding => successfulCalls.find(call => call.dispatchId === binding?.dispatchId && call.id === binding?.toolCallId)).filter(Boolean)
    if (bound.some(call => !Number.isFinite(call.resultAt) || time(report?.startedAt) + 2 < call.resultAt || !(call.sourceEventFiles ?? [call.eventsFile]).every(includesInput))) reasons.push('Semantic assertions precede actual Agent results or omit the exact retained original/resume SSE source')
  } else if (entry?.mode === 'client-semantic') {
    if (!management.includes(entry.feature) && !entry.feature?.startsWith('client.') && !entry.feature?.startsWith('knowledge.format:') && !['terminal.interactive-clipboard-resize', 'skills.archive-drag-import'].includes(entry.feature)) reasons.push('Client interaction proof does not qualify this Agent execution capability')
    if (!context.clientPassed || !includesInput(context.clientFile) || !array(entry.clientChecks).length || array(entry.clientChecks).some(name => !array(context.client?.checks).some(check => check.name === name && check.passed === true))) reasons.push('Actual full client report or exact passed workflow identities are missing')
    if (time(report?.startedAt) + 2 < time(context.client?.finishedAt)) reasons.push('Client semantic checker preceded the actual client workflow')
  } else if (entry?.mode === 'live-api-semantic') {
    if (!management.includes(entry.feature) && !entry.feature?.startsWith('knowledge.format:')) reasons.push('Management API proof does not qualify this Agent execution or client interaction capability')
    const httpFile = typeof proof?.httpEvidenceFile === 'string' ? path.resolve(root, proof.httpEvidenceFile) : undefined, raw = httpFile ? readLines(httpFile) : { rows: [], errors: ['absent'] }
    const bound = array(entry.httpBindings).map(binding => raw.rows.find(row => row.requestId === binding?.requestId && row.method === binding?.method && row.route === binding?.route))
    if (!includesInput(httpFile) || raw.errors.length || !bound.length || bound.some(row => !row || row.buildId !== context.buildId || row.base !== context.base
      || !Number.isFinite(time(row.startedAt)) || !Number.isFinite(time(row.finishedAt)) || time(row.startedAt) < time(context.frozenAt) || time(row.finishedAt) < time(row.startedAt)
      || time(row.finishedAt) > time(report?.startedAt) + 2 || !Number.isInteger(row.httpStatus) || row.httpStatus < 200 || row.httpStatus >= 300 || !record(row.response))) reasons.push('Actual successful fresh candidate HTTP request/response evidence is missing or mismatched')
  }
  const regressionPassed = !reasons.length
  if (entry?.mode === 'engine-regression') reasons.push('Regression correctness remains separate from actual Agent, client or live API semantic use')
  return { passed: !reasons.length, regressionPassed, mode: entry?.mode, reasons: [...new Set(reasons)], evidenceFile: file, testSummary: checked.summary }
}

/** Three nominal sampling cycles are an explicit evidence-gap tolerance. */
export function samplingCoverage(samples, lifecycle, intervalMs) {
  const reasons = [], phases = array(lifecycle).filter(row => record(row) && Number.isFinite(time(row.at)))
  if (phases.length !== array(lifecycle).length || phases.some((row, index) => index > 0 && time(row.at) < time(phases[index - 1].at))) reasons.push('Lifecycle timestamps are malformed or out of order')
  const windows = []; let start
  for (const row of phases) {
    if (row.phase === 'active' && start === undefined) start = time(row.at)
    if (row.phase !== 'active' && start !== undefined) { windows.push({ from: start, to: time(row.at) }); start = undefined }
  }
  if (start !== undefined) reasons.push('Active lifecycle has no retained completion boundary')
  if (!windows.length || windows.some(window => window.to <= window.from)) reasons.push('No completed positive active lifecycle interval')
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) reasons.push('Nominal telemetry sampling interval is absent or invalid')
  const rows = array(samples), valid = rows.filter(row => record(row) && Number.isFinite(time(row.at)))
  if (valid.length !== rows.length || valid.some((row, index) => index > 0 && time(row.at) < time(valid[index - 1].at))) reasons.push('Sample timestamps are malformed or out of order')
  if (valid.some((row, index) => index > 0 && Number.isInteger(row.sequence) && Number.isInteger(valid[index - 1].sequence) && row.sequence <= valid[index - 1].sequence)) reasons.push('Sample sequence is duplicate or goes backwards')
  const gapToleranceMs = Number.isFinite(intervalMs) ? intervalMs * 3 : null
  const intervals = windows.map(window => {
    const points = valid.filter(row => time(row.at) >= window.from && time(row.at) <= window.to).map(row => time(row.at))
    const boundaries = [window.from, ...points, window.to], gaps = boundaries.slice(1).map((at, index) => at - boundaries[index])
    const maxGapMs = Math.max(0, ...gaps), passed = points.length > 0 && maxGapMs <= gapToleranceMs
    if (!passed) reasons.push('Active telemetry is absent or has an uncovered gap longer than three nominal cycles')
    return { ...window, samples: points.length, firstAt: points[0] ?? null, lastAt: points.at(-1) ?? null, maxGapMs, passed }
  })
  return { passed: !reasons.length, reasons: [...new Set(reasons)], intervalMs, gapToleranceMs, activeSpanMs: windows.reduce((sum, window) => sum + Math.max(0, window.to - window.from), 0), intervals }
}

export function qualifyBuildFreeze(freeze) {
  const reasons = []; let currentSource, currentStage, initialAgreement, source, stage
  try {
    if (!freeze?.artifactRoot || !freeze.stageRoot || !freeze.source?.runtimeProduction?.fileCount || !freeze.stage?.runtimeProduction?.fileCount) throw new Error('Frozen source/stage paths or full production runtime inventory absent')
    initialAgreement = compareBuildArtifacts(freeze.source, freeze.stage)
    currentSource = captureBuildArtifacts(freeze.artifactRoot, { requireNodePty: true, requireNodePtyPatch: true })
    currentStage = captureBuildArtifacts(freeze.stageRoot, { requireNodePty: true, requireNodePtyPatch: true })
    source = compareBuildArtifacts(freeze.source, currentSource); stage = compareBuildArtifacts(freeze.stage, currentStage)
    if (!initialAgreement.unchanged || !source.unchanged || !stage.unchanged) reasons.push('Actual frozen initial or current two-end build inventory differs')
  } catch (error) { reasons.push('Actual current two-end build capture unavailable: ' + error.message) }
  return { passed: !reasons.length, reasons, initialAgreement, source, stage, currentSourceFingerprintSha256: currentSource?.fingerprintSha256, currentStageFingerprintSha256: currentStage?.fingerprintSha256 }
}

function telemetry(root, lifecycle) {
  const phaseAt = at => lifecycle.filter(row => time(row.at) <= time(at)).at(-1)?.phase
  const health = readLines(path.join(root, 'continuation-health.jsonl')), monitor = readLines(path.join(root, 'engine-monitor.jsonl')), runtime = readLines(path.join(root, 'runtime.jsonl'))
  const pid = Number(optional(path.join(root, 'engine.pid.json'))?.pid), activeHealth = health.rows.filter(row => row.phase === 'active'), samples = monitor.rows.filter(row => row.type === 'sample' && row.enginePid === pid && phaseAt(row.at) === 'active')
  const runtimeSamples = runtime.rows.filter(row => row.pid === pid && row.type === 'runtime-sample' && phaseAt(row.at) === 'active')
  const reasons = []
  if (!Number.isSafeInteger(pid) || pid <= 0) reasons.push('Recorded main-thread owner PID absent or invalid')
  if (!activeHealth.length || activeHealth.some(row => row.status !== 200 || row.error)) reasons.push('Active runtime health absent or failed')
  if (!samples.length || samples.some(row => row.errors?.length) || monitor.rows.some(row => row.type === 'error')) reasons.push('Owned process-tree monitor coverage absent or incomplete')
  if (!runtimeSamples.length || runtimeSamples.some(row => row.writeErrors > 0)) reasons.push('Owned main-thread runtime samples absent or failed')
  if (health.errors.length || monitor.errors.length || runtime.errors.length) reasons.push('Malformed telemetry evidence')
  const monitorStart = monitor.rows.filter(row => row.type === 'start' && row.enginePid === pid), runtimeStart = runtime.rows.filter(row => row.type === 'runtime-start' && row.pid === pid)
  if (monitorStart.length !== 1 || runtimeStart.length !== 1) reasons.push('Owned process/runtime sampling start identity is absent or ambiguous')
  const coverage = { health: samplingCoverage(activeHealth, lifecycle, 10000), process: samplingCoverage(samples, lifecycle, monitorStart[0]?.intervalMs), runtime: samplingCoverage(runtimeSamples, lifecycle, runtimeStart[0]?.intervalMs) }
  for (const [name, result] of Object.entries(coverage)) if (!result.passed) reasons.push(name + ' coverage: ' + result.reasons.join('; '))
  return { passed: !reasons.length, reasons, healthSamples: activeHealth.length, processSamples: samples.length, runtimeSamples: runtimeSamples.length,
    coverage,
    peakProcessTreeRssBytes: Math.max(0, ...samples.map(row => row.rssBytes ?? 0)), peakMainHeapUsedBytes: Math.max(0, ...runtimeSamples.map(row => row.memory?.heapUsedBytes ?? 0)),
    maxObservedEventLoopDelayMs: Math.max(0, ...runtimeSamples.map(row => row.delayMs?.max ?? 0)), scope: 'Engine tree and owned main thread; independent Node tests and Electron are separate resource consumers.' }
}

export function analyzeContinuation(root) {
  root = fs.realpathSync(root)
  const problems = [], notes = [], state = optional(path.join(root, 'continuation-state.json')), report = optional(path.join(root, 'active-report.json')), checkpoint = optional(path.join(root, 'checkpoint.json'))
  const sessions = array(report?.sessions ?? checkpoint?.sessions).filter(record), lifecycle = readLines(path.join(root, 'continuation-lifecycle.jsonl')), resources = optional(path.join(root, 'resources.json')) ?? {}
  if (!state || !equalPath(state.root, root) || !report || !equalPath(report.root, root) || !equalPath(checkpoint?.root, root)) problems.push('Owned continuation state/checkpoint/report identity missing')
  if (sessions.length !== 5 || new Set(sessions.map(row => row.sessionId)).size !== 5 || new Set(sessions.map(row => row.roleId)).size !== 5) problems.push('Five unique retained sessions/roles missing')
  const projects = new Map(); for (const session of sessions) projects.set(session.workspace, (projects.get(session.workspace) ?? 0) + 1)
  if (JSON.stringify([...projects.values()].sort()) !== '[2,3]') problems.push('Two retained projects must have three and two collaborating sessions')
  const modelPreflight = optional(path.join(root, 'model-preflight.json'))
  if (state?.contextWindow !== 100000 || !MODELS.every(model => array(modelPreflight?.models).some(row => row.modelId === model && row.contextWindow === 100000))) problems.push('All five actual enabled models need explicit 100000-context preflight')
  const cleanup = optional(path.join(root, 'continuation-cleanup.json')), stopped = optional(path.join(root, 'supervisor-status.json'))?.phase === 'stopped'
  const cleanupPassed = stopped && cleanup?.inventoryComplete === true && Array.isArray(cleanup.remaining) && !cleanup.remaining.length && Array.isArray(cleanup.errors) && !cleanup.errors.length
  if (!cleanupPassed) problems.push('Owned stopped process cleanup has not been independently established')
  let db = { roots: [], children: [], jobs: [] }, databases = { passed: false }
  try {
    const stage = cleanup?.databaseAudit?.stage
    if (!stage) throw new Error('Frozen native libsql runtime path absent')
    databases = continuationDatabaseAudit(root, stage); db = publicDatabaseStates(root, stage)
  } catch (error) { databases.error = error.message }
  if (!databases.passed) problems.push('Current authoritative native-libsql ANN/integrity/terminal-state audit failed or missing')
  const rounds = [], evidenceErrors = [], dispatches = new Map()
  for (const session of sessions) for (const compact of array(session.rounds)) {
    if (!record(compact)) { evidenceErrors.push('Checkpoint round entry is malformed'); continue }
    const file = compact.evidenceFile
    if (!file || !within(root, file) || !fs.existsSync(file) || fs.lstatSync(file).isSymbolicLink()) { evidenceErrors.push('Fresh round evidence is absent or outside this continuation'); continue }
    const round = optional(file)
    if (!record(round)) { evidenceErrors.push('Round evidence is malformed'); continue }
    if (round.sessionId !== session.sessionId || round.roleId !== session.roleId || round.dispatchId !== compact.dispatchId) { evidenceErrors.push('Round identity does not match checkpoint'); continue }
    if (dispatches.has(round.dispatchId)) { evidenceErrors.push('Duplicate dispatch identity'); continue }
    dispatches.set(round.dispatchId, round.runId)
    try { rounds.push(qualifyRound(root, session, round, db, db.children)) }
    catch (error) { evidenceErrors.push('Invalid round evidence ' + round.dispatchId + ': ' + error.message) }
  }
  problems.push(...evidenceErrors)
  if (lifecycle.errors.length) problems.push('Malformed supervisor lifecycle evidence')
  const qualified = rounds.filter(round => round.independentlyQualified), fresh = qualified.filter(round => round.kind === 'development' && round.developmentQualification?.freshEligible === true)
  for (const session of sessions) if (!fresh.some(round => round.sessionId === session.sessionId)) problems.push('No independently qualified fresh development for session ' + session.index)
  const failed = rounds.filter(round => !round.independentlyQualified)
  for (const session of sessions) {
    const latest = qualified.filter(round => round.sessionId === session.sessionId).sort((a, b) => time(a.rootRun?.finishedAt) - time(b.rootRun?.finishedAt)).at(-1)
    for (const file of latest?.files ?? []) if (!within(session.workspace, path.resolve(session.workspace, file.file)) || hashFile(path.resolve(session.workspace, file.file)) !== file.sha256) problems.push('Implementation changed after final qualified milestone for session ' + session.index)
  }
  if (sessions.some(session => session.errors?.length || session.pending || session.status === 'failed')) problems.push('Session worker failure or unreconciled dispatch remains')
  const clock = overlapIntervals(rounds.flatMap(round => round.runningIntervals)), developmentClock = overlapIntervals(fresh.flatMap(round => round.runningIntervals))
  const start = Math.min(Infinity, ...fresh.map(round => time(round.rootRun?.createdAt)).filter(Number.isFinite)), finish = time(report?.finishedAt)
  const wallSpanMs = Number.isFinite(start) && Number.isFinite(finish) ? finish - start : 0
  const requestedMs = Number(checkpoint?.durationMs)
  if (!Number.isFinite(requestedMs) || requestedMs < 360 * 60000 || wallSpanMs < requestedMs) problems.push('Fresh requested six-hour load span not completed')
  if (!Number.isFinite(start) || time(checkpoint?.firstQualifiedDevelopmentAt) !== start) problems.push('Qualified six-hour clock anchor does not match the earliest independently qualified fresh durable root')
  if (!clock.allFiveOverlapMs || !developmentClock.allFiveOverlapMs) problems.push('Five actual running sessions and qualified fresh-development overlap are both required')
  const engineLog = readLines(resources.engineLogFile ?? path.join(root, 'engine.out.log')), compactions = MODELS.map(model => qualifyModelCompaction(model, engineLog.rows, rounds))
  for (const model of compactions) if (!model.passed) problems.push('Actual auto-compaction budgets and subsequent development missing for ' + model.modelId)
  const oracle = optional(path.join(root, 'history-oracle.json')), history = []
  for (const session of sessions) {
    const spec = array(oracle?.sessions).find(row => row.sessionId === session.sessionId), source = archiveSources(root, session.sessionId)
    try { source.sources.push(...publicMemorySources(root, cleanup?.databaseAudit?.stage, session.sessionId)) }
    catch { source.errors.push({ source: 'session-memory', reason: 'Native scoped source read unavailable' }) }
    const required = [...array(spec?.probes).filter(probe => !array(spec?.corrections).length || probe.id !== 'current-quota'), ...array(spec?.corrections).flatMap(correction => array(correction.probes))]
    const probes = new Map()
    for (const round of qualified.filter(row => row.sessionId === session.sessionId)) {
      const directory = path.dirname(round.evidenceFile), answer = text(path.join(directory, 'assistant-answer.txt')), request = optional(path.join(directory, 'request.json'))
      const eligible = required.filter(probe => array(round.verifiedRetrieval?.probes).some(row => row.id === probe.id) && !(spec?.seedMessage && request?.message?.includes(spec.seedMessage))
        && !array(spec?.corrections).some(correction => request?.message?.includes(correction.message) && array(correction.probes).some(row => row.id === probe.id)))
      if (!eligible.length) continue
      const recall = evaluateRecall(eligible, answer, round.firstToolOffset ?? Infinity)
      const retrieval = evaluateRetrieval(eligible, answer, round.rawEvents.map(row => row.data), source.sources, round.rootRun?.createdAt)
      for (const probe of eligible) if (retrieval.probes.some(row => row.id === probe.id && row.passed)) probes.set(probe.id, { id: probe.id, kind: probe.kind, verifiedRetrieval: true, unaidedRecall: recall.probes.some(row => row.id === probe.id && row.passed) && recall.beforeTools,
        dispatchId: round.dispatchId, afterCompaction: engineLog.rows.some(row => row.sessionId === session.sessionId && row.msg === 'Compression done' && time(row.time) < time(round.rootRun.createdAt)) })
    }
    const passed = required.length > 0 && required.every(probe => probes.get(probe.id)?.afterCompaction === true) && !source.errors.length
    history.push({ sessionId: session.sessionId, passed, requiredProbeIds: required.map(probe => probe.id), verified: [...probes.values()], missing: required.filter(probe => !probes.has(probe.id)).map(probe => probe.id) })
    if (!passed) problems.push('Private exact/superseded/unfinished history probes after compaction missing for session ' + session.index)
  }
  const semantic = optional(path.join(root, 'semantic-engine-acceptance.json')), requiredSemantic = ['cross-language-semantic-without-keyword-overlap', 'durable-reopen', 'actual-production-automatic-recall-block', 'edited-memory-invalidates-stale-vector']
  const semanticPassed = semantic?.passed === true && requiredSemantic.every(name => array(semantic.checks).some(check => check.name === name && check.passed)) && array(semantic.backfill).length >= 6
    && array(semantic.backfill).every(row => row.passed && row.nodes === row.vectors) && array(semantic.cleanup).length > 0 && array(semantic.cleanup).every(row => row.deleted === true && !row.error)
  if (!semanticPassed) problems.push('Real semantic engine memory, scoped vector backfill, automatic recall and probe cleanup incomplete')
  const crud = optional(path.join(root, 'knowledge-crud-recheck.json')) ?? resources.knowledgeApiAcceptance
  const knowledgePassed = crud?.passed === true && crud.crud?.createReadVerified === true && crud.crud.updateReadVerified === true && crud.crud.deleteReadVerified === true
  const freeze = optional(path.join(root, 'continuation-freeze.json')), artifacts = readLines(path.join(root, 'continuation-artifacts.jsonl'))
  const buildQualification = qualifyBuildFreeze(freeze), artifactCoverage = samplingCoverage(artifacts.rows.filter(row => row.phase === 'active'), lifecycle.rows, 10000)
  const buildPassed = buildQualification.passed && artifactCoverage.passed && artifacts.rows.length > 0 && !artifacts.errors.length
    && artifacts.rows.every(row => row.source?.unchanged === true && row.client?.unchanged === true
      && row.source.beforeFingerprintSha256 === freeze.source.fingerprintSha256 && row.source.afterFingerprintSha256 === freeze.source.fingerprintSha256
      && row.client.beforeFingerprintSha256 === freeze.stage.fingerprintSha256 && row.client.afterFingerprintSha256 === freeze.stage.fingerprintSha256)
  if (!buildPassed) problems.push('Two-end frozen artifact identity/drift evidence incomplete')
  const gate = optional(path.join(root, 'START_DRIVER')), clientFile = gate?.clientAcceptanceFile ?? path.join(root, 'client-acceptance.json'), client = optional(clientFile)
  const clientQualification = qualifyClientEvidence(client, clientFile, freeze?.source?.manifest?.buildId, freeze?.at), clientPassed = clientQualification.passed
  if (!clientPassed) problems.push('Fresh actual Electron/remote client workflows and build identity not independently proven')
  const telemetryResult = telemetry(root, lifecycle.rows); if (!telemetryResult.passed) problems.push(...telemetryResult.reasons)
  const protectedSnapshot = optional(path.join(root, 'protected-baseline.json'))
  const protectedPassed = !!protectedSnapshot && verifyProtectedEvidence({ files: new Map(Object.entries(protectedSnapshot.files ?? {})), directories: new Map(Object.entries(protectedSnapshot.directories ?? {})) }).length === 0
  if (!protectedPassed) problems.push('Protected original contracts or scaffolding hashes changed/missing')
  const finalProjects = array(report?.projectAcceptance)
  const projectPassed = finalProjects.length === 2 && finalProjects.every(test => {
    const workspace = sessions.find(session => session.projectId === test.projectId)?.workspace
    return !!workspace && qualifyNodeEvidence(test, test.stdout ?? '', expectedContractTests(workspace, test.command ?? { args: [] })).passed
  })
  if (!projectPassed) problems.push('Both final retained project cumulative regressions incomplete')
  const successfulCalls = qualified.flatMap(round => round.toolPairs.filter(call => call.result?.success === true).map(call => ({ ...call, dispatchId: round.dispatchId, eventsFile: path.join(path.dirname(round.evidenceFile), 'events.jsonl') })))
  const manifest = optional(path.join(root, 'continuation-qualification-evidence.json'))
  const supplementalFeatures = array(manifest?.features).filter(record)
  const advertisedTools = [...new Set([...array(resources.requiredTools), ...rounds.flatMap(round => round.advertisedTools ?? [])])].filter(name => typeof name === 'string')
  const knowledgeFormats = array(resources.supportedKnowledgeFormats?.extensions).filter(extension => typeof extension === 'string')
  const builtin = new Map([['models.cross-provider', MODELS.every(model => fresh.some(round => round.modelId === model && round.rootRun?.actualModelId === model))], ['context.auto-compaction', compactions.every(row => row.passed)], ['history.raw-archive', history.length === 5 && history.every(row => row.passed)],
    ['memory.semantic', semanticPassed], ['knowledge.crud', knowledgePassed], ['subagents.reviews', qualified.length > 0], ['storage.database-cleanup', cleanupPassed && databases.passed], ['runtime.telemetry', telemetryResult.passed], ['build.two-end', buildPassed]])
  const features = [...new Set([...REQUIRED_FEATURES, ...advertisedTools.map(name => 'tool:' + name), ...knowledgeFormats.map(extension => 'knowledge.format:' + extension), ...supplementalFeatures.map(entry => entry.feature)])].filter(feature => typeof feature === 'string').map(feature => {
    const supplemental = supplementalFeatures.filter(entry => entry.feature === feature).map(entry => qualifyFeatureProof(entry, root, successfulCalls, { buildId: freeze?.source?.manifest?.buildId, frozenAt: freeze?.at, base: optional(path.join(root, 'supervisor-status.json'))?.base, clientFile, client, clientPassed })), passed = builtin.get(feature) === true || supplemental.some(proof => proof.passed)
    const tool = feature.startsWith('tool:') ? feature.slice(5) : undefined
    return { feature, status: passed ? 'qualified' : tool && successfulCalls.some(call => call.name === tool) ? 'used_unqualified' : 'untested',
      invocations: tool ? successfulCalls.filter(call => call.name === tool).length : undefined, semanticProofs: supplemental,
      qualification: passed ? 'Independent semantic gate satisfied' : 'Invocation, enabled configuration, inherited evidence or elapsed time cannot establish semantic correctness' }
  })
  const missingFeatures = features.filter(feature => feature.status !== 'qualified').map(feature => feature.feature)
  if (missingFeatures.length) problems.push(missingFeatures.length + ' advertised feature/tool semantics remain unqualified')
  if (report?.acceptance?.passed === true) notes.push('Driver elapsed/claimed acceptance is not used as independent proof.')
  notes.push('Recovery-completion milestones and inherited successes are excluded from fresh qualified development time.', 'Recorded model IDs establish local routing, not the gateway physical implementation.', 'A six-hour run does not establish 7×24 unattended reliability or a universal server capacity limit.')
  return { protocolVersion: 'continuation-independent-qualification-1', at: new Date().toISOString(), root, passed: !problems.length, problems: [...new Set(problems)], notes,
    duration: { requestedMs, wallSpanMs, firstActualRootAt: Number.isFinite(start) ? new Date(start).toISOString() : null, actualRunning: clock, qualifiedFreshDevelopment: developmentClock },
    sevenByTwentyFour: { established: false, reason: 'Requires separate sustained unattended reliability evidence; a six-hour run cannot establish continuous 7×24 operation.' },
    rates: { attempts: rounds.length, independentlyQualified: qualified.length, rejected: failed.length, freshDevelopment: fresh.length, recoveryCompletions: qualified.filter(round => round.developmentQualification?.recoveryCompletion).length },
    attempts: rounds.map(round => ({ dispatchId: round.dispatchId, runId: round.runId, sessionId: round.sessionId, requirementId: round.requirementId, modelId: round.modelId, actualModelId: round.rootRun?.actualModelId,
      claimedSuccess: round.success, independentlyQualified: round.independentlyQualified, reasons: round.qualificationReasons, development: round.developmentQualification, childModelEvidence: round.childModelEvidence, evidenceFile: round.evidenceFile })),
    modelCompactions: compactions, privateHistory: history, features, qualifiedFeatures: features.filter(row => row.status === 'qualified').map(row => row.feature), unqualifiedFeatures: missingFeatures,
    advertisedInventory: { tools: advertisedTools, knowledgeFormats }, gates: { semanticPassed, knowledgePassed, buildPassed, clientPassed, protectedPassed, projectPassed, cleanupPassed }, buildQualification, artifactCoverage, clientQualification, databases, telemetry: telemetryResult,
    preservedPriorEvidence: optional(path.join(root, 'recovery-history.json')) ? { file: path.join(root, 'recovery-history.json'), sha256: hashFile(path.join(root, 'recovery-history.json')), priorFailuresRemainSeparate: true } : null }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (!process.argv[2]) throw new Error('Usage: node analyze-continuation.mjs RUN_ROOT [--output NEW_JSON_FILE]')
  const result = analyzeContinuation(process.argv[2]), outputIndex = process.argv.indexOf('--output')
  if (outputIndex >= 0) {
    if (!process.argv[outputIndex + 1]) throw new Error('New output filename required')
    const file = path.resolve(process.argv[outputIndex + 1]); fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' })
  }
  console.log(JSON.stringify(result, null, 2)); process.exitCode = result.passed ? 0 : 2
}
