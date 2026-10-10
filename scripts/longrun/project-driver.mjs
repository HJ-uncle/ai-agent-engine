import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { workloadBudget } from './workload-budget.mjs'
export { workloadBudget } from './workload-budget.mjs'

const now = () => new Date().toISOString()
const sha = value => createHash('sha256').update(value).digest('hex')
const terminal = value => ['succeeded', 'failed', 'cancelled', 'blocked', 'interrupted', 'timed_out'].includes(value)
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
const errorInfo = error => ({ name: error?.name, message: String(error?.message ?? error), code: error?.code })
const redact = value => {
  if (Array.isArray(value)) return value.map(redact)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, /^(apiKey|modelApiKey|authorization|password|secret|token|accessToken|refreshToken)$/i.test(key) ? '[redacted]' : redact(item)]))
  return value
}
const write = (filename, data) => { fs.mkdirSync(path.dirname(filename), { recursive: true }); fs.writeFileSync(filename, JSON.stringify(redact(data), null, 2) + '\n') }
const append = (filename, data) => fs.appendFileSync(filename, JSON.stringify(redact(data)) + '\n')

const within = (root, candidate) => { const relative = path.relative(path.resolve(root), path.resolve(candidate)); return relative !== '' && !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative) }
const timestamp = value => typeof value === 'number' ? value : typeof value === 'string' ? (/^\d+(?:\.\d+)?$/.test(value) ? Number(value) : Date.parse(value)) : NaN
export function apiEnvelope(response, body, route = '') {
  const code = Number(body?.code)
  if (!response.ok || !body || typeof body !== 'object' || !['number', 'string'].includes(typeof body.code) || String(body.code).trim() === '' || ![200,20000].includes(code) || body.success === false || body.error) {
    const error = new Error(`${route}: HTTP ${response.status}, code ${body?.code}: ${body?.message ?? body?.error?.message ?? 'Invalid API envelope'}`)
    error.httpStatus = response.status; error.businessCode = body?.code; throw error
  }
  return body.data
}

export function currentTurnChildren(children, rootRun, sessionId) {
  if (!rootRun?.turnId || !Array.isArray(children)) return []
  return children.filter(child => child.parentConversationId === rootRun.turnId && (!sessionId || child.parentSessionId === sessionId))
}

export function stageDependencies(session, stage, sessions) {
  const waiting = [], blockers = []
  for (const dependency of stage.dependencies ?? []) {
    const peer = sessions.find(candidate => candidate.projectId === session.projectId && candidate.roleId === dependency.role)
    const label = `${dependency.role}/S${dependency.stage}`
    if (!peer) { blockers.push(`${label}: required role missing from ${session.projectId}`); continue }
    // A peer failing later cannot invalidate an already accepted prerequisite.
    if (peer.completedStage >= dependency.stage) continue
    if (Array.isArray(peer.role?.stages) && !peer.role.stages.some(candidate => candidate.index === dependency.stage)) {
      blockers.push(`${label}: required stage does not exist`); continue
    }
    if (peer.errors?.length || ['failed', 'completed'].includes(peer.status)) blockers.push(`${label}: dependency ended before required acceptance`)
    else waiting.push(label)
  }
  return { ready: waiting.length === 0 && blockers.length === 0, waiting, blockers }
}

export async function runStageAttempts({ session, stage, attempt, publish, maxAttempts = 3, deadlineMs, shouldStop = () => false, currentTime = Date.now }) {
  let previous
  for (let number = 0; number < maxAttempts; number++) {
    if (shouldStop() || currentTime() >= deadlineMs) throw new Error('No further attempt after workload deadline or stop request')
    // attempt resolves only after its cancellation/snapshot checks have settled.
    const result = await attempt(number, previous)
    session.rounds.push(result); await publish(session)
    if (result.success) { session.completedStage = stage.index; await publish(session); return result }
    previous = result
    if (result.protectedViolations.length || result.ownershipViolations.length) throw new Error('Protected files or peer ownership violated')
  }
  throw new Error(`Stage ${stage.index} did not recover after ${maxAttempts} attempts`)
}

export function ownershipViolations(workspace, allowedFiles, events, children = []) {
  const calls = [...events.flatMap(event => event.toolCall ? [event.toolCall] : []), ...children.flatMap(child => child.toolCalls ?? [])]
  const unique = new Map()
  for (const call of calls) {
    if (!['write_file', 'edit_file'].includes(call.name ?? call.toolName)) continue
    const toolCallId = call.toolCallId ?? call.id
    let args = call.args ?? call.arguments
    if (typeof args === 'string') { try { args = JSON.parse(args) } catch { args = null } }
    const file = args?.path ?? args?.filePath ?? args?.file_path
    let reason
    if (!args || typeof args !== 'object' || typeof file !== 'string' || !file.trim()) reason = 'unverifiable_write_arguments'
    else {
      const resolved = path.resolve(workspace, file)
      if (!allowedFiles.some(allowed => path.resolve(workspace, allowed).toLowerCase() === resolved.toLowerCase())) reason = 'not_owned'
      else if (fs.existsSync(resolved) && (fs.lstatSync(resolved).isSymbolicLink() || !within(workspace, fs.realpathSync(resolved)))) reason = 'symlink_escape'
    }
    if (reason) unique.set(toolCallId ?? JSON.stringify(call), { file: typeof file === 'string' ? file : null, toolCallId, reason })
  }
  return [...unique.values()]
}

