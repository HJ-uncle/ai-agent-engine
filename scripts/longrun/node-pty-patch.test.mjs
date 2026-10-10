import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { applyNodePtyPatch, receiptName } from '../apply-node-pty-patch.mjs'

const require = createRequire(import.meta.url)
const root = path.resolve(path.dirname(import.meta.filename), '../..')
const assets = path.join(root, 'scripts/patches/node-pty-1.1.0')
const manifest = JSON.parse(fs.readFileSync(path.join(assets, 'manifest.json')))
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
function fixture() {
  const directory = fs.mkdtempSync(path.join(root, '.tmp/node-pty-guard-test-'))
  fs.copyFileSync(path.join(root, 'node_modules/node-pty/package.json'), path.join(directory, 'package.json'))
  for (const file of manifest.files) {
    // Installed dependencies already carry the patch. Exercise application
    // from verified original bytes instead of depending on checkout state.
    const source=path.join(root,'scripts/longrun/fixtures/node-pty-1.1.0-original',file.path)
    assert.equal(createHash('sha256').update(fs.readFileSync(source)).digest('hex'),file.beforeSha256)
    fs.mkdirSync(path.dirname(path.join(directory, file.path)), { recursive: true })
    fs.copyFileSync(source, path.join(directory, file.path))
  }
  return directory
}
const contents = directory => Object.fromEntries(manifest.files.map(file => [file.path, fs.readFileSync(path.join(directory, file.path), 'utf8')]))
function loadAgent({ fork, processKill = () => {}, accelerated = false } = {}) {
  const errors = []
  const context = { exports: {}, __dirname: assets, process: { pid: 991, kill: processKill },
    console: { error: (...args) => errors.push(args) }, clearTimeout,
    setTimeout: (callback, ms) => setTimeout(callback, accelerated ? Math.min(ms, 30) : ms),
    require: name => name === 'child_process' ? { fork } : name === './windowsConoutConnection' ? {} : name === './utils' ? {} : require(name) }
  vm.runInNewContext(fs.readFileSync(path.join(assets, 'windowsPtyAgent.js'), 'utf8'), context)
  const agent = Object.create(context.exports.WindowsPtyAgent.prototype)
  const calls = []
  Object.assign(agent, { _innerPid: 321, _pty: 1, _useConpty: true, _useConptyDll: false,
    _inSocket: {}, _outSocket: {}, _ptyNative: { kill: () => calls.push('native') },
    _conoutSocketWorker: { dispose: async () => calls.push('worker') } })
  return { agent, calls, errors }
}
function helper() {
  const child = new EventEmitter()
  child.pid = 654; child.connected = true
  child.disconnect = () => { child.connected = false }
  child.unref = () => { child.unreferenced = true }
  child.kill = () => { child.killed = true; queueMicrotask(() => child.emit('exit', null, 'SIGTERM')); return true }
  return child
}

