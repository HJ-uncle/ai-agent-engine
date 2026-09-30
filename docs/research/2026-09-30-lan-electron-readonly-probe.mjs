/**
 * Manual, read-only probe of the running engine through the host's real LAN address.
 * Run only after rebuilding aether-code and after other Electron tests have stopped:
 *   node docs/research/2026-09-30-lan-electron-readonly-probe.mjs --run
 * This is a same-host LAN-address check, not a cross-machine test or an auth-enforcement test.
 * No fake server, IPC replacement, production credential, session click, or SSE subscription.
 */
import { createRequire } from 'node:module'
import { randomUUID, createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const researchRoot = dirname(fileURLToPath(import.meta.url))
const engineRoot = resolve(researchRoot, '..', '..')
const appRoot = resolve(engineRoot, '..', 'aether-code')
const remoteBaseUrl = 'http://10.219.14.186:12323'
const observationToken = 'lan-observation-synthetic-not-a-production-secret'

if (!process.argv.includes('--run')) {
  console.log('Usage: node docs/research/2026-09-30-lan-electron-readonly-probe.mjs --run')
  console.log('Requires a freshly built sibling aether-code and no concurrently running Electron tests.')
  process.exit(0)
}

const require = createRequire(join(appRoot, 'package.json'))
const { _electron: electron, expect } = require('@playwright/test')
const fixtureRoot = join(engineRoot, '.e2e-tmp')
mkdirSync(fixtureRoot, { recursive: true })
const userData = mkdtempSync(join(fixtureRoot, 'lan-electron-observe-'))
const evidenceDir = join(researchRoot, '2026-09-30-lan-electron-evidence', basename(userData))
mkdirSync(evidenceDir, { recursive: true })
const observationSession = `lan-observe-${randomUUID()}`
const reportFile = join(evidenceDir, 'report.json')
const screenshotFile = join(evidenceDir, 'lan-ready-history-masked.png')
let app
let page
let stage = 'prepare'
const report = {
  startedAt: new Date().toISOString(),
  target: remoteBaseUrl,
  topology: 'same-host LAN address; not cross-machine',
  transport: 'real Electron preload IPC and main-process HTTP; no fake server',
  credentialSource: 'synthetic environment token; no production secret read',
  authenticationEnforcementVerified: false,
  explicitRemoteMutations: 0,
  explicitSseSubscriptions: 0,
  actualSessionSelectedInUi: false,
  observationLimits: 'Only GET requests; server handlers may initialize or migrate storage, project pending history, or discover MCP tools. Snapshot uses a fresh session to avoid clearing a live disconnect timer.',
  outputPolicy: 'status, counts, and allowlisted metadata only; history screenshot masked',
  routes: [],
  errors: [],
  ui: {},
  appOutputBytes: { stdout: 0, stderr: 0 },
  rendererErrorCount: 0
}

function category(error) {
  const message = String(error?.message ?? '')
  if (/timeout|timed out/i.test(message)) return 'timeout'
  if (/launch|executable|ENOENT/i.test(message)) return 'launch-or-build-unavailable'
  if (/closed|crash|destroyed/i.test(message)) return 'application-closed'
  return 'assertion-or-request-failed'
}

function isolatedEnvironment() {
  // Copy only OS runtime settings, rather than inheriting model/API/remote secrets.
  const allowed = new Set([
    'PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'SYSTEMDRIVE', 'COMSPEC', 'OS',
    'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA',
    'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMW6432', 'COMMONPROGRAMFILES',
    'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS', 'LANG', 'LC_ALL', 'TZ',
    'DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS'
  ])
  const env = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && allowed.has(key.toUpperCase())) env[key] = value
  }
  return {
    ...env,
    AETHER_IDE_REMOTE_INSTANCE_TOKEN: observationToken,
    AETHER_IDE_ECHO_ENGINE: '0',
    AETHER_GLOBAL_DIR: join(userData, 'global'),
    WORKSPACE_ROOT: join(userData, 'workspace'),
    MCP_CONFIG_PATH: join(userData, 'mcp.json'),
    SKILLS_ROOT: join(userData, 'skills'),
    ENABLE_LONG_TERM_MEMORY: 'false'
  }
}