export function protectedEvidence(projectRoot, manifest, manifestFile = path.join(projectRoot, 'manifest.json')) {
  const files = new Map(), directories = new Map()
  const capture = full => {
    if (!within(projectRoot, full)) throw new Error(`Protected path escapes project root: ${full}`)
    if (!fs.existsSync(full)) throw new Error(`Protected path is missing: ${full}`)
    const stat = fs.lstatSync(full)
    if (stat.isSymbolicLink()) throw new Error(`Protected path is a symlink: ${full}`)
    if (stat.isDirectory()) {
      const entries = fs.readdirSync(full).sort(); directories.set(full, entries)
      for (const name of entries) capture(path.join(full, name))
    } else if (stat.isFile()) files.set(full, sha(fs.readFileSync(full)))
    else throw new Error(`Unsupported protected entry: ${full}`)
  }
  for (const project of manifest.projects) {
    const workspace = path.resolve(projectRoot, project.path)
    if (!within(projectRoot, workspace)) throw new Error('Workspace escapes retained project root')
    for (const name of ['tests', 'contracts', 'spec', 'package.json', 'README.md']) if (fs.existsSync(path.join(workspace, name))) capture(path.join(workspace, name))
  }
  for (const relative of manifest.protectedPaths ?? []) capture(path.resolve(projectRoot, relative))
  capture(path.join(projectRoot, 'manifest.json'))
  if (path.resolve(manifestFile) !== path.resolve(projectRoot, 'manifest.json')) capture(path.resolve(manifestFile))
  return { files, directories }
}

export function verifyProtectedEvidence(evidence) {
  const violations = []
  for (const [file, expected] of evidence.files) {
    const actual = fs.existsSync(file) && fs.lstatSync(file).isFile() && !fs.lstatSync(file).isSymbolicLink() ? sha(fs.readFileSync(file)) : null
    if (actual !== expected) violations.push({ file, expected, actual, reason: 'file_changed_or_missing' })
  }
  for (const [directory, expected] of evidence.directories) {
    const actual = fs.existsSync(directory) && fs.lstatSync(directory).isDirectory() && !fs.lstatSync(directory).isSymbolicLink() ? fs.readdirSync(directory).sort() : null
    if (JSON.stringify(actual) !== JSON.stringify(expected)) violations.push({ file: directory, expected, actual, reason: 'protected_directory_entries_changed' })
  }
  return violations
}

