/**
 * Read-only live Electron monitoring; never replaces full-client acceptance.
 * node scripts/longrun/continuation-client-monitor.mjs --run-root <ownedrun>
 *   --client-root <final candidate/aether-code> --build-id <sha256:...> [--check]
 *
 * Browser probes request one visible session via client-browser-lease-request.json:
 * {requestId, sessionId, expiresAt}. Wait for the matching ready lease in
 * client-browser-lease.json before dispatching tools. Release via
 * client-browser-lease-release.json: {requestId}. No simultaneous-session claim.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

const now = () => new Date().toISOString()
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'))
const optional = file => { try { return read(file) } catch (error) { if (error.code === 'ENOENT') return null; throw error } }
const escapeRegex = value => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')

export function parseArguments(args) {
  const result = { intervalMs: 60_000, check: false }
  const names = new Map([['--run-root', 'runRoot'], ['--client-root', 'clientRoot'], ['--build-id', 'buildId'], ['--interval-ms', 'intervalMs']])
  const seen = new Set()
  for (let index = 0; index < args.length; index++) {
    const flag = args[index]
    if (seen.has(flag)) throw new Error('Repeated argument: ' + flag)
    seen.add(flag)
    if (flag === '--check') { result.check = true; continue }
    const name = names.get(flag), value = args[++index]
    if (!name || !value || value.startsWith('--')) throw new Error('Unknown or missing argument: ' + flag)
    result[name] = name === 'intervalMs' ? Number(value) : value
  }
  for (const key of ['runRoot', 'clientRoot', 'buildId']) assert.ok(result[key], 'Required monitor argument: ' + key)
  assert.match(result.buildId, /^sha256:[0-9a-f]{64}$/i, 'Candidate build identity is required')
  assert.ok(Number.isSafeInteger(result.intervalMs) && result.intervalMs >= 1000, 'Invalid monitor interval')
  return result
}

export function loadConfiguration(options) {
  const runRoot = path.resolve(options.runRoot), clientRoot = path.resolve(options.clientRoot)
  const state = read(path.join(runRoot, 'continuation-state.json'))
  const supervisor = read(path.join(runRoot, 'supervisor-status.json'))
  assert.ok(typeof state.root === 'string' && samePath(state.root, runRoot), 'Owned continuation state does not match run root')
  assert.ok(!state.sourceRoot || !samePath(state.sourceRoot, runRoot), 'Do not monitor a reused source run as continuation')
  assert.equal(state.sessions?.length, 5, 'Exactly five original sessions required')
  assert.equal(new Set(state.sessions.map(session => session.sessionId)).size, 5, 'Session IDs must be unique')
  for (const session of state.sessions) assert.ok(typeof session.sessionId === 'string' && session.sessionId.trim(), 'Invalid original session')
  assert.equal(supervisor.buildId, options.buildId, 'Supervisor candidate identity differs')
  const endpoint = new URL(supervisor.base)
  assert.ok(endpoint.protocol === 'http:' && endpoint.hostname === '127.0.0.1' && !endpoint.username && !endpoint.password && endpoint.pathname === '/', 'Owned supervisor must name the exact loopback test engine')
  const token = fs.readFileSync(path.join(runRoot, '.instance-token'), 'utf8').trim()
  assert.ok(token && !/[\r\n]/.test(token), 'Missing or invalid isolated instance token')
  const stage = path.join(clientRoot, 'resources/engine/win32-x64')
  assert.equal(read(path.join(stage, 'stage-manifest.json')).buildId, options.buildId, 'Client runtime stage differs from candidate')
  assert.equal(read(path.join(stage, 'dist/runtime/build-manifest.json')).buildId, options.buildId, 'Client packaged engine differs from candidate')
  const clientPackage = read(path.join(clientRoot, 'package.json'))
  assert.ok(clientPackage.main && fs.existsSync(path.join(clientRoot, clientPackage.main)), 'Final candidate Electron main build missing')
  return { ...options, runRoot, clientRoot, base: supervisor.base.replace(/\/+$/, ''), token, state, supervisor }
}

export function historyTitle(input) {
  let value = input
  try { if (typeof value === 'string') value = JSON.parse(value) } catch { /* ordinary text */ }
  const text = Array.isArray(value) ? value.filter(item => item?.type === 'text').map(item => item.text ?? '').join('\n') : String(input ?? '')
  const line = text.split('\n')[0].replace(/\s+/g, ' ').trim()
  return line ? line.length > 50 ? line.slice(0, 50) + '…' : line : '未命名会话'
}