async function deadline(promise, milliseconds) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('probe timeout')), milliseconds) })
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function captureMaskedScreenshot() {
  if (!page || page.isClosed()) return
  // Keep real layout and load state. Mask live titles/messages and raw error text in pixels.
  await page.screenshot({
    path: screenshotFile,
    fullPage: true,
    mask: [
      page.locator('.history-view__list'),
      page.locator('.chat__messages'),
      page.locator('.history-view__empty--error'),
      page.locator('.changes-panel__error')
    ]
  })
  report.screenshot = screenshotFile
}

try {
  const mainFile = join(appRoot, 'out', 'main', 'index.js')
  const rendererFile = join(appRoot, 'out', 'renderer', 'index.html')
  if (!existsSync(mainFile) || !existsSync(rendererFile)) throw new Error('build unavailable')
  report.build = {
    mainModifiedAt: statSync(mainFile).mtime.toISOString(),
    mainSha256: createHash('sha256').update(readFileSync(mainFile)).digest('hex'),
    rendererModifiedAt: statSync(rendererFile).mtime.toISOString()
  }
  mkdirSync(join(userData, 'workspace'))
  writeFileSync(join(userData, 'settings.json'), JSON.stringify({
    engineMode: 'remote', remoteBaseUrl, autoStartEngine: true,
    lastFolder: '', lastSessionId: observationSession, lastModelId: '', lastAgentId: ''
  }))

  stage = 'launch-isolated-electron'
  app = await electron.launch({
    args: ['.', `--user-data-dir=${userData}`], cwd: appRoot,
    env: isolatedEnvironment(), timeout: 60_000
  })
  // Count output without printing or persisting its potentially sensitive contents.
  app.process().stdout?.on('data', chunk => { report.appOutputBytes.stdout += chunk.length })
  app.process().stderr?.on('data', chunk => { report.appOutputBytes.stderr += chunk.length })
  page = await app.firstWindow()
  page.on('pageerror', () => { report.rendererErrorCount++ })
  stage = 'await-real-lan-ready'
  await expect.poll(async () => page.evaluate(() => window.aether.engine.getSnapshot().then(value => value.phase)), {
    timeout: 45_000
  }).toBe('ready')
  report.engine = await page.evaluate(async () => {
    const value = await window.aether.engine.getSnapshot()
    return { phase: value.phase, mode: value.mode, baseUrl: value.baseUrl, adopted: value.adopted, pid: value.pid }
  })
  expect(report.engine).toMatchObject({ mode: 'remote', phase: 'ready', baseUrl: remoteBaseUrl, pid: null })
  await expect(page.locator('button.status-bar__item--ready')).toBeVisible()
  console.log(JSON.stringify({ stage: 'connected', target: remoteBaseUrl, phase: 'ready' }))

  stage = 'probe-readonly-ipc-routes'
  const results = await deadline(page.evaluate(async ({ observationSession }) => {
    const rows = []
    const summarize = (path, response, scope) => {
      const result = { path, method: 'GET', scope, ok: response.ok === true, code: response.code }
      const data = response.data
      if (Array.isArray(data)) result.count = data.length
      else if (data && typeof data === 'object') {
        const counts = {}
        for (const key of ['history', 'changes', 'runs', 'todos', 'jobs', 'policies', 'projection']) {
          if (Array.isArray(data[key])) counts[key] = data[key].length
        }
        if (Object.keys(counts).length) result.counts = counts
        if (typeof data.finished === 'boolean') result.finished = data.finished
        if (['live', 'persisted'].includes(data.source)) result.source = data.source
        if (path === '/meta') {
          result.metadata = {
            version: typeof data.version === 'string' && /^[a-zA-Z0-9.+_-]{1,60}$/.test(data.version) ? data.version : null,
            buildId: typeof data.buildId === 'string' && /^sha256:[a-f0-9]{64}$/.test(data.buildId) ? data.buildId : null,
            protocolVersion: typeof data.protocolVersion === 'number' ? data.protocolVersion : null,
            subagentSchemaVersion: typeof data.subagentSchemaVersion === 'number' ? data.subagentSchemaVersion : null,
            toolProfileCount: Array.isArray(data.toolProfiles) ? data.toolProfiles.length : 0
          }
        }
      }
      return result
    }
    const read = async (path, query = {}, scope = 'engine') => {
      try {
        const response = await window.aether.engine.request({ method: 'GET', path, query })
        rows.push(summarize(path, response, scope))
        return response.ok ? response.data : null
      } catch {
        rows.push({ path, method: 'GET', scope, ok: false, code: null, error: 'ipc-request-rejected' })
        return null
      }
    }
    await read('/health')
    await read('/meta')
    await read('/tools', { pageSize: 1000 })
    await read('/models', { pageSize: 1000 })
    const sessions = await read('/conversation/sessions')
    const existing = Array.isArray(sessions)
      ? sessions.find(value => typeof value?.sessionId === 'string' && value.sessionId.length > 0)
      : undefined
    // A real ID remains local to this evaluation. Never set it as the UI's selected session.
    const sessionId = existing?.sessionId ?? observationSession
    const scope = existing ? 'existing-session-read-only' : 'fresh-observation-session'
    await read('/conversation/history', { sessionId }, scope)
    // This handler clears a live session's disconnect timer even without SSE. Use only
    // the fresh observation ID, never the real session selected for history/changes reads.
    await read('/chat/snapshot', { sessionId: observationSession }, 'fresh-observation-session')
    await read('/changes', { sessionId, status: 'pending' }, scope)
    await read('/subagent/runs', { parentSessionId: sessionId }, scope)
    await read('/command-jobs', { sessionId }, scope)
    await read('/security/mode', { sessionId }, scope)
    await read('/security/policies', {}, 'engine')
    return { routes: rows, existingSessionUsedForGetOnly: Boolean(existing), sessionCount: Array.isArray(sessions) ? sessions.length : 0 }
  }, { observationSession }), 120_000)
  Object.assign(report, results)

  stage = 'verify-readonly-ui-without-selecting-live-session'
  const historyButton = page.getByRole('button', { name: '会话历史', exact: true })
  if (await historyButton.getAttribute('aria-pressed') !== 'true') await historyButton.click()
  await expect(page.locator('.history-view')).toBeVisible()
  await page.getByRole('button', { name: '刷新会话列表', exact: true }).click()
  await expect.poll(async () => page.locator('.history-view').evaluate(element => {
    const loading = [...element.querySelectorAll('.history-view__empty')].some(node => node.textContent?.includes('正在加载'))
    const hasRows = element.querySelectorAll('.history-view__item').length > 0
    const hasEmpty = [...element.querySelectorAll('.history-view__empty')].some(node => node.textContent?.includes('暂无历史会话'))
    return !loading && (hasRows || hasEmpty)
  }), { timeout: 20_000 }).toBe(true)
  await expect(page.locator('.history-view__empty--error')).toHaveCount(0)
  await expect(page.locator('.changes-panel__error')).toHaveCount(0)
  await expect(page.locator('.chat-panel').getByRole('button', { name: '发送', exact: true })).toBeDisabled()
  const stillObservation = await page.evaluate(async expected => (await window.aether.settings.get()).lastSessionId === expected, observationSession)
  expect(stillObservation).toBe(true)
  report.ui = {
    readyVisible: true,
    historyLoaded: true,
    visibleHistoryRows: await page.locator('.history-view__item').count(),
    historyLoadErrors: 0,
    changesErrors: 0,
    sendDisabled: true,
    selectedSessionRemainedFreshObservation: stillObservation
  }
  await captureMaskedScreenshot()
  report.ok = report.routes.every(result => result.ok) && report.rendererErrorCount === 0
  if (!report.ok) process.exitCode = 1
} catch (error) {
  report.ok = false
  report.errors.push({ stage, category: category(error) })
  process.exitCode = 1
  try { await captureMaskedScreenshot() } catch { report.errors.push({ stage: 'screenshot', category: 'capture-failed' }) }
} finally {
  // app.close() only closes the Electron process launched above. Remote EngineHost owns no server process.
  if (app) {
    try { await app.close() } catch { report.errors.push({ stage: 'close-owned-electron', category: 'close-failed' }); report.ok = false; process.exitCode = 1 }
  }
  const fixtureRelative = relative(fixtureRoot, resolve(userData))
  if (dirname(userData) === fixtureRoot && !fixtureRelative.startsWith('..') && basename(userData).startsWith('lan-electron-observe-')) {
    try { rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }) }
    catch { report.errors.push({ stage: 'cleanup-isolated-userdata', category: 'cleanup-failed' }) }
  } else {
    report.errors.push({ stage: 'cleanup-isolated-userdata', category: 'path-check-refused' })
  }
  report.finishedAt = new Date().toISOString()
  writeFileSync(reportFile, JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ ...report, reportFile }, null, 2))
}
