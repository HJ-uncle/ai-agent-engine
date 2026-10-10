/** Real candidate API exerciser followed by independent retained-evidence tests.
 * node knowledge-live-api.mjs OWNED_RECOVERY_ROOT --python EXISTING_PYTHON
 * Never touches old KBs, server processes, builds, gates or previous proofs.
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { buildKnowledgeFixtures, hash } from './knowledge-format-fixtures.mjs'
import { assertOrdinaryPath } from './record-client-acceptance.mjs'

const engineRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'))
const now = () => new Date().toISOString()
const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
const writeNew = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' })

export async function exerciseKnowledge(root, { python, proofName = 'knowledge-live' } = {}) {
  root = assertOrdinaryPath(root, 'directory')
  const runs = assertOrdinaryPath(path.join(engineRoot, 'test-projects/longrun-20261009/runs'), 'directory')
  if (!same(path.dirname(root), runs) || !/^recovery-[a-z0-9-]+$/i.test(path.basename(root))) throw new Error('An owned recovery-* root is required')
  if (!/^[a-z0-9-]+$/.test(proofName)) throw new Error('Ordinary unique proof name required')
  const state = read(path.join(root, 'continuation-state.json')), freeze = read(path.join(root, 'continuation-freeze.json')), status = read(path.join(root, 'supervisor-status.json'))
  if (!same(state.root, root) || same(state.sourceRoot, root)) throw new Error('Owned state must match the selected retained recovery root')
  const buildId = freeze.source?.manifest?.buildId, base = status.base
  if (!/^sha256:[a-f0-9]{64}$/.test(buildId ?? '') || status.buildId !== buildId || !Number.isFinite(Date.parse(freeze.at))) throw new Error('Actual frozen candidate identity is required')
  const url = new URL(base)
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/') throw new Error('Only the actual isolated loopback candidate may be exercised')
  const token = fs.readFileSync(assertOrdinaryPath(path.join(root, '.instance-token'), 'file'), 'utf8').trim()
  if (!token) throw new Error('Actual isolated instance token required')
  const directory = assertOrdinaryPath(path.join(root, 'proofs', proofName))
  if (fs.existsSync(directory)) throw new Error('Proof already exists; preserve previous failure and choose a new attempt name')
  fs.mkdirSync(directory, { recursive: true })
  const manifest = await buildKnowledgeFixtures(path.join(directory, 'fixtures'), { python })
  const checkerSource = fs.readFileSync(path.join(engineRoot, 'scripts/longrun/knowledge-live-checker.test.mjs'))
  fs.writeFileSync(path.join(directory, 'assertions.test.mjs'), checkerSource, { flag: 'wx' })
  const httpFile = path.join(directory, 'http.jsonl')
  fs.writeFileSync(httpFile, '', { flag: 'wx' })
  const requests = [], errors = [], redact = value => String(value).split(token).join('[REDACTED]')
  const request = async (method, route, body, multipartFixture) => {
    const requestId = randomUUID(), startedAt = now()
    let response, httpStatus = null
    const headers = { 'x-aether-instance-token': token }
    let payload
    if (multipartFixture) {
      payload = new FormData()
      payload.append('file', new Blob([fs.readFileSync(path.join(directory, 'fixtures', multipartFixture.file))], { type: multipartFixture.mime }), multipartFixture.file)
    } else if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body) }
    try {
      const result = await fetch(base + route, { method, headers, body: payload, signal: AbortSignal.timeout(multipartFixture ? 240000 : 30000) })
      httpStatus = result.status
      const bytes = await result.text()
      try { response = JSON.parse(bytes) } catch { response = { unparsedBody: redact(bytes) } }
    } catch (error) { response = { transportError: redact(error.message) }; errors.push({ requestId, method, route, error: redact(error.message) }) }
    const evidence = { requestId, base, method, route, buildId, startedAt, finishedAt: now(), httpStatus, request: multipartFixture ? { multipart: { filename: multipartFixture.file, mime: multipartFixture.mime, sha256: multipartFixture.sha256, byteLength: multipartFixture.byteLength } } : body ?? null, response }
    fs.appendFileSync(httpFile, JSON.stringify(evidence) + '\n')
    requests.push(evidence)
    return { id: requestId, response, data: response?.code === 200 ? response.data : null }
  }
  const context = { schema: 'knowledge-live-api-1', independent: false, buildId, base, frozenAt: freeze.at, startedAt: now(), finishedAt: null, completed: false, bases: {}, names: {}, operations: {}, documents: [], errors }
  const saveFailure = error => { errors.push({ at: now(), error: redact(error.message) }); context.finishedAt = now(); context.httpSha256 = hash(fs.readFileSync(httpFile)); writeNew(path.join(directory, 'exercise.json'), context) }
  try {
    const suffix = randomUUID().slice(0, 8)
    context.names = { primary: 'format-live-' + suffix, other: 'format-isolation-' + suffix, updatedDescription: 'Updated knowledge-base description ' + suffix, cascadeText: 'CASCADE MOVED DOCUMENT SENTINEL ' + suffix }
    context.operations.formats = (await request('GET', '/api/v1/knowledge/formats')).id
    const primary = await request('POST', '/api/v1/knowledge/bases', { name: context.names.primary, description: 'Owned genuine format API acceptance' })
    context.operations.createPrimary = primary.id
    if (!primary.data?.id) throw new Error('Actual primary knowledge base could not be created')
    context.bases.primary = primary.data.id
    const other = await request('POST', '/api/v1/knowledge/bases', { name: context.names.other, description: 'Owned isolation acceptance' })
    context.operations.createOther = other.id
    if (!other.data?.id) throw new Error('Actual isolation knowledge base could not be created')
    context.bases.other = other.data.id
    const primaryRoute = '/api/v1/knowledge/bases/' + context.bases.primary, otherRoute = '/api/v1/knowledge/bases/' + context.bases.other
    context.operations.readPrimary = (await request('GET', primaryRoute)).id
    context.operations.updatePrimary = (await request('PUT', primaryRoute, { description: context.names.updatedDescription })).id
    context.operations.readUpdatedPrimary = (await request('GET', primaryRoute)).id
    context.operations.listBases = (await request('GET', '/api/v1/knowledge/bases')).id
    const search = async (query, knowledgeBaseIds) => request('POST', '/api/v1/knowledge/search', { query, limit: 100, knowledgeBaseIds })
    for (const fixture of manifest.fixtures) {
      const operations = {}, evidence = { file: fixture.file, extension: fixture.extension, scenario: fixture.scenario, operations }
      context.documents.push(evidence)
      const uploaded = await request('POST', '/api/v1/knowledge/documents?knowledgeBaseId=' + encodeURIComponent(context.bases.primary), undefined, fixture)
      operations.upload = uploaded.id
      if (!uploaded.data?.id) { errors.push({ file: fixture.file, requestId: uploaded.id, error: 'Multipart extraction/upload did not return a successful document', code: uploaded.response?.code, message: uploaded.response?.message }); continue }
      const id = uploaded.data.id, route = '/api/v1/knowledge/documents/' + id
      evidence.documentId = id
      operations.read = (await request('GET', route)).id
      operations.search = (await search(fixture.searchTerm, [id])).id
      operations.otherBaseSearch = (await search(fixture.searchTerm, [context.bases.other])).id
      evidence.updatedText = 'UPDATEDUNIQUE' + randomUUID().replaceAll('-', '').toUpperCase() + ' DOCUMENT EDITED CONTENT'
      evidence.updatedFilename = 'edited-' + fixture.file
      operations.update = (await request('PUT', route, { filename: evidence.updatedFilename, content: evidence.updatedText })).id
      operations.readUpdated = (await request('GET', route)).id
      operations.staleSearch = (await search(fixture.searchTerm, [id])).id
      operations.updatedSearch = (await search(evidence.updatedText.split(' ')[0], [id])).id
      operations.delete = (await request('DELETE', route)).id
      operations.deletedRead = (await request('GET', route)).id
      operations.deletedSearch = (await search(evidence.updatedText.split(' ')[0], [context.bases.primary])).id
      operations.deletedList = (await request('GET', '/api/v1/knowledge/documents?knowledgeBaseId=' + encodeURIComponent(context.bases.primary))).id
    }
    const cascade = await request('POST', '/api/v1/knowledge/documents', { filename: 'cascade-sentinel.txt', content: context.names.cascadeText, knowledgeBaseId: context.bases.primary })
    context.operations.createCascade = cascade.id
    if (cascade.data?.id) {
      const route = '/api/v1/knowledge/documents/' + cascade.data.id
      context.operations.moveCascade = (await request('PUT', route, { knowledgeBaseId: context.bases.other })).id
      context.operations.cascadeOldScope = (await search('CASCADE', [context.bases.primary])).id
      context.operations.cascadeNewScope = (await search('CASCADE', [context.bases.other])).id
      context.operations.deleteOther = (await request('DELETE', otherRoute)).id
      context.operations.cascadeDeletedRead = (await request('GET', route)).id
      context.operations.cascadeDeletedSearch = (await search('CASCADE', [context.bases.other])).id
      context.operations.cascadeFinalDocuments = (await request('GET', '/api/v1/knowledge/documents?knowledgeBaseId=' + encodeURIComponent(context.bases.other))).id
    } else context.operations.deleteOther = (await request('DELETE', otherRoute)).id
    context.operations.deletedOtherRead = (await request('GET', otherRoute)).id
    context.operations.deletePrimary = (await request('DELETE', primaryRoute)).id
    context.operations.deletedPrimaryRead = (await request('GET', primaryRoute)).id
    context.operations.finalBaseList = (await request('GET', '/api/v1/knowledge/bases')).id
    context.completed = true
    context.finishedAt = now()
    context.httpSha256 = hash(fs.readFileSync(httpFile))
    writeNew(path.join(directory, 'exercise.json'), context)
  } catch (error) { saveFailure(error) }
  const runChecker = scope => new Promise((resolve, reject) => {
    const startedAt = now(), args = ['--test', '--test-reporter=tap', path.join(directory, 'assertions.test.mjs')]
    const child = spawn(process.execPath, args, { cwd: engineRoot, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, AETHER_KNOWLEDGE_PROOF_DIR: directory, AETHER_KNOWLEDGE_CHECK_SCOPE: scope } })
    let stdout = '', stderr = ''
    child.stdout.on('data', data => { stdout += data })
    child.stderr.on('data', data => { stderr += data })
    child.once('error', reject)
    child.once('close', (exitCode, signal) => {
      const report = { independent: true, buildId, scope, executable: process.execPath, args, cwd: engineRoot, expectedTests: scope === 'scan' ? 1 : 46, startedAt, finishedAt: now(), stdout, stderr, exitCode, signal, timedOut: false }
      const file = path.join(directory, scope + '-report.json')
      writeNew(file, report)
      resolve({ report, file })
    })
  })
  const advertised = await runChecker('advertised'), scan = await runChecker('scan')
  const relative = file => path.relative(root, file).split(path.sep).join('/')
  const inputFiles = [httpFile, path.join(directory, 'exercise.json'), ...fs.readdirSync(path.join(directory, 'fixtures')).map(file => path.join(directory, 'fixtures', file))].map(file => ({ file: relative(file), sha256: hash(fs.readFileSync(file)) }))
  const bindings = ids => requests.filter(row => ids.includes(row.requestId)).map(row => ({ requestId: row.requestId, method: row.method, route: row.route }))
  const proof = { checker: 'node-test', buildId, file: relative(advertised.file), sha256: hash(fs.readFileSync(advertised.file)), sourceFile: relative(path.join(directory, 'assertions.test.mjs')), sourceSha256: hash(checkerSource), inputFiles, expectedTests: 46, httpEvidenceFile: relative(httpFile) }
  const features = [
    { feature: 'knowledge.crud', mode: 'live-api-semantic', httpBindings: bindings(Object.values(context.operations)), proof },
    { feature: 'knowledge.format-extraction', mode: 'live-api-semantic', httpBindings: bindings(context.documents.filter(item => item.scenario === 'advertised').flatMap(item => Object.values(item.operations))), proof },
    ...context.documents.filter(item => item.scenario === 'advertised').map(item => ({ feature: 'knowledge.format:' + item.extension, mode: 'live-api-semantic', httpBindings: bindings(Object.values(item.operations)), proof })),
  ]
  const result = { schema: 'knowledge-live-feature-evidence-1', buildId, base, directory, advertisedPassed: advertised.report.exitCode === 0, scanPdfPassed: scan.report.exitCode === 0, fullClaimPassed: advertised.report.exitCode === 0 && scan.report.exitCode === 0, requests: requests.length, errors, features }
  writeNew(path.join(directory, 'feature-evidence.json'), result)
  return result
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const [root, ...argv] = process.argv.slice(2), options = {}
  for (let i = 0; i < argv.length; i += 2) { if (!['--python', '--proof-name'].includes(argv[i]) || argv[i + 1] === undefined) throw new Error('Unknown/incomplete argument: ' + argv[i]); options[argv[i] === '--python' ? 'python' : 'proofName'] = argv[i + 1] }
  const result = await exerciseKnowledge(root, options)
  console.log(JSON.stringify({ directory: result.directory, advertisedPassed: result.advertisedPassed, scanPdfPassed: result.scanPdfPassed, fullClaimPassed: result.fullClaimPassed, requests: result.requests, errors: result.errors }, null, 2))
  process.exitCode = result.fullClaimPassed ? 0 : 2
}