function historyAbsoluteTime(lastAt) {
  const time = new Date(Number(lastAt))
  if (!Number.isFinite(time.getTime())) return ''
  const pad = value => String(value).padStart(2, '0')
  return `${time.getFullYear()}-${pad(time.getMonth() + 1)}-${pad(time.getDate())} ${pad(time.getHours())}:${pad(time.getMinutes())}`
}

export function normalizeLease(request, sessionIds, at = Date.now()) {
  assert.ok(request && typeof request === 'object', 'Browser lease request must be an object')
  assert.ok(typeof request.requestId === 'string' && /^[A-Za-z0-9_-]{1,120}$/.test(request.requestId), 'Invalid browser probe request identity')
  assert.ok(sessionIds.includes(request.sessionId), 'Browser lease must belong to an original retained session')
  const expiresAtMs = Date.parse(request.expiresAt)
  assert.ok(Number.isFinite(expiresAtMs) && expiresAtMs > at, 'Browser lease expiry must be in the future')
  return { requestId: request.requestId, sessionId: request.sessionId, expiresAt: new Date(expiresAtMs).toISOString(), expiresAtMs }
}

export function observationFingerprint(snapshot, memory) {
  return digest({ sessionId: snapshot.sessionId, runId: snapshot.run?.runId, modelId: snapshot.run?.modelId,
    requestConfig: snapshot.run?.requestConfig ?? {}, memoryScope: memory?.memoryScope, effectiveScope: memory?.effectiveScope })
}

export function validateObservation(snapshot, memory, ui) {
  assert.equal(snapshot.schemaVersion, 1, 'Unsupported live recovery snapshot')
  assert.equal(snapshot.sessionId, ui.sessionId, 'Snapshot and selected original session differ')
  const run = snapshot.run
  assert.ok(run?.runId, 'Original session has no recoverable root run')
  assert.equal(run.sessionId, ui.sessionId, 'Latest run belongs to another session')
  assert.equal(ui.modelTitle, '当前模型：' + run.modelId, 'Composer did not restore latest requested model')
  assert.equal(ui.browser.status, 'connected', 'Real BrowserEngineBridge is not ready')
  assert.equal(ui.browser.sessionId, ui.sessionId, 'Browser bridge is bound to another session')
  const expected = new Set()
  for (const [key, prefix] of [['skills', '移除技能 '], ['mcpServers', '移除 MCP '], ['knowledgeBases', '移除知识库 ']]) {
    for (const id of run.requestConfig?.[key] ?? []) expected.add(prefix + id)
  }
  assert.deepEqual([...ui.resourceLabels].sort(), [...expected].sort(), 'Composer resources differ from persisted request configuration')
  const labels = { off: '关闭记忆', global: '全局记忆', session: '仅本会话' }
  assert.ok(labels[memory?.memoryScope], 'Selected session memory setting is unavailable')
  assert.equal(memory.sessionId, ui.sessionId, 'Memory belongs to another retained session')
  assert.ok(ui.memoryLabel.includes(labels[memory.memoryScope]), 'Memory menu did not restore selected session scope')
  assert.equal(new Set(ui.userIds).size, ui.userIds.length, 'Rendered user message IDs are duplicated')
  assert.ok(ui.userIds.includes(run.userMessageId), 'Latest persisted user is missing from actual history UI')
  const users = snapshot.history.filter(item => item.role === 'user' && !item.isSidechain)
  const allowedUsers = new Set([...users.map(user => user.id), run.userMessageId])
  for (const id of ui.userIds) assert.ok(allowedUsers.has(id), 'Rendered user belongs to another selected session: ' + id)
  assert.equal(ui.latestTurnId, run.turnId, 'Latest rendered user belongs to another turn')
  return { runId: run.runId, status: run.status, requestedModel: run.modelId, actualModel: run.actualModelId ?? null,
    requestConfig: run.requestConfig ?? {}, memoryScope: memory.memoryScope, effectiveScope: memory.effectiveScope,
    userIds: ui.userIds, latestUserId: run.userMessageId, latestTurnId: run.turnId, historyCompacted: Boolean(snapshot.historyCompacted),
    historyRows: snapshot.history.length, browser: ui.browser, resourceLabels: ui.resourceLabels }
}