export function expectedContractTests(workspace, command, visited = new Set()) {
  const filename = command.args.find(arg => typeof arg === 'string' && /\.mjs$/.test(arg))
  if (!filename) return null
  const full = path.resolve(workspace, filename)
  if (!within(workspace, full) || !fs.existsSync(full)) return null
  const identity = full + ':' + command.args.at(-1)
  if (visited.has(identity)) throw new Error('Cyclic baseline contract: ' + filename)
  visited = new Set(visited); visited.add(identity)
  const source = fs.readFileSync(full, 'utf8'), stage = Number(command.args.at(-1))
  const baselines = [...source.matchAll(/^\s*\/\/\s*baseline-contract:\s*(\S+\.mjs)\s+(\d+)\s*$/gm)]
  const inherited = baselines.reduce((sum, match) => {
    const count = expectedContractTests(workspace, { args: [match[1], match[2]] }, visited)
    if (!count) throw new Error('Missing baseline contract: ' + match[1])
    return sum + count
  }, 0)
  if (path.basename(full) === 'integration-test.mjs' && !baselines.length) {
    // Follow the protected integration runner's explicit list. Later profile
    // tests in the same directory are not part of an older integration run.
    const files = [...source.matchAll(/['"]([^'"/]+-test\.mjs)['"]/g)].map(match => match[1])
    return [...new Set(files)].reduce((sum, name) => sum + (expectedContractTests(workspace, { args: [path.join(path.dirname(filename), name), '10'] }, visited) ?? 0), 0) || null
  }
  const staged = [...source.matchAll(/\bcheck\(\s*(\d+)\s*,/g)]
  if (staged.length) return inherited + staged.filter(match => Number(match[1]) <= stage).length
  const direct = [...source.matchAll(/\btest\(\s*['"]/g)]
  return inherited + direct.length || null
}

export function developmentEvidence(baseline, files) {
  const summary = baseline?.verification?.testSummary
  const process = baseline?.verification
  const terminalFailure = Number.isInteger(process?.exitCode) && process.exitCode !== 0 && process.timedOut === false && process.signal === null && !process.error
  const red = terminalFailure && summary?.complete === true && summary.tests === summary.expectedTests && summary.tests > 0 && summary.fail > 0 && summary.skipped === 0 && summary.cancelled === 0 && summary.todo === 0 && summary.pass + summary.fail === summary.tests
  const changedFiles = files.filter(file => baseline?.files?.some(old => old.file === file.file && old.sha256 !== file.sha256)).map(file => file.file)
  return { passed: red && changedFiles.length > 0, baselineRed: red, changedFiles, criteria: 'protected new contract complete and failing before model work, owned implementation changed from that baseline, current full contract passed separately' }
}

export function nodeTestSummary(stdout, expectedTests = null) {
  const clean = stdout.replace(/\x1b\[[0-9;]*m/g, '')
  const totals = { tests: 0, pass: 0, fail: 0, skipped: 0, cancelled: 0, todo: 0 }
  const counts = Object.fromEntries(Object.keys(totals).map(key => [key, []]))
  for (const line of clean.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:#|ℹ)\s*(tests|pass|fail|skipped|cancelled|todo)\s+(\d+)\s*$/)
    if (match) counts[match[1]].push(Number(match[2]))
  }
  for (const [key, values] of Object.entries(counts)) totals[key] = values.reduce((sum, value) => sum + value, 0)
  const complete = Object.values(counts).every(values => values.length === counts.tests.length) && counts.tests.length > 0
  const passed = complete && totals.tests > 0 && totals.pass === totals.tests && totals.fail === 0 && totals.skipped === 0 && totals.cancelled === 0 && totals.todo === 0 && (expectedTests === null || totals.tests === expectedTests)
  return { ...totals, blocks: counts.tests.length, complete, expectedTests, passed }
}

export function sessionConcurrency(sessions) {
  const events = []
  for (const session of sessions) for (const round of session.rounds ?? []) for (const interval of round.stateIntervals ?? []) if (interval.status === 'running' && interval.to > interval.from) {
    events.push({ at: interval.from, id: session.sessionId, delta: 1 }, { at: interval.to, id: session.sessionId, delta: -1 })
  }
  events.sort((a,b) => a.at-b.at)
  const active = new Map(), durationByCountMs = {}
  let previous, maxConcurrentSessions = 0
  for (let index=0;index<events.length;) {
    const at=events[index].at
    if (previous !== undefined && at>previous) { const count=active.size; durationByCountMs[count]=(durationByCountMs[count]??0)+at-previous; if(count)maxConcurrentSessions=Math.max(maxConcurrentSessions,count) }
    while(index<events.length && events[index].at===at) { const event=events[index++], count=(active.get(event.id)??0)+event.delta; if(count>0)active.set(event.id,count);else active.delete(event.id) }
    previous=at
  }
  return { maxConcurrentSessions, durationByCountMs, allFiveOverlapMs: durationByCountMs[5]??0, source: 'root running intervals, excluding dependency waits and independent verification' }
}

export async function bindSessionWorkspace(request, session) {
  const expected = fs.realpathSync(session.workspace)
  const bound = await request('/workspace/bind', { method: 'POST', body: JSON.stringify({ sessionId: session.sessionId, workspaceRoot: session.workspace }) })
  if (typeof bound?.workspaceRoot !== 'string' || path.resolve(bound.workspaceRoot).toLowerCase() !== path.resolve(expected).toLowerCase()) throw new Error('Workspace bind did not return the requested canonical project path')
  const listing = await request('/workspace/directory?sessionId=' + encodeURIComponent(session.sessionId) + '&path=.')
  if (typeof listing?.root !== 'string' || path.resolve(listing.root).toLowerCase() !== path.resolve(expected).toLowerCase()) throw new Error('Client directory API does not use the bound project path')
  const names = new Set((listing.entries ?? []).map(entry => entry.name))
  if (!names.has('src') || !names.has('tests') || !names.has('contracts')) throw new Error('Bound project directory listing is missing its implementation or protected contracts')
  return { at: now(), requestedWorkspace: session.workspace, canonicalWorkspace: expected, boundWorkspace: bound.workspaceRoot, directoryRoot: listing.root, directoryEntryNames: [...names].sort(), passed: true }
}

export function stagePrompt(session, stage, missing, prefix, feedback = '') {
  const duties = missing.map(role => role === 'A' ? 'A核对当前阶段合同和实现' : 'B核对当前阶段边界与持久化/并发').join('；')
  const reviews = missing.length ? `本轮只补指定评审角色 ${missing.join(', ')}，不额外派其它评审，不重评已有新鲜成功证据。description须精确为 ${missing.map(role => JSON.stringify(prefix + role)).join(' 和 ')}，access:'read-only',maxSteps:24。${missing.length > 1 ? '两个独立评审在同一个工具调用批次发送，禁止依次等待A再派B。' : ''}${duties}。评审task须自包含：项目绝对路径、当前S${stage.index}具体功能、owned源文件相关函数与行范围、合同相应条目和tests中S1..S${stage.index}当前断言位置。评审仅静态审查，没有execute_cmd工具；禁止写文件、运行测试或任何命令，不得让子Agent执行测试。只读工具为read_file/grep_search/glob_search/list_files，只允许定位当前合同、函数和断言，不读.test-data历史运行产物，不搜未来阶段、其它角色代码或不存在spec目录。预计2–6次定向只读工具调用，证据足够即收口；maxSteps24是上限而非必须用满的工作量。结论不超过400中文字：pass或blocking、相关文件:行号、阻塞原因或已确认关键点；不贴源码，不列未来未实现功能，不生成额外hash、报告或冗长建议。成功评审的非阻塞建议可留到对应后续阶段，不应为建议反复重评。若当前合同有阻塞错误，修复代码并重取当前实现新鲜评审；失败评审只补缺失证据。` : '当前代码已有新鲜成功评审证据，不要重做评审，不额外派评审；只运行当前累计测试并说明结果。'
  return `${session.title}。这是真实保留项目开发，不使用假返回值。当前职责：${session.role.title ?? session.roleId}；与同目录其他会话共享一个项目。\n项目绝对路径：${session.workspace}；会话已通过客户端workspace/bind绑定该项目。\n阶段 ${stage.index}：${stage.title}\n${stage.prompt}\n本轮只实现及验收S1..S${stage.index}，不要抢先实现后续阶段。已存在的后续实现保留，不重置。阅读contracts当前角色的相应条目和tests当前累计断言，优先相关范围，避免重复整文件读取。\n只允许修改：${session.role.allowedFiles.join(', ')}。其他会话拥有其它文件，可读不可改。tests/、contracts/、spec/、package.json、README、根manifest禁止修改；collaboration目录由驱动维护，仅只读查看同事阶段。禁止创建任何额外handoff、plan、report、context或临时实现文件，包括default私有工作区。交接与总结仅通过最终文本和驱动维护的collaboration状态。遵守contracts接口并保留已通过阶段。\n先真实实现并执行 execute_cmd ${JSON.stringify({ ...stage.testCommand, cwd: session.workspace, timeoutMs: 60000 })}，根据失败修复，直到当前累计测试通过。不能改测试、删断言或跳过测试。\n${reviews}\n评审完成后再次执行同一当前阶段测试命令；若评审后修改实现，需要重新取得对应评审。不要用未来阶段测试替代当前阶段命令。\n仅使用内置文件工具和上述Node测试命令；禁止安装依赖、删除、node -e、shell重定向、改变引擎配置和审批策略。遇到权限请求如实停止。最终以文本说明当前阶段实际测试、当前子任务runId和机器状态、遗留问题。${feedback}`
}

export async function consumeSSE(body, deliver) {
  const reader = body.getReader(), decoder = new TextDecoder()
  let pending = '', frame = { event: 'message', data: [] }
  const flush = () => { if (frame.data.length) { const raw = frame.data.join('\n'); let data; try { data = JSON.parse(raw) } catch { data = { raw } }; deliver({ event: frame.event, id: frame.id, data }) }; frame = { event: 'message', data: [] } }
  const line = value => { if (value === '') flush(); else if (value.startsWith('data:')) frame.data.push(value.slice(5).trimStart()); else if (value.startsWith('event:')) frame.event = value.slice(6).trim(); else if (value.startsWith('id:')) frame.id = value.slice(3).trim() }
  while (true) { const part = await reader.read(); if (part.done) break; pending += decoder.decode(part.value, { stream: true }); const lines = pending.split(/\r?\n/); pending = lines.pop() ?? ''; for (const value of lines) line(value) }
  pending += decoder.decode(); if (pending) line(pending); flush()
}

export function fileEvidence(workspace, files) {
  return files.map(file => { const full = path.resolve(workspace, file); if (!within(workspace, full)) throw new Error(`File escapes project: ${file}`); if (!fs.existsSync(full)) return { file, sha256: null, modifiedAtMs: 0 }; const stat = fs.lstatSync(full); if (!stat.isFile() || stat.isSymbolicLink() || !within(workspace, fs.realpathSync(full))) throw new Error(`Unsafe implementation file: ${file}`); return { file, sha256: sha(fs.readFileSync(full)), modifiedAtMs: stat.mtimeMs } })
}

export function verifiedReview(previous, children, prefix, files) {
  const hash = sha(JSON.stringify(files.map(file => [file.file, file.sha256])))
  const latestWrite = Math.max(0, ...files.map(file => file.modifiedAtMs))
  const found = { ...(previous ?? {}) }
  for (const child of children) {
    const description = child.description ?? ''
    if (!description.startsWith(prefix)) continue
    const role = description.slice(prefix.length).trim().toUpperCase()
    if (!['A', 'B'].includes(role)) continue
    const startedAt = timestamp(child.startedAt ?? child.createdAt), finishedAt = timestamp(child.finishedAt)
    found[role] = { runId: child.runId, modelId: child.modelId, modelEvidence: child.actualModelId ? 'actual' : 'requested_only', actualModelId: child.actualModelId, status: child.status, startedAt, finishedAt, hash, errorCode: child.error?.code, summary: (child.resultSummary ?? child.partialOutput ?? '').slice(-4000) }
  }
  for (const [role, review] of Object.entries(found)) if (review.hash !== hash || !Number.isFinite(timestamp(review.startedAt)) || !Number.isFinite(timestamp(review.finishedAt)) || timestamp(review.finishedAt) < timestamp(review.startedAt) || timestamp(review.startedAt) + 2 < latestWrite) delete found[role]
  return found
}

export async function executeTests(workspace, command, maxMs = 60000) {
  if (command.command !== 'node' || !Array.isArray(command.args)) throw new Error('Contracts must use explicit Node argv')
  const startedAt = Date.now()
  const expectedTests = expectedContractTests(workspace, command)
  return await new Promise(resolve => {
    let stdout = '', stderr = '', timedOut = false
    const env = { ...process.env }; delete env.NODE_TEST_CONTEXT
    const child = spawn(process.execPath, command.args, { cwd: workspace, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.on('data', bytes => { stdout = (stdout + bytes).slice(-1000000) })
    child.stderr.on('data', bytes => { stderr = (stderr + bytes).slice(-1000000) })
    const timer = setTimeout(() => { timedOut = true; child.kill() }, maxMs)
    child.once('error', error => { clearTimeout(timer); resolve({ exitCode: null, error: errorInfo(error), stdout, stderr, expectedTests, contractPassed: false, elapsedMs: Date.now() - startedAt }) })
    child.once('close', (exitCode, signal) => { clearTimeout(timer); const testSummary = nodeTestSummary(stdout, expectedTests); resolve({ exitCode, signal, timedOut, stdout, stderr, expectedTests, testSummary, contractPassed: exitCode === 0 && !timedOut && testSummary.passed, elapsedMs: Date.now() - startedAt }) })
  })
}

export async function main() {
  const root = path.resolve(process.env.LONGRUN_RUN_ROOT)
  const projectRoot = path.resolve(process.env.LONGRUN_PROJECT_ROOT)
  const manifestFile = path.resolve(projectRoot, process.env.LONGRUN_MANIFEST || 'manifest.json')
  if (!within(projectRoot, manifestFile)) throw new Error('Manifest must stay within project root')
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
  const base = process.env.LONGRUN_BASE || 'http://127.0.0.1:12499'
  const token = process.env.LONGRUN_TOKEN
  if (!token) throw new Error('Isolated instance token is required')
  const headers = { 'content-type': 'application/json', 'x-aether-instance-token': token, 'x-aether-tool-profile': 'code' }
  const request = async (route, options = {}) => {
    const response = await fetch(base + '/api/v1' + route, { headers, ...options, signal: options.signal ?? AbortSignal.timeout(15000) })
    const body = await response.json()
    return apiEnvelope(response, body, route)
  }
  const otherModel = process.env.LONGRUN_OTHER_MODEL
  const enabled = (await request('/models')).filter(model => model.isEnabled).map(model => model.modelId)
  if (!enabled.includes('qwen3.8-flash') || !enabled.includes(otherModel)) throw new Error('The required Qwen and second model must be explicitly enabled')
  const tools = ['read_file', 'write_file', 'edit_file', 'list_files', 'glob_search', 'grep_search', 'execute_cmd', 'subagent']
  const roles = manifest.projects.flatMap(project => project.roles.map(role => ({ project, role })))
  if (roles.length !== 5 || manifest.projects.length !== 2 || manifest.projects[0].roles.length !== 3 || manifest.projects[1].roles.length !== 2) throw new Error('This acceptance requires precisely two projects with 3 + 2 roles')
  const settings = [
    { model: 'qwen3.8-flash', temperature: 0.2, thinkingMode: false, memoryScope: 'off' },
    { model: 'qwen3.8-flash', temperature: 0.5, thinkingMode: false, memoryScope: 'session' },
    { model: 'qwen3.8-flash', temperature: 0.1, thinkingMode: 'low', memoryScope: 'global' },
    { model: otherModel, temperature: 0.15, thinkingMode: false, memoryScope: 'session' },
    { model: otherModel, temperature: 0.35, thinkingMode: 'low', memoryScope: 'off' },
  ]
  const budget = workloadBudget()
  const started = Date.now(), hardEnd = started + budget.maxMs
  const phaseLimit = budget.stageTimeoutMs
  const sessions = roles.map(({ project, role }, index) => ({ index: index + 1, projectId: project.id, roleId: role.id, title: `Longrun ${project.id} ${role.id}`, sessionId: `longrun-${index + 1}-${randomUUID()}`, workspace: path.resolve(projectRoot, project.path), modelId: settings[index].model, project, role, config: settings[index], startedAt: now(), rounds: [], completedStage: 0, errors: [], cleanup: [] }))
  const report = { protocolVersion: 'shared-project-1', startedAt: now(), base, root, projectRoot, manifestFile, budget, models: settings.map(setting => setting.model), sessions, projectAcceptance: [] }
  write(path.join(root, 'active-start.json'), report)
  const protectedFiles = protectedEvidence(projectRoot, manifest, manifestFile)
  write(path.join(root, 'protected-baseline.json'), { at: now(), hashes: Object.fromEntries(protectedFiles.files), directories: Object.fromEntries(protectedFiles.directories) })
  const verifyProtected = () => verifyProtectedEvidence(protectedFiles)
  const active = new Map()
  let stopping = false
  const publish = session => { write(path.join(root, `session-${session.index}.json`), session); const collaboration = path.join(session.workspace, 'collaboration'); fs.mkdirSync(collaboration, { recursive: true }); write(path.join(collaboration, `${session.roleId}.json`), { sessionId: session.sessionId, roleId: session.roleId, completedStage: session.completedStage, lastAttempt: session.rounds.at(-1)?.status, updatedAt: now(), ownedFiles: session.role.allowedFiles }) }
  const cancel = async (session, reason) => {
    active.get(session.sessionId)?.abort(new Error(reason))
    try { session.cleanup.push({ at: now(), reason, result: await request('/chat/cancel', { method: 'POST', body: JSON.stringify({ sessionId: session.sessionId }) }) }) } catch (error) { session.cleanup.push({ at: now(), reason, error: errorInfo(error) }) }
  }
  const stop = async reason => { stopping = true; await Promise.all(sessions.map(session => cancel(session, reason))) }
  const timeout = setTimeout(() => void stop('driver_deadline'), hardEnd - Date.now())
  const signal = () => void stop('driver_signal')
  process.once('SIGINT', signal); process.once('SIGTERM', signal)
  async function attempt(session, stage, number, previous) {
    const directory = path.join(root, 'sessions', `session-${session.index}`, `stage-${stage.index}-attempt-${number}`)
    fs.mkdirSync(directory, { recursive: true })
    const start = Date.now(), controller = new AbortController()
    const out = { index: session.index, round: stage.index, attempt: number, sessionId: session.sessionId, projectId: session.projectId, roleId: session.roleId, stageTitle: stage.title, startedAt: now(), startedAtMs: start, status: 'starting', errors: [], toolEvents: [], permissionRequests: [], usageEvents: [], stateIntervals: [], children: [] }
    const before = fileEvidence(session.workspace, session.role.allowedFiles)
    const required = stage.acceptance?.minReviewerAgents > 1 || stage.index % 3 === 0 || stage.index === session.role.stages.length ? ['A', 'B'] : ['A']
    const prefix = `review/${session.roleId}/${stage.index}/`
    const goodPrevious = verifiedReview(previous?.reviews, [], prefix, before)
    const missing = required.filter(role => goodPrevious[role]?.status !== 'succeeded')
    const feedback = previous ? `\n上次权威验收：${JSON.stringify({ failed: previous.failureKinds, tests: previous.verification?.exitCode, errors: previous.errors, validReviews: goodPrevious, testTail: (previous.verification?.stdout ?? '').slice(-12000) })}。保持有效实现和证据，只补缺失部分。` : ''
    const message = stagePrompt(session, stage, missing, prefix, feedback)
    const body = { sessionId: session.sessionId, agentId: session.agentId, model: session.config.model, subagentModel: session.config.model, thinkingMode: session.config.thinkingMode, memoryScope: session.config.memoryScope, inheritContext: true, workspacePaths: [session.workspace], allowedTools: tools, skills: [], mcpServers: [], knowledgeBases: [], message }
    write(path.join(directory, 'request.json'), body)
    let state = { status: 'starting', from: start }
    const transition = status => { if (state.status !== status) { out.stateIntervals.push({ ...state, to: Date.now() }); state = { status, from: Date.now() } } }
    active.set(session.sessionId, controller)
    let cancellation
    const timer = setTimeout(() => { out.deadlineReason = 'stage_deadline'; transition('cancelling'); cancellation = cancel(session, 'stage_deadline') }, Math.max(1, Math.min(hardEnd - start, phaseLimit)))
    try {
      const response = await fetch(base + '/api/v1/chat', { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal })
      out.httpStatus = response.status
      if (!response.ok || !response.body) throw new Error(`Chat HTTP ${response.status}`)
      if (!response.headers.get('content-type')?.includes('text/event-stream')) throw new Error(`Chat did not return SSE: ${(await response.text()).slice(0, 1000)}`)
      await consumeSSE(response.body, event => {
        const data = event.data, at = now()
        append(path.join(directory, 'events.jsonl'), { at, elapsedMs: Date.now() - start, ...event })
        if (data.run) { out.rootRun = data.run; out.runId = data.run.runId; out.status = data.run.status; transition(data.run.status) }
        if (data.toolCall || data.toolResult || data.toolStart || data.toolEnd) out.toolEvents.push({ at, ...data })
        if (data.permissionRequest) { out.permissionRequests.push(data.permissionRequest); transition('waiting') }
        if (data.usage) out.usageEvents.push({ at, data: data.usage })
        if (data.error) out.errors.push({ source: 'sse', error: data.error })
      })
    } catch (error) { out.errors.push({ source: 'transport', ...errorInfo(error) }) }
    finally { clearTimeout(timer); if (cancellation) await cancellation; active.delete(session.sessionId) }
    const snapshot = async () => {
      const value = await request('/chat/snapshot?sessionId=' + encodeURIComponent(session.sessionId))
      out.rootRun = value.run ?? value.projection?.find(item => item.run)?.run ?? out.rootRun
      out.runId = out.rootRun?.runId; out.status = out.rootRun?.status ?? out.status; out.commandJobs = value.commandJobs ?? []
      write(path.join(directory, 'snapshot.json'), value)
    }
    try { await snapshot(); if (!terminal(out.status) || out.permissionRequests.length) { await cancel(session, 'attempt_not_terminal'); const until = Date.now() + 15000; do { await snapshot(); if (terminal(out.status)) break; await wait(250) } while (Date.now() < until); if (!terminal(out.status)) throw new Error('Cancellation did not persist a terminal root state') } } catch (error) { out.errors.push({ source: 'snapshot', ...errorInfo(error) }) }
    try { const children = await request('/subagent/runs?parentSessionId=' + encodeURIComponent(session.sessionId)); out.children = currentTurnChildren(children, out.rootRun, session.sessionId); write(path.join(directory, 'subagents.json'), out.children) } catch (error) { out.errors.push({ source: 'subagents', ...errorInfo(error) }) }
    out.files = fileEvidence(session.workspace, session.role.allowedFiles)
    out.reviews = verifiedReview(goodPrevious, out.children, prefix, out.files)
    out.verification = await executeTests(session.workspace, stage.testCommand)
    fs.writeFileSync(path.join(directory, 'verification.txt'), out.verification.stdout + '\n' + out.verification.stderr)
    out.protectedViolations = verifyProtected()
    out.agentTestRequiredAfterMs = Math.max(0, ...out.files.map(file => file.modifiedAtMs), ...required.map(role => timestamp(out.reviews[role]?.finishedAt)).filter(Number.isFinite))
    out.agentTestRuns = (out.commandJobs ?? []).filter(job => job.runId === out.runId && job.command === 'node' && JSON.stringify(job.args) === JSON.stringify(stage.testCommand.args) && path.resolve(job.cwd ?? '').toLowerCase() === session.workspace.toLowerCase() && job.status === 'succeeded' && job.exitCode === 0 && timestamp(job.finishedAt) + 2 >= out.agentTestRequiredAfterMs)
    out.ownershipViolations = ownershipViolations(session.workspace, session.role.allowedFiles, out.toolEvents, out.children)
    out.modelEvidence = { requestedModelId: session.config.model, actualModelId: out.rootRun?.actualModelId, passed: out.rootRun?.actualModelId === session.config.model, childModelEvidence: 'Child snapshots normally expose requested modelId only; this alone does not prove actual provider routing.' }
    out.changedOwnedFiles = out.files.filter(file => before.find(old => old.file === file.file)?.sha256 !== file.sha256).map(file => file.file)
    out.failureKinds = [out.status !== 'succeeded' && 'root_not_succeeded', !out.modelEvidence.passed && 'actual_model_mismatch', out.children.some(child => child.modelId !== session.config.model || (child.actualModelId && child.actualModelId !== session.config.model)) && 'child_model_mismatch', out.errors.length && 'runtime_error', out.permissionRequests.length && 'permission_required', !out.verification.contractPassed && 'contract_failed', !out.agentTestRuns.length && 'agent_test_missing_or_stale', required.some(role => out.reviews[role]?.status !== 'succeeded' || out.reviews[role]?.modelId !== session.config.model) && 'review_incomplete', out.children.some(child => !terminal(child.status)) && 'active_children_remain', (out.commandJobs ?? []).some(job => !terminal(job.status)) && 'active_commands_remain', out.protectedViolations.length && 'protected_mutation', out.ownershipViolations.length && 'ownership_violation'].filter(Boolean)
    if (session.role.requiresDevelopment) {
      out.development = developmentEvidence(session.developmentBaseline, out.files)
      if (!out.development.passed) out.failureKinds.push('new_development_evidence_missing')
    }
    out.success = out.failureKinds.length === 0
    out.finishedAt = now(); out.elapsedMs = Date.now() - start; out.stateIntervals.push({ ...state, to: Date.now() })
    out.runningMs = out.stateIntervals.filter(item => item.status === 'running').reduce((sum, item) => sum + item.to - item.from, 0)
    write(path.join(directory, 'result.json'), out)
    return out
  }
  try {
    // All red baselines precede every model request. A retry may retain a prior
    // implementation, but an already-green baseline is never new development.
    for (const session of sessions.filter(session => session.role.requiresDevelopment)) {
      const testCommand = session.role.stages[0].testCommand
      const files = fileEvidence(session.workspace, session.role.allowedFiles)
      const verification = await executeTests(session.workspace, testCommand)
      session.developmentBaseline = { at: now(), testCommand, files, verification }
      write(path.join(root, `${session.roleId}-development-baseline.json`), session.developmentBaseline)
      fs.writeFileSync(path.join(root, `${session.roleId}-development-baseline.txt`), verification.stdout + '\n' + verification.stderr)
      if (!developmentEvidence(session.developmentBaseline, files).baselineRed) throw new Error(`${session.roleId}: new development requires a complete failing protected baseline before model work`)
    }
    for (const session of sessions) {
      const agent = await request('/agents', { method: 'POST', body: JSON.stringify({ name: session.title, description: `Retained project ${session.projectId} role ${session.roleId}`, model: session.config.model, temperature: session.config.temperature, allowedTools: tools, skills: [], mcpServers: [], knowledgeBases: [] }) })
      session.agentId = agent.id
      session.workspaceBinding = await bindSessionWorkspace(request, session)
      publish(session)
    }
    write(path.join(root, 'active-start.json'), report)
    await Promise.all(sessions.map(async session => {
      try {
        for (const stage of session.role.stages) {
          for (;;) {
            const dependencies = stageDependencies(session, stage, sessions)
            if (dependencies.ready) break
            if (stopping || Date.now() >= hardEnd) throw new Error('Required dependency did not complete before workload deadline')
            if (dependencies.blockers.length) throw new Error('Required dependency cannot complete: ' + dependencies.blockers.join('; '))
            await wait(500)
          }
          if (stopping || Date.now() >= hardEnd) throw new Error('Workload deadline before all requirements completed')
          await runStageAttempts({ session, stage, attempt: (number, previous) => attempt(session, stage, number, previous), publish, maxAttempts: budget.maxAttempts, deadlineMs: hardEnd, shouldStop: () => stopping })
        }
      } catch (error) { session.errors.push(errorInfo(error)) }
      finally { await cancel(session, 'session_complete'); session.finishedAt = now(); session.elapsedMs = Date.now() - started; session.status = session.errors.length ? 'failed' : 'completed'; publish(session) }
    }))
    for (const project of manifest.projects) {
      const workspace = path.resolve(projectRoot, project.path)
      const command = project.integrationTestCommand ?? { command: 'node', args: ['tests/integration-test.mjs'] }
      const result = await executeTests(workspace, command, 120000)
      report.projectAcceptance.push({ projectId: project.id, workspace, command, ...result })
      fs.writeFileSync(path.join(root, `${project.id}-integration.txt`), result.stdout + '\n' + result.stderr)
    }
  } finally {
    clearTimeout(timeout); await stop('driver_finally'); process.removeListener('SIGINT', signal); process.removeListener('SIGTERM', signal)
    for (const session of sessions) {
      try { const snapshot = await request('/chat/snapshot?sessionId=' + encodeURIComponent(session.sessionId)); session.finalRootRun = snapshot.run ?? snapshot.projection?.find(item => item.run)?.run; session.finalCommandJobs = snapshot.commandJobs ?? []; session.finalChildren = await request('/subagent/runs?parentSessionId=' + encodeURIComponent(session.sessionId)) } catch (error) { session.errors.push({ source: 'final_snapshot', ...errorInfo(error) }) }
      publish(session)
    }
    report.finishedAt = now(); report.elapsedMs = Date.now() - started
    const all = sessions.flatMap(session => session.rounds)
    report.rates = { attempts: all.length, successfulAttempts: all.filter(round => round.success).length, failedAttempts: all.filter(round => !round.success).length, requirements: sessions.reduce((count, session) => count + session.role.stages.length, 0), recoveredRequirements: sessions.reduce((count, session) => count + session.completedStage, 0), firstAttemptSuccesses: all.filter(round => round.attempt === 0 && round.success).length }
    report.concurrency = sessionConcurrency(sessions)
    report.acceptance = { passed: report.concurrency.allFiveOverlapMs > 0 && sessions.every(session => session.completedStage === session.role.stages.length && session.errors.length === 0 && session.finalRootRun?.status === 'succeeded' && session.finalRootRun?.actualModelId === session.config.model && session.finalChildren?.every(child => terminal(child.status)) && session.finalCommandJobs?.every(job => terminal(job.status))) && report.projectAcceptance.length === 2 && report.projectAcceptance.every(project => project.contractPassed === true) && verifyProtected().length === 0, criteria: 'two retained runnable projects, five actually overlapping role sessions, exactly three Qwen sessions with actualModelId verified, all staged cumulative contracts with expected test count and no skips + fresh Agent tests + current implementation review evidence, protected/ownership checks, final project integration, persisted terminal states' }
    write(path.join(root, 'active-report.json'), report)
  }
  console.log(JSON.stringify({ root, acceptance: report.acceptance, rates: report.rates, sessions: sessions.map(session => ({ index: session.index, projectId: session.projectId, roleId: session.roleId, model: session.config.model, elapsedMs: session.elapsedMs, completedStage: session.completedStage, status: session.status })) }))
  process.exitCode = report.acceptance.passed ? 0 : 2
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main()
