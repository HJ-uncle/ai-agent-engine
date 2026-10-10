import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import test from 'node:test'
import assert from 'node:assert/strict'
import { assertDestination, parseArguments, prepareCandidate, productionDistPath, validateTemplateDependencies } from './prepare-isolated-client-candidate.mjs'

const buildId = 'sha256:' + 'a'.repeat(64)
const oldBuildId = 'sha256:' + 'b'.repeat(64)
const sha = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex')
function put(file, text) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text) }
function allFiles(root, prefix = '') {
  return fs.readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    const rel = prefix ? prefix + '/' + entry.name : entry.name, full = path.join(root, entry.name)
    return entry.isDirectory() ? allFiles(full, rel) : [{ path: rel, bytes: fs.statSync(full).size, sha256: sha(fs.readFileSync(full)) }]
  })
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'candidate-client-guard-'))
  t.after(() => {
    const resolved = fs.realpathSync(root)
    assert.equal(path.dirname(resolved).toLowerCase(), fs.realpathSync(os.tmpdir()).toLowerCase())
    assert.match(path.basename(resolved), /^candidate-client-guard-/)
    fs.rmSync(resolved, { recursive: true, force: true })
  })
  const engineRoot = path.join(root, 'engine'), clientRoot = path.join(root, 'client'), candidateDist = path.join(root, 'candidate-dist')
  const pkg = JSON.stringify({ name: 'aether-engine', version: '2.0.0', type: 'module', dependencies: {} })
  put(path.join(engineRoot, 'package.json'), pkg)
  put(path.join(engineRoot, 'package-lock.json'), '{}')
  put(path.join(engineRoot, 'node_modules/test-dependency/index.js'), 'read-only source dependency')
  put(path.join(clientRoot, 'node_modules/test-dependency/index.js'), 'read-only client dependency')
  for (const name of ['src', 'out', 'e2e', 'scripts', 'build']) put(path.join(clientRoot, name, 'fixture.txt'), name)
  put(path.join(clientRoot, 'scripts/verify-engine-runtime.mjs'), 'fixture verifier')
  put(path.join(clientRoot, 'package.json'), '{"name":"aether-code"}')
  put(path.join(clientRoot, 'resources/icon.png'), 'icon bytes')
  put(path.join(candidateDist, 'main.js'), 'candidate main')
  put(path.join(candidateDist, 'runtime/build-manifest.json'), JSON.stringify({ buildId, version: '2.0.0', protocolVersion: 1, subagentSchemaVersion: 1 }))
  put(path.join(candidateDist, 'runtime/build-identity.js'), `export function createBuildManifest() {return {buildId:${JSON.stringify(buildId)}}}`)
  put(path.join(candidateDist, 'storage/sqlite/local-process-runtime.js'), 'candidate sqlite')
  put(path.join(candidateDist, 'terminal/workspace-shell.mjs'), 'candidate shell')
  put(path.join(candidateDist, '__tests__/not-production.test.js'), 'must not stage')
  put(path.join(candidateDist, 'main.js.map'), 'must not stage')
  const stage = path.join(clientRoot, 'resources/engine/win32-x64')
  put(path.join(stage, 'package.json'), pkg)
  put(path.join(stage, 'dist/main.js'), 'live old main')
  put(path.join(stage, 'dist/stale.js'), 'live-only obsolete candidate asset')
  put(path.join(stage, 'runtime/node.exe'), 'fake native runtime')
  put(path.join(stage, 'node_modules/test-dependency/index.js'), 'bundled dependency')
  put(path.join(stage, 'verify-runtime.mjs'), 'old verifier')
  put(path.join(stage, 'stage-manifest.json'), JSON.stringify({ schemaVersion: 1, platform: 'win32-x64', buildId: oldBuildId, engineVersion: '2.0.0', lockSha256: sha(fs.readFileSync(path.join(engineRoot, 'package-lock.json'))), files: allFiles(stage) }))
  const options = { engineRoot, clientRoot, candidateDist, expectedBuildId: buildId, destination: path.join(engineRoot, '.tmp/client-candidate-fixture') }
  return { root, engineRoot, clientRoot, candidateDist, stage, options }
}

test('rejects destination escapes, reserved ownership, and linked .tmp before writes', t => {
  const f = fixture(t)
  for (const destination of [f.engineRoot, f.clientRoot, path.join(f.engineRoot, '.tmp/unowned'), path.join(f.engineRoot, '.tmp/client-candidate-one/nested')]) {
    assert.throws(() => assertDestination(f.engineRoot, destination), /direct child/)
  }
  fs.symlinkSync(f.clientRoot, path.join(f.engineRoot, '.tmp'), process.platform === 'win32' ? 'junction' : 'dir')
  assert.throws(() => assertDestination(f.engineRoot, f.options.destination), /ordinary contained/)
})