test('guard applies exact assets, is idempotent, and check is immutable', () => {
  const directory = fixture()
  assert.equal(applyNodePtyPatch({ packageDir: directory, lockfile: path.join(root, 'package-lock.json') }).changed, true)
  const before = contents(directory)
  const mtimes = manifest.files.map(file => fs.statSync(path.join(directory, file.path)).mtimeMs)
  assert.equal(applyNodePtyPatch({ packageDir: directory }).changed, false)
  assert.equal(applyNodePtyPatch({ packageDir: directory, check: true }).checked, true)
  assert.deepEqual(contents(directory), before)
  assert.deepEqual(manifest.files.map(file => fs.statSync(path.join(directory, file.path)).mtimeMs), mtimes)
})
test('unknown content is rejected before any writes', () => {
  const directory = fixture()
  fs.appendFileSync(path.join(directory, manifest.files.at(-1).path), '\n// unknown')
  const before = contents(directory)
  assert.throws(() => applyNodePtyPatch({ packageDir: directory }), /unknown installed hash/)
  assert.deepEqual(contents(directory), before)
  assert.equal(fs.existsSync(path.join(directory, receiptName)), false)
})
test('known interrupted mixture resumes, but missing receipt fails check', () => {
  const directory = fixture()
  fs.copyFileSync(path.join(assets, manifest.files[0].asset), path.join(directory, manifest.files[0].path))
  assert.throws(() => applyNodePtyPatch({ packageDir: directory, check: true }), /not applied/)
  applyNodePtyPatch({ packageDir: directory })
  fs.unlinkSync(path.join(directory, receiptName))
  assert.throws(() => applyNodePtyPatch({ packageDir: directory, check: true }), /receipt is missing/)
})
test('unsupported package, lock version, or receipt cannot be overwritten', () => {
  const directory = fixture()
  const before = contents(directory)
  const lockfile = path.join(directory, 'bad-lock.json')
  fs.writeFileSync(lockfile, JSON.stringify({ packages: { 'node_modules/node-pty': { version: '2.0.0' } } }))
  assert.throws(() => applyNodePtyPatch({ packageDir: directory, lockfile }), /lockfile/)
  assert.deepEqual(contents(directory), before)
  fs.writeFileSync(path.join(directory, receiptName), '{}')
  assert.throws(() => applyNodePtyPatch({ packageDir: directory }), /receipt differs/)
  fs.appendFileSync(path.join(directory, 'package.json'), ' ')
  assert.throws(() => applyNodePtyPatch({ packageDir: directory }), /unsupported package/)
})
test('linked target is rejected', () => {
  const directory = fixture()
  const linked = `${directory}-link`
  fs.symlinkSync(directory, linked, process.platform === 'win32' ? 'junction' : 'dir')
  assert.throws(() => applyNodePtyPatch({ packageDir: linked }), /linked path/)
})
test('native close occurs after helper message and exit, and duplicate kill shares promise', async () => {
  const child = helper()
  const killed = []
  let queries = 0
  const { agent, calls } = loadAgent({ fork: () => { queries++; return child }, processKill: pid => killed.push(pid) })
  const first = agent.kill()
  assert.equal(agent.kill(), first)
  await pause(5)
  assert.deepEqual(calls, [])
  child.emit('message', { shellPid: 321, consoleProcessList: [321, 876, 876] })
  assert.deepEqual(calls, [])
  child.emit('exit', 0, null)
  const result = await first
  assert.equal(result.cleanupError, undefined)
  assert.deepEqual(killed, [321, 876])
  assert.deepEqual(calls, ['native', 'worker'])
  assert.equal(queries, 1)
  assert.equal(child.listenerCount('message') + child.listenerCount('error') + child.listenerCount('exit'), 0)
  assert.equal(child.connected, false)
})
for (const mode of ['ipc-error', 'exit-no-message', 'deadline', 'invalid-message', 'native-query-error']) {
  test(`helper ${mode} reports failure and still closes native and worker`, async () => {
    const child = helper()
    const { agent, calls, errors } = loadAgent({ fork: () => child, accelerated: true })
    const pending = agent.kill()
    await pause(2)
    if (mode === 'ipc-error') child.emit('error', new Error('spawn denied'))
    if (mode === 'exit-no-message') child.emit('exit', 17, null)
    if (mode === 'invalid-message') child.emit('message', { shellPid: 999, consoleProcessList: [321] })
    if (mode === 'native-query-error') {
      child.emit('message', { shellPid: 321, error: { name: 'Error', message: 'AttachConsole failed', stack: 'original helper stack' } })
      child.emit('exit', 0, null)
    }
    const result = await pending
    assert.equal(result.cleanupError.code, 'PTY_CLEANUP_FAILED')
    assert.equal(result.cleanupError.errors[0].phase, 'console-query')
    assert.equal(errors.length, 1)
    assert.deepEqual(calls, ['native', 'worker'])
    assert.equal(child.connected, false)
    assert.equal(child.listenerCount('message') + child.listenerCount('error') + child.listenerCount('exit'), 0)
  })
}
test('native close and worker failures remain visible independently', async () => {
  const { agent, errors } = loadAgent()
  agent._exitCode = 7
  agent._ptyNative.kill = () => { throw new Error('native shutdown broke') }
  agent._conoutSocketWorker.dispose = async () => { throw new Error('worker termination broke') }
  const result = await agent.kill()
  assert.deepEqual(Array.from(result.cleanupError.errors, error => error.phase), ['native-close', 'worker-dispose'])
  assert.equal(errors.length, 2)
})
test('already observed natural shell exit does not create a helper', async () => {
  const { agent, calls } = loadAgent({ fork: () => assert.fail('unexpected helper') })
  agent._exitCode = 7
  const result = await agent.kill()
  assert.equal(result.cleanupError, undefined)
  assert.deepEqual(calls, ['native', 'worker'])
})
test('expected AttachConsole error only normalizes if shell nonexistence is confirmed', async () => {
  const child = helper()
  const { agent, errors } = loadAgent({ fork: () => child, processKill: () => { const error = new Error('gone'); error.code = 'ESRCH'; throw error } })
  const pending = agent.kill(); await pause(2)
  child.emit('message', { shellPid: 321, error: { name: 'Error', message: 'AttachConsole failed' } }); child.emit('exit', 0, null)
  assert.equal((await pending).cleanupError, undefined)
  assert.equal(errors.length, 0)
})
test('worker disposal waits for actual worker termination and merges repeats', async () => {
  let complete
  let count = 0
  const context = { exports: {}, require: name => name === './shared/conout' ? {} : name === './eventEmitter2' ? {} : require(name),
    setTimeout: callback => setTimeout(callback, 5), clearTimeout }
  vm.runInNewContext(fs.readFileSync(path.join(assets, 'windowsConoutConnection.js'), 'utf8'), context)
  const connection = Object.create(context.exports.ConoutConnection.prototype)
  connection._worker = { terminate: () => { count++; return new Promise(resolve => { complete = resolve }) } }
  const first = connection.dispose()
  assert.equal(connection.dispose(), first)
  let done = false; first.then(() => { done = true })
  await pause(10); assert.equal(done, false); assert.equal(count, 1)
  complete(0); await first; assert.equal(done, true)
})
test('public onExit waits for cleanup and conveys cleanupError', async () => {
  let finishCleanup
  const socket = new EventEmitter()
  const error = { code: 'PTY_CLEANUP_FAILED', message: 'close error', errors: [{ phase: 'worker-dispose', code: 'X', name: 'Error', message: 'original' }] }
  class Agent {
    constructor() { this.outSocket = socket; this.innerPid = 321; this.exitCode = 7 }
    aetherCompleteClose() { return new Promise(resolve => { finishCleanup = resolve }) }
    kill() { return this.aetherCompleteClose() }
  }
  const context = { exports: {}, require: name => name === './windowsPtyAgent' ? { WindowsPtyAgent: Agent } : name.startsWith('./') ? require(path.join(root, 'node_modules/node-pty/lib', name)) : require(name), console }
  vm.runInNewContext(fs.readFileSync(path.join(assets, 'windowsTerminal.js'), 'utf8'), context)
  const terminal = new context.exports.WindowsTerminal('node', [], { env: {}, cwd: root })
  let exit
  terminal.onExit(event => { exit = event })
  socket.emit('ready_datapipe'); socket.emit('close')
  await pause(2); assert.equal(exit, undefined)
  finishCleanup({ cleanupError: error }); await pause(2)
  assert.equal(exit.exitCode, 7); assert.equal(exit.cleanupError, error)
})
test('public onCleanup reports async shutdown error when no onExit arrives', async () => {
  let finishCleanup
  const socket = new EventEmitter()
  const error = { code: 'PTY_CLEANUP_FAILED', message: 'native close failed', errors: [{ phase: 'native-close', code: 'X', name: 'Error', message: 'original native cause' }] }
  class Agent {
    constructor() { this.outSocket = socket; this.innerPid = 321 }
    kill() { return new Promise(resolve => { finishCleanup = resolve }) }
  }
  const context = { exports: {}, require: name => name === './windowsPtyAgent' ? { WindowsPtyAgent: Agent } : name.startsWith('./') ? require(path.join(root, 'node_modules/node-pty/lib', name)) : require(name), console }
  vm.runInNewContext(fs.readFileSync(path.join(assets, 'windowsTerminal.js'), 'utf8'), context)
  const terminal = new context.exports.WindowsTerminal('node', [], { env: {}, cwd: root })
  let exit; const cleanups = []
  terminal.onExit(event => { exit = event })
  terminal.onCleanup(event => { cleanups.push(event) })
  socket.emit('ready_datapipe'); socket.emit('data', '')
  terminal.kill(); finishCleanup({ cleanupError: error }); await pause(2)
  assert.equal(exit, undefined)
  assert.equal(cleanups.length, 1)
  assert.equal(cleanups[0].cleanupError, error)
})
