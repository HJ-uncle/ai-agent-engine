import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { pathToFileURL } from 'node:url'

const json = file => JSON.parse(fs.readFileSync(file, 'utf8'))
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' })
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const equal = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()

export function recoverContinuation(sourceRoot, destination) {
  sourceRoot = fs.realpathSync(sourceRoot)
  const state = json(path.join(sourceRoot, 'continuation-state.json'))
  const checkpoint = json(path.join(sourceRoot, 'checkpoint.json'))
  const cleanup = json(path.join(sourceRoot, 'continuation-cleanup.json'))
  const status = json(path.join(sourceRoot, 'supervisor-status.json'))
  if (!equal(state.root, sourceRoot) || !equal(checkpoint.root, sourceRoot) || status.phase !== 'stopped') throw new Error('Source must be the completed maintenance-stopped continuation')
  if (!Array.isArray(cleanup.remaining) || cleanup.remaining.length || cleanup.errors?.length) throw new Error('Source has unresolved owned processes')
  const processAuditFile = path.join(sourceRoot, 'recovery-process-audit.json')
  const processAudit = fs.existsSync(processAuditFile) ? json(processAuditFile) : cleanup
  if (processAudit.inventoryComplete !== true || processAudit.remaining?.length || processAudit.errors?.length) throw new Error('Complete stopped process inventory required')
  // Older supervisors recorded a vanilla SQLite diagnostic only. The caller
  // supplies a new authoritative recheck without rewriting that old evidence.
  const auditFile = path.join(sourceRoot, 'recovery-database-audit.json')
  const audit = fs.existsSync(auditFile) ? json(auditFile) : cleanup.databaseAudit
  if (audit?.passed !== true || audit.databases?.length !== 3 || !audit.databases.every(item => item.backend === 'native-libsql' && item.passed === true)) throw new Error('Authoritative stopped database and terminal-state audit required')
  if (state.sessions.length !== 5 || checkpoint.sessions.length !== 5 || !state.sessions.every(item => checkpoint.sessions.some(peer => peer.sessionId === item.sessionId && peer.roleId === item.roleId))) throw new Error('Original five sessions must be retained')
  const parent = fs.realpathSync(path.join(state.projectRoot, 'runs'))
  destination = path.resolve(destination ?? path.join(parent, 'recovery-' + new Date().toISOString().replace(/[^0-9]/g, '')))
  if (!equal(path.dirname(destination), parent) || !/^recovery-[a-z0-9-]+$/i.test(path.basename(destination)) || fs.existsSync(destination)) throw new Error('Recovery must use a new contained recovery-* run directory')
  const observations = []
  fs.mkdirSync(destination)
  write(path.join(destination, 'recovery-owner.json'), { at: new Date().toISOString(), sourceRoot, destination, sourceCheckpointHash: hash(path.join(sourceRoot, 'checkpoint.json')) })
  function copy(relative) {
    const source = path.join(sourceRoot, relative), target = path.join(destination, relative)
    if (!fs.existsSync(source)) return
    const stat = fs.lstatSync(source)
    if (stat.isSymbolicLink()) throw new Error('Recovery refuses symlinks: ' + relative)
    if (stat.isDirectory()) { fs.mkdirSync(target, { recursive: true }); for (const child of fs.readdirSync(source)) copy(path.join(relative, child)); return }
    if (!stat.isFile()) throw new Error('Recovery refuses nonregular files')
    const before = hash(source)
    fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL)
    if (hash(target) !== before || hash(source) !== before) throw new Error('Source drift during recovery: ' + relative)
    observations.push({ path: relative, sha256: before })
  }
  for (const name of ['agent.db', 'agent.db-wal', 'agent.db-shm', 'knowledge.db', 'knowledge.db-wal', 'knowledge.db-shm', 'memory', 'global', 'workspace', 'skills', 'mcp.json', 'requirements', 'history-oracle.json', 'protected-baseline.json', 'gateway-preflight.json']) copy(name)
  // sessions/default etc. are engine transcripts; session-N are driver attempt
  // evidence. Evidence remains at the original run, never overwritten/replayed.
  for (const name of fs.readdirSync(path.join(sourceRoot, 'sessions'))) if (!/^session-[1-5]$/.test(name)) copy(path.join('sessions', name))
  const remap = value => typeof value === 'string' && value.toLowerCase().startsWith(sourceRoot.toLowerCase() + path.sep) ? destination + value.slice(sourceRoot.length) : Array.isArray(value) ? value.map(remap) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, remap(item)])) : value
  const queueFile = path.join(destination, 'requirements', 'queue.json'), queue = json(queueFile)
  for (const item of Array.isArray(queue) ? queue : queue.requirements ?? []) item.dependencies = (item.dependencies ?? []).filter(id => id !== 'runtime-upgrade-acceptance-gate')
  fs.writeFileSync(queueFile, JSON.stringify(queue, null, 2) + '\n')
  const origin = { sourceRoot, sourceCheckpointHash: hash(path.join(sourceRoot, 'checkpoint.json')), priorFirstDispatchAt: checkpoint.firstDispatchAt, priorSessions: checkpoint.sessions, priorReport: path.join(sourceRoot, 'active-report.json'), sourcePreserved: true }
  write(path.join(destination, 'recovery-history.json'), origin)
  const sessions = checkpoint.sessions.map(session => {
    const recoveryImplementation = {}
    for (const attempt of [...session.rounds, ...(session.pending ? [session.pending] : [])]) {
      if (!attempt.requirementId || session.accepted.some(item => item.id === attempt.requirementId) || recoveryImplementation[attempt.requirementId]) continue
      const file = attempt.evidenceFile ?? attempt.stateFile
      if (!file || !fs.existsSync(file)) continue
      const relative = path.relative(sourceRoot, path.resolve(file))
      if (relative.startsWith('..') || path.isAbsolute(relative) || fs.lstatSync(file).isSymbolicLink()) throw new Error('Recovery implementation evidence escapes source')
      const evidence = json(file)
      if (evidence.kind === 'development' && Array.isArray(evidence.before) && evidence.before.length) recoveryImplementation[attempt.requirementId] = { before: evidence.before, evidenceFile: file, evidenceSha256: hash(file), qualification: 'Cumulative original implementation changes; not fresh candidate development time' }
    }
    return { ...session, accepted: remap(session.accepted), rounds: [], errors: [], pending: null, status: 'ready', modelRotationBase: session.accepted.length, recoveryImplementation, recoveryOrigin: { sourceRoot, priorStatus: session.status, priorRounds: session.rounds.length, priorErrors: session.errors.length, abandonedDispatch: session.pending?.dispatchId ?? null } }
  })
  // A durable terminal attempt is observed, never reposted. Any partial feature
  // is picked up by a NEW dispatch with its original frozen red baseline.
  write(path.join(destination, 'checkpoint.json'), { ...checkpoint, root: destination, createdAt: new Date().toISOString(), firstDispatchAt: null, firstQualifiedDevelopmentAt: null, firstWave: [], durationMs: 360 * 60000, sessions, recoverySourceRoot: sourceRoot })
  if (fs.existsSync(path.join(sourceRoot, 'resources.json'))) {
    const resources = remap(json(path.join(sourceRoot, 'resources.json')))
    // CRUD is reverified against the NEW engine before its gates can release.
    resources.knowledgeApiAcceptance = { passed: false, reason: 'Fresh runtime CRUD recheck required', inheritedEvidenceFile: path.join(sourceRoot, 'resources.json') }
    write(path.join(destination, 'resources.json'), resources)
  }
  fs.writeFileSync(path.join(destination, '.instance-token'), randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 })
  for (const name of ['logs', 'resources', 'checkpoints']) fs.mkdirSync(path.join(destination, name), { recursive: true })
  // Preserve MCP checkpoints as task data, rather than inherited test passes.
  if (fs.existsSync(path.join(sourceRoot, 'resources'))) for (const child of fs.readdirSync(path.join(sourceRoot, 'resources'))) copy(path.join('resources', child))
  write(path.join(destination, 'continuation-state.json'), { ...state, root: destination, at: new Date().toISOString(), recoverySourceRoot: sourceRoot, sourcePreserved: true, recoveredFiles: observations, effectiveDurationMinutes: 360, firstWaveModels: ['qwen3.8-flash', 'qwen3.8-flash', 'qwen3.8-flash', 'MiniMax-M2.5', 'glm-5.3'] })
  return { sourceRoot, root: destination, sessionIds: sessions.map(session => session.sessionId), acceptedMilestones: sessions.map(session => session.accepted.map(item => item.id)), retainedEvidence: path.join(destination, 'recovery-history.json'), copiedFiles: observations.length, freshClientAndSemanticAcceptanceRequired: true }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) console.log(JSON.stringify(recoverContinuation(process.argv[2], process.argv[3]), null, 2))