test('rejects mismatched manifest, source identity, and dependency template', async t => {
  const f = fixture(t)
  await assert.rejects(prepareCandidate({ ...f.options, expectedBuildId: oldBuildId }), /identity/)
  fs.writeFileSync(path.join(f.engineRoot, 'package-lock.json'), '{"changed":true}')
  await assert.rejects(prepareCandidate(f.options), /dependency lock/)
  assert.equal(fs.existsSync(f.options.destination), false)
  const other = fixture(t)
  fs.writeFileSync(path.join(other.candidateDist, 'runtime/build-identity.js'), `export function createBuildManifest() {return {buildId:${JSON.stringify(oldBuildId)}}}`)
  await assert.rejects(prepareCandidate(other.options), /current source build inputs/)
  assert.equal(fs.existsSync(other.options.destination), false)
})

test('prepares independent sibling artifacts and stage without changing live files; same inputs reuse safely', async t => {
  const f = fixture(t)
  const before = allFiles(f.stage)
  const result = await prepareCandidate(f.options)
  assert.deepEqual(allFiles(f.stage), before)
  assert.equal(fs.readFileSync(path.join(result.candidateEngineRoot, 'dist/main.js'), 'utf8'), 'candidate main')
  assert.equal(fs.readFileSync(path.join(result.runtimeStage, 'dist/main.js'), 'utf8'), 'candidate main')
  assert.equal(fs.existsSync(path.join(result.runtimeStage, 'dist/stale.js')), false)
  assert.equal(fs.existsSync(path.join(result.runtimeStage, 'dist/__tests__')), false)
  assert.equal(fs.existsSync(path.join(result.runtimeStage, 'dist/main.js.map')), false)
  assert.equal(fs.readFileSync(path.join(result.runtimeStage, 'verify-runtime.mjs'), 'utf8'), 'fixture verifier')
  assert.equal(JSON.parse(fs.readFileSync(path.join(result.runtimeStage, 'stage-manifest.json'))).buildId, buildId)
  assert.equal(fs.realpathSync(path.join(result.candidateClientRoot, 'node_modules')), fs.realpathSync(path.join(f.clientRoot, 'node_modules')))
  assert.equal((await prepareCandidate(f.options)).reused, true)
  fs.writeFileSync(path.join(result.runtimeStage, 'dist/main.js'), 'tampered')
  await assert.rejects(prepareCandidate(f.options), /inventory differs/)
  assert.deepEqual(allFiles(f.stage), before)
})

test('refuses unowned/incomplete destination without removing it', async t => {
  const f = fixture(t)
  fs.mkdirSync(f.options.destination, { recursive: true })
  put(path.join(f.options.destination, 'important.txt'), 'preserve')
  await assert.rejects(prepareCandidate(f.options), /incomplete or unowned/)
  assert.equal(fs.readFileSync(path.join(f.options.destination, 'important.txt'), 'utf8'), 'preserve')
})

test('refuses linked copy inputs and leaves original dependency bytes untouched', async t => {
  const f = fixture(t)
  fs.symlinkSync(path.join(f.clientRoot, 'node_modules'), path.join(f.clientRoot, 'src/escaped-dependencies'), process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(prepareCandidate(f.options), /symbolic link/)
  assert.equal(fs.readFileSync(path.join(f.clientRoot, 'node_modules/test-dependency/index.js'), 'utf8'), 'read-only client dependency')
})

test('argument parser requires values and refuses duplicates; production filter keeps shell assets', () => {
  assert.deepEqual(parseArguments(['--candidate-dist', 'x', '--expected-build-id', buildId]), { candidateDist: 'x', expectedBuildId: buildId })
  for (const args of [['--candidate-dist'], ['--bad', 'x'], ['--candidate-dist', 'x', '--candidate-dist', 'y']]) assert.throws(() => parseArguments(args), /argument/)
  assert.equal(productionDistPath('terminal/workspace-shell.mjs'), true)
  assert.equal(productionDistPath('__tests__/context.test.js'), false)
})

test('accepts exact lock-pinned dependency versions and the IDE language server, rejects ranges and injected extras', () => {
  const source = { dependencies: { fastify: '^5', typescript: '^5' } }
  const lock = { packages: { 'node_modules/fastify': { version: '5.12.5' }, 'node_modules/typescript': { version: '5.9.3' } } }
  const clientLock = { packages: { 'node_modules/typescript-language-server': { version: '6.0.1' } } }
  const staged = { dependencies: { fastify: '5.12.5', typescript: '5.9.3', 'typescript-language-server': '6.0.1' } }
  assert.doesNotThrow(() => validateTemplateDependencies(source, lock, staged, clientLock))
  assert.throws(() => validateTemplateDependencies(source, lock, { dependencies: { ...staged.dependencies, fastify: '^5' } }, clientLock), /locked runtime template/)
  assert.throws(() => validateTemplateDependencies(source, lock, { dependencies: { ...staged.dependencies, injected: '1.0.0' } }, clientLock), /unexpected or unlocked/)
  assert.throws(() => validateTemplateDependencies(source, lock, staged, { packages: {} }), /unexpected or unlocked/)
})
