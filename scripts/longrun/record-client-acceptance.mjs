/** Preserve complete Playwright evidence and record the full client gate once.
 * Usage: node record-client-acceptance.mjs --run-root <owned recovery run>
 *   --build-id sha256:<64 hex> --started-at <ISO> --finished-at <ISO>
 *   --list-file <full --list JSON> --report-file <full execution JSON>
 *   --exit-code <integer> [--log-file <human-readable log>]
 *   [--signal <termination signal>] [--timed-out true|false]
 */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { playwrightCases, qualifyClientEvidence } from './analyze-continuation.mjs'

const defaultEngineRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const hash = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex')
const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
const time = value => typeof value === 'number' ? value : Date.parse(value)

/** Reject junctions as well as symbolic links at every existing path component. */
export function assertOrdinaryPath(value, kind) {
  const resolved = path.resolve(value), parsed = path.parse(resolved)
  let current = parsed.root
  for (const part of resolved.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part)
    const stat = fs.lstatSync(current, { throwIfNoEntry: false })
    if (!stat) continue
    if (stat.isSymbolicLink() || !same(fs.realpathSync(current), current)) throw new Error('Evidence path contains a link: ' + current)
  }
  if (kind) {
    const stat = fs.lstatSync(resolved)
    if (kind === 'file' ? !stat.isFile() : !stat.isDirectory()) throw new Error('Expected ordinary ' + kind + ': ' + resolved)
  }
  return resolved
}

function input(file) {
  file = assertOrdinaryPath(file, 'file')
  const bytes = fs.readFileSync(file)
  return { file, bytes, sha256: hash(bytes) }
}
function parseEvidence(item, label, reasons) {
  try { return JSON.parse(item.bytes.toString('utf8')) } catch { reasons.push(label + ' is not valid JSON'); return null }
}

/** A filtered --list cannot establish the complete client registration set. */
export function fullCommand(argv, listing = false) {
  if (!Array.isArray(argv)) return false
  const index = argv.indexOf('test')
  if (index < 0) return false
  const valueFlags = new Set(['--config', '-c', '--output', '--reporter', '--workers', '-j', '--timeout', '-t', '--global-timeout', '--max-failures', '-x', '--retries'])
  const plainFlags = new Set(['--list', '--headed', '--debug', '--forbid-only', '--quiet', '--fail-on-flaky-tests', '--no-deps'])
  let hasList = false
  for (let i = index + 1; i < argv.length; i++) {
    const argument = argv[i], flag = String(argument).split('=')[0]
    if (plainFlags.has(flag)) { if (flag === '--list') hasList = true; continue }
    if (valueFlags.has(flag)) { if (!String(argument).includes('=')) { if (i + 1 >= argv.length) return false; i++ } continue }
    // Specs, grep, projects, shards, last-failed and repeat-each narrow or alter
    // the uniquely registered identities and are not full-suite commands.
    return false
  }
  return hasList === listing
}

export function parseArguments(argv) {
  const flags = new Map([
    ['--run-root', 'runRoot'], ['--build-id', 'buildId'], ['--started-at', 'startedAt'],
    ['--finished-at', 'finishedAt'], ['--list-file', 'listFile'], ['--report-file', 'reportFile'],
    ['--exit-code', 'exitCode'], ['--log-file', 'logFile'], ['--signal', 'signal'], ['--timed-out', 'timedOut'],
  ])
  const options = { signal: null, timedOut: false }
  const seen = new Set()
  for (let i = 0; i < argv.length; i += 2) {
    const key = flags.get(argv[i]), value = argv[i + 1]
    if (!key || value === undefined || seen.has(key)) throw new Error('Unknown, duplicate or incomplete argument: ' + argv[i])
    seen.add(key)
    options[key] = value
  }
  if (options.exitCode !== undefined) options.exitCode = Number(options.exitCode)
  if (typeof options.timedOut === 'string') {
    if (!['true', 'false'].includes(options.timedOut)) throw new Error('--timed-out must be true or false')
    options.timedOut = options.timedOut === 'true'
  }
  return options
}