export async function runMonitor(options) {
  const config = loadConfiguration(options)
  if (options.check) return { checked: true, launched: false, runRoot: config.runRoot, clientRoot: config.clientRoot, buildId: config.buildId, sessions: config.state.sessions.map(session => session.sessionId), supervisorPhase: config.supervisor.phase }
  const { runRoot, clientRoot, base, token, state, buildId } = config
  assert.ok(['active', 'runtime-ready-awaiting-client-and-semantic-gates'].includes(config.supervisor.phase), 'Supervisor is not ready or active; refusing to launch Electron')
  const require = createRequire(path.join(clientRoot, 'package.json'))
  const { _electron: electron, expect } = require('@playwright/test')
  const lock = path.join(runRoot, '.client-monitor.lock')
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, buildId, at: now() }), { flag: 'wx' })
  const evidence = fs.mkdtempSync(path.join(runRoot, 'client-monitor-'))
  const profile = path.join(evidence, 'userdata'); fs.mkdirSync(profile)
  const files = { request: path.join(runRoot, 'client-browser-lease-request.json'), release: path.join(runRoot, 'client-browser-lease-release.json'), lease: path.join(runRoot, 'client-browser-lease.json'), status: path.join(runRoot, 'client-monitor-status.json') }
  const scrub = value => JSON.parse(JSON.stringify(value, (key, item) => /^(token|clientToken|authorization|apiKey|password|secret)$/i.test(key) ? '[REDACTED]' : typeof item === 'string' ? item.split(token).join('[REDACTED]') : item))
  const write = (file, value) => { const temp = file + '.tmp'; fs.writeFileSync(temp, JSON.stringify(scrub(value), null, 2) + '\n'); fs.renameSync(temp, file) }
  const append = (file, value) => fs.appendFileSync(path.join(evidence, file), JSON.stringify(scrub(value)) + '\n')
  const result = { schemaVersion: 1, scope: 'real Electron live history/composer monitor; supplemental to full-client acceptance; one selected-session BrowserEngineBridge', buildId, base, clientRoot, evidence, profile, startedAt: now(), finishedAt: null, visits: 0, passedVisits: 0, failedVisits: 0, cycles: 0, pageErrors: 0, consoleErrors: 0, leases: 0, stopReason: null, passed: false }
  let app, page, stopping = null, seenActive = config.supervisor.phase === 'active', selected = null, sequence = 0
  const completedLeases = new Set()
  const signalStop = () => { stopping = 'signal' }
  process.on('SIGINT', signalStop); process.on('SIGTERM', signalStop)
  const save = phase => { write(path.join(evidence, 'result.json'), result); write(files.status, { at: now(), pid: process.pid, phase, buildId, base, evidence, profile, selectedSessionId: selected, visits: result.visits, passedVisits: result.passedVisits, failedVisits: result.failedVisits, pageErrors: result.pageErrors, browserLeaseFile: files.lease }) }
  const checkStop = () => {
    if (stopping) return stopping
    if (fs.existsSync(path.join(runRoot, 'STOP')) || fs.existsSync(path.join(evidence, 'STOP'))) return 'STOP'
    const status = read(path.join(runRoot, 'supervisor-status.json'))
    assert.equal(status.buildId, buildId, 'Supervisor build changed during live monitoring')
    assert.equal(status.base.replace(/\/+$/, ''), base, 'Supervisor endpoint changed during live monitoring')
    if (status.phase === 'active') seenActive = true
    if (['cleanup', 'stopped', 'post-driver-acceptance'].includes(status.phase) || (seenActive && status.phase !== 'active')) return 'supervisor-' + status.phase
    return null
  }
  const expectedEngine = async () => {
    const engine = await page.evaluate(() => window.aether.engine.getSnapshot())
    assert.equal(engine.mode, 'remote'); assert.equal(engine.phase, 'ready'); assert.equal(engine.baseUrl.replace(/\/+$/, ''), base)
    assert.equal(engine.buildId, buildId, 'Real remote client is connected to a different build')
    return { mode: engine.mode, baseUrl: engine.baseUrl, instanceId: engine.instanceId, accountId: engine.accountId }
  }
  const request = async (route, query = {}) => {
    const identity = await expectedEngine()
    const out = await page.evaluate(({ route, query, identity }) => window.aether.engine.request({ method: 'GET', path: route, query, expectedEngine: identity }), { route, query, identity })
    assert.ok(out.ok, route + ': ' + out.message)
    return out.data
  }
  const showHistory = async () => {
    if (!await page.locator('.history-view').isVisible()) await page.locator('.activity-bar button[title="会话历史"]').click()
    await expect(page.locator('.history-view')).toBeVisible({ timeout: 20_000 })
  }
  const selectSession = async session => {
    await showHistory()
    const refresh = page.getByRole('button', { name: '刷新会话列表', exact: true })
    // The history panel can still be hydrating while the remote engine is
    // already ready. Waiting for the real enabled state avoids turning this
    // transient UI race into a false remote-session failure.
    await expect(refresh).toBeEnabled({ timeout: 30_000 })
    await refresh.click()
    const list = await request('/conversation/sessions')
    const summary = list.find(row => row.sessionId === session.sessionId)
    assert.ok(summary, 'Original session disappeared from real engine history: ' + session.sessionId)
    const title = historyTitle(summary.title ?? summary.lastMessage)
    const rows = page.locator('.history-view__item')
    const titleRows = rows.filter({ has: page.locator('.history-view__summary', { hasText: new RegExp('^' + escapeRegex(title) + '$') }) })
    // Titles can collide or change while a long-running turn is still being
    // persisted. Prefer the stable engine-owned session id exposed by the
    // history item and retain title matching only for older client builds.
    const idRows = page.locator('.history-view__item[data-session-id=' + JSON.stringify(session.sessionId) + ']')
    const candidates = []
    const candidateRows = await idRows.count() > 0 ? idRows : titleRows
    assert.ok(await candidateRows.count() > 0, `Could not locate session ${session.sessionId} by title or stable id`)
    // The bridge remains the final authority because a stale DOM row can
    // survive a refresh while the session list is hydrating.
    for (let index = 0; index < await candidateRows.count(); index++) candidates.push(candidateRows.nth(index))
    let selectedRow = null
    let lastConnection = null
    for (const candidate of candidates) {
      await candidate.click()
      try {
        await expect.poll(() => page.evaluate(() => window.aether.browser.getConnection()), { timeout: 5_000 }).toMatchObject({ status: 'connected', sessionId: session.sessionId })
        selectedRow = candidate
        break
      } catch {
        lastConnection = await page.evaluate(() => window.aether.browser.getConnection()).catch(() => null)
      }
    }
    assert.ok(selectedRow, `Could not activate session ${session.sessionId}; last browser connection: ${JSON.stringify(lastConnection)}`)
    await expect(selectedRow).toHaveClass(/is-active/)
    selected = session.sessionId
    return title
  }
  const observe = async (session, kind = 'cycle', reload = false) => {
    const ordinal = ++sequence, prefix = String(ordinal).padStart(6, '0') + '-session-' + session.index
    const record = { at: now(), ordinal, kind, sessionId: session.sessionId, passed: false, snapshotFile: path.join(evidence, prefix + '.json'), screenshotFile: path.join(evidence, prefix + '.png') }
    result.visits++
    try {
      record.title = await selectSession(session)
      if (reload) { await page.reload(); await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 30_000 }); record.reloaded = true }
      let stable = false
      for (let attempt = 0; attempt < 3 && !stable; attempt++) {
        const snapshot = await request('/chat/snapshot', { sessionId: session.sessionId })
        const memory = await request('/memory/settings', { sessionId: session.sessionId })
        let ui, uiError
        try {
        // Session restore updates the model picker after useChat has hydrated
        // the selected snapshot. Wait for the enabled barrier before checking
        // the title so the previous session's model is never treated as a
        // real mismatch.
        await expect(page.locator('.model-picker__trigger')).toBeEnabled({ timeout: 30_000 })
        await expect(page.locator('.model-picker__trigger')).toHaveAttribute('title', '当前模型：' + snapshot.run?.modelId, { timeout: 20_000 })
        const latestUser = page.locator('.message--user[data-message-id=' + JSON.stringify(snapshot.run?.userMessageId) + ']')
        await expect(latestUser).toHaveCount(1, { timeout: 20_000 })
        await page.getByRole('button', { name: '对话偏好', exact: true }).click()
        await expect(page.locator('[title="选择长期记忆范围"]')).toContainText({ off: '关闭记忆', global: '全局记忆', session: '仅本会话' }[memory.memoryScope], { timeout: 20_000 })
        const memoryLabel = await page.locator('[title="选择长期记忆范围"]').textContent()
        await page.keyboard.press('Escape')
        ui = { sessionId: session.sessionId, modelTitle: await page.locator('.model-picker__trigger').getAttribute('title'),
          resourceLabels: await page.locator('.resource-binding-strip button').evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label'))),
          memoryLabel: memoryLabel ?? '', userIds: await page.locator('.message--user[data-message-id]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-message-id'))),
          latestTurnId: await latestUser.getAttribute('data-turn-id'), browser: await page.evaluate(() => window.aether.browser.getConnection()) }
        } catch (error) { uiError = error; await page.keyboard.press('Escape').catch(() => {}) }
        const after = await request('/chat/snapshot', { sessionId: session.sessionId }), afterMemory = await request('/memory/settings', { sessionId: session.sessionId })
        if (observationFingerprint(snapshot, memory) !== observationFingerprint(after, afterMemory)) { append('races.jsonl', { at: now(), sessionId: session.sessionId, ordinal, attempt, before: snapshot.run?.runId, after: after.run?.runId }); continue }
        if (uiError) throw uiError
        record.observation = validateObservation(snapshot, memory, ui)
        write(record.snapshotFile, { at: now(), snapshot, memory, ui })
        stable = true
      }
      assert.ok(stable, 'Session changed during all observation attempts; no stable UI comparison')
      await page.screenshot({ path: record.screenshotFile, fullPage: true })
      record.passed = true; result.passedVisits++
    } catch (error) {
      record.error = String(error.stack ?? error); result.failedVisits++
      await page?.screenshot({ path: record.screenshotFile, fullPage: true }).catch(() => {})
    }
    record.finishedAt = now(); append('observations.jsonl', record); save('monitoring')
    return record
  }
  const leaseRound = async () => {
    const raw = optional(files.request)
    if (!raw || completedLeases.has(raw.requestId)) return false
    let lease
    try { lease = normalizeLease(raw, state.sessions.map(session => session.sessionId)) }
    catch (error) { write(files.lease, { state: 'rejected', at: now(), requestId: raw.requestId, buildId, error: String(error.message) }); completedLeases.add(raw.requestId); return false }
    const session = state.sessions.find(row => row.sessionId === lease.sessionId)
    const record = await observe(session, 'browser-lease')
    if (!record.passed) { write(files.lease, { ...lease, state: 'failed', at: now(), buildId, evidenceFile: record.snapshotFile, error: record.error }); completedLeases.add(lease.requestId); return true }
    try {
      const region = page.getByRole('region', { name: '内置浏览器', exact: true })
      if (!await region.isVisible()) await page.keyboard.press('Control+Alt+b')
      await expect(region).toBeVisible({ timeout: 20_000 })
      const connection = await page.evaluate(() => window.aether.browser.getConnection())
      assert.equal(connection.sessionId, lease.sessionId); assert.equal(connection.status, 'connected')
      const screenshotFile = path.join(evidence, 'lease-' + lease.requestId + '.png')
      await page.screenshot({ path: screenshotFile, fullPage: true })
      assert.ok(Date.now() < lease.expiresAtMs, 'Browser lease expired while the real client was becoming ready')
      result.leases++
      write(files.lease, { ...lease, state: 'ready', at: now(), buildId, base, connection, screenshotFile, evidenceFile: record.snapshotFile, scope: 'Only this selected session has the real visible client bridge; caller must complete before expiry or release' })
      append('browser-leases.jsonl', { ...lease, state: 'ready', at: now(), connection, screenshotFile })
      save('browser-lease')
      let reason = 'expired'
      while (Date.now() < lease.expiresAtMs) {
        const stopped = checkStop(), release = optional(files.release)
        if (stopped) { reason = stopped; break }
        if (release?.requestId === lease.requestId) { reason = 'released'; break }
        const active = await page.evaluate(() => window.aether.browser.getConnection())
        assert.equal(active.status, 'connected'); assert.equal(active.sessionId, lease.sessionId, 'Real browser lease changed during a probe')
        await wait(Math.min(1000, Math.max(1, lease.expiresAtMs - Date.now())))
      }
      write(files.lease, { ...lease, state: reason === 'released' ? 'released' : 'ended', at: now(), buildId, reason })
      append('browser-leases.jsonl', { ...lease, state: 'ended', at: now(), reason })
    } catch (error) { write(files.lease, { ...lease, state: 'failed', at: now(), buildId, error: String(error.stack ?? error) }); append('errors.jsonl', { at: now(), phase: 'browser-lease', error: String(error.stack ?? error) }); result.failedVisits++ }
    finally { completedLeases.add(lease.requestId) }
    return true
  }
  try {
    fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ engineMode: 'remote', remoteBaseUrl: base, remoteWorkspaceRoot: '', autoStartEngine: true, lastSessionId: '', lastFolder: '', thinkingMode: 'off' }))
    const environment = { ...process.env }
    for (const key of Object.keys(environment)) if (/^ELECTRON_(RUN_AS_NODE|RENDERER_URL)$|^AETHER_IDE_REMOTE_/i.test(key)) delete environment[key]
    Object.assign(environment, { AETHER_IDE_REMOTE_INSTANCE_TOKEN: token, AETHER_GLOBAL_DIR: path.join(profile, 'global') })
    save('launching')
    app = await electron.launch({ args: ['.', '--user-data-dir=' + profile], cwd: clientRoot, env: environment })
    const child = app.process(); result.electronPid = child.pid
    for (const [name, stream] of [['electron.stdout.log', child.stdout], ['electron.stderr.log', child.stderr]]) {
      let buffered = ''
      stream?.on('data', chunk => {
        buffered += chunk.toString('utf8')
        const lines = buffered.split(/\r?\n/); buffered = lines.pop() ?? ''
        if (lines.length) fs.appendFileSync(path.join(evidence, name), lines.map(line => line.split(token).join('[REDACTED]')).join('\n') + '\n')
      })
      stream?.on('end', () => { if (buffered) fs.appendFileSync(path.join(evidence, name), buffered.split(token).join('[REDACTED]') + '\n') })
    }
    page = await app.firstWindow(); page.setDefaultTimeout(20_000)
    page.on('pageerror', error => { result.pageErrors++; append('pageerrors.jsonl', { at: now(), selectedSessionId: selected, error: String(error.stack ?? error) }) })
    page.on('console', message => { if (message.type() === 'error') { result.consoleErrors++; append('console-errors.jsonl', { at: now(), selectedSessionId: selected, message: message.text() }) } })
    await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90_000 })
    result.engine = await page.evaluate(() => window.aether.engine.getSnapshot()); await expectedEngine()
    append('lifecycle.jsonl', { at: now(), phase: 'ready', pid: child.pid, engine: result.engine })
    while (!(result.stopReason = checkStop())) {
      const cycle = result.cycles++, order = cycle % 2 ? [...state.sessions].reverse() : state.sessions
      for (const session of order) {
        if ((result.stopReason = checkStop())) break
        await leaseRound()
        if ((result.stopReason = checkStop())) break
        await observe(session, 'cycle', cycle > 0 && cycle % 10 === 0 && session === order[0])
      }
      if (result.stopReason) break
      const until = Date.now() + options.intervalMs
      while (Date.now() < until && !(result.stopReason = checkStop())) { await leaseRound(); await wait(Math.min(1000, Math.max(1, until - Date.now()))) }
    }
  } catch (error) { result.error = String(error.stack ?? error); result.stopReason = 'monitor-error'; append('errors.jsonl', { at: now(), phase: 'monitor', error: result.error }) }
  finally {
    try { await app?.close(); result.ownedElectronClosed = true }
    catch (error) { result.closeError = String(error.stack ?? error); result.ownedElectronClosed = false }
    result.finishedAt = now(); result.passed = result.visits >= 5 && result.failedVisits === 0 && result.pageErrors === 0 && !result.error && result.ownedElectronClosed === true
    append('lifecycle.jsonl', { at: now(), phase: 'stopped', reason: result.stopReason, ownedElectronClosed: result.ownedElectronClosed })
    save('stopped')
    process.off('SIGINT', signalStop); process.off('SIGTERM', signalStop)
    if (optional(lock)?.pid === process.pid) fs.unlinkSync(lock)
  }
  return scrub(result)
}

if (process.argv[1] && samePath(process.argv[1], fileURLToPath(import.meta.url))) {
  try { const result = await runMonitor(parseArguments(process.argv.slice(2))); console.log(JSON.stringify(result, null, 2)); if (!result.checked && !result.passed) process.exitCode = 1 }
  catch (error) { console.error(error.message); process.exitCode = 1 }
}