export function recordClientAcceptance(options) {
  const engineRoot = assertOrdinaryPath(options.engineRoot ?? defaultEngineRoot, 'directory')
  const parent = assertOrdinaryPath(path.join(engineRoot, 'test-projects', 'longrun-20261009', 'runs'), 'directory')
  const root = assertOrdinaryPath(options.runRoot, 'directory')
  if (!same(path.dirname(root), parent) || !/^recovery-[a-z0-9-]+$/i.test(path.basename(root))) throw new Error('Acceptance requires an owned recovery-* direct child of the retained runs directory')
  const stateInput = input(path.join(root, 'continuation-state.json')), state = JSON.parse(stateInput.bytes)
  if (typeof state.root !== 'string' || !same(state.root, root) || typeof state.sourceRoot !== 'string' || same(state.sourceRoot, root)) throw new Error('Continuation ownership does not match the selected recovery run')
  const freezeInput = input(path.join(root, 'continuation-freeze.json')), freeze = JSON.parse(freezeInput.bytes)
  if (!/^sha256:[a-f0-9]{64}$/.test(options.buildId ?? '') || freeze?.source?.manifest?.buildId !== options.buildId) throw new Error('Candidate buildId must match the existing immutable continuation freeze')
  if (!Number.isFinite(time(freeze.at))) throw new Error('Immutable candidate freeze chronology is missing')
  if (!Number.isInteger(options.exitCode) || typeof options.timedOut !== 'boolean' || !(options.signal === null || typeof options.signal === 'string')) throw new Error('Actual execution exitCode, signal and timedOut are required')
  if (!Number.isFinite(time(options.startedAt)) || !Number.isFinite(time(options.finishedAt)) || time(options.finishedAt) <= time(options.startedAt)) throw new Error('Actual complete process start/end chronology is required')

  const output = assertOrdinaryPath(path.join(root, 'client-acceptance.json'))
  const proofs = assertOrdinaryPath(path.join(root, 'proofs', 'full-client'))
  const sources = [
    { ...input(options.listFile), name: 'registration.json' },
    { ...input(options.reportFile), name: 'execution.json' },
    ...(options.logFile ? [{ ...input(options.logFile), name: 'execution.log' }] : []),
  ]
  const targets = [...sources.map(item => path.join(proofs, item.name)), path.join(proofs, 'process.json'), output]
  if (targets.some(file => fs.existsSync(file))) throw new Error('Client acceptance or raw proof already exists; retained evidence cannot be overwritten')
  const reasons = []
  const list = parseEvidence(sources[0], 'Registration report', reasons), raw = parseEvidence(sources[1], 'Execution report', reasons)
  const expected = playwrightCases(list), actual = playwrightCases(raw), byKey = new Map(actual.map(row => [row.key, row]))
  if (!fullCommand(list?.config?.argv, true) || !fullCommand(raw?.config?.argv, false)) reasons.push('Registration and execution must be unfiltered full-suite Playwright commands')
  if (options.exitCode !== 0 || options.signal !== null || options.timedOut !== false) reasons.push('Client process did not exit normally and successfully')
  if (!Array.isArray(raw?.errors) || raw.errors.length) reasons.push('Raw Playwright global errors are missing or nonempty')
  if (!Number.isFinite(time(raw?.stats?.startTime)) || !Number.isFinite(raw?.stats?.duration) || raw.stats.duration < 0) reasons.push('Raw Playwright execution duration is missing or invalid')
  if (time(options.startedAt) < time(freeze.at) || time(raw?.stats?.startTime) < time(options.startedAt)) reasons.push('Client execution predates the immutable candidate freeze or process start')
  const processEvidence = { schemaVersion: 1, buildId: options.buildId, startedAt: options.startedAt, finishedAt: options.finishedAt,
    exitCode: options.exitCode, signal: options.signal, timedOut: options.timedOut,
    originals: sources.map(item => ({ file: item.file, sha256: item.sha256 })) }
  fs.mkdirSync(proofs, { recursive: true })
  for (const item of sources) {
    const target = path.join(proofs, item.name)
    fs.writeFileSync(target, item.bytes, { flag: 'wx' })
    if (hash(fs.readFileSync(target)) !== item.sha256 || hash(fs.readFileSync(item.file)) !== item.sha256) throw new Error('Original or copied evidence changed during recording: ' + item.file)
  }
  const processFile = path.join(proofs, 'process.json')
  fs.writeFileSync(processFile, JSON.stringify(processEvidence, null, 2) + '\n', { flag: 'wx' })
  const relative = file => path.relative(root, file).split(path.sep).join('/')
  const receipt = {
    schemaVersion: 1, scope: 'full-client', fullSuite: true, passed: true, buildId: options.buildId,
    startedAt: options.startedAt, finishedAt: options.finishedAt, exitCode: options.exitCode, signal: options.signal, timedOut: options.timedOut,
    frozenAt: freeze.at, freezeFile: relative(freezeInput.file), freezeSha256: freezeInput.sha256,
    listFile: relative(path.join(proofs, sources[0].name)), listSha256: sources[0].sha256,
    rawReportFile: relative(path.join(proofs, sources[1].name)), rawReportSha256: sources[1].sha256,
    listTotal: expected.length,
    checks: expected.map(row => { const observed = byKey.get(row.key); return { name: row.name, project: row.project, passed: observed?.passed === true, attempts: observed?.attempts ?? 0, statuses: observed?.statuses ?? [] } }),
    proofFiles: [...sources.map(item => ({ path: relative(path.join(proofs, item.name)), sha256: item.sha256 })), { path: relative(processFile), sha256: hash(fs.readFileSync(processFile)) }],
    totals: { expected: expected.length, executed: actual.length, passed: actual.filter(row => row.passed).length,
      failed: actual.filter(row => row.statuses.some(status => ['failed', 'timedOut', 'interrupted'].includes(status))).length,
      skipped: actual.filter(row => row.statuses.includes('skipped')).length, flaky: raw?.stats?.flaky ?? null,
      notRun: actual.filter(row => row.statuses.length === 0).length + expected.filter(row => !byKey.has(row.key)).length },
    rawStats: raw?.stats ?? null,
  }
  const qualified = qualifyClientEvidence(receipt, output, options.buildId, freeze.at)
  receipt.qualification = { ...qualified, passed: qualified.passed && reasons.length === 0, reasons: [...new Set([...qualified.reasons, ...reasons])] }
  receipt.passed = receipt.qualification.passed
  if (hash(fs.readFileSync(stateInput.file)) !== stateInput.sha256 || hash(fs.readFileSync(freezeInput.file)) !== freezeInput.sha256) throw new Error('Ownership or frozen candidate changed during recording')
  fs.writeFileSync(output, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' })
  return { file: output, receipt }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const result = recordClientAcceptance(parseArguments(process.argv.slice(2)))
    console.log(JSON.stringify({ file: result.file, passed: result.receipt.passed, totals: result.receipt.totals, reasons: result.receipt.qualification.reasons }))
    process.exitCode = result.receipt.passed ? 0 : 2
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 }
}
