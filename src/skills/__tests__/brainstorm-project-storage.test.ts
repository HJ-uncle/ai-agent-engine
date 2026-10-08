// Runs the real bundled companion script and verifies its HTTP service and disk layout.
import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it } from 'vitest'

const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url))
const script = path.join(repositoryRoot, '.aether/skills/os-brainstorming/scripts/start-server.sh')
const fixtureParent = path.join(repositoryRoot, '.e2e-tmp')
const candidates = process.platform === 'win32'
  ? [process.env.BRAINSTORM_TEST_BASH, path.join(process.env.ProgramFiles ?? 'C:/Program Files', 'Git/bin/bash.exe')]
  : [process.env.BRAINSTORM_TEST_BASH, 'bash']
const bash = candidates.find(candidate => candidate && spawnSync(candidate, ['--version'], { windowsHide: true }).status === 0)
let fixture: string | undefined
let child: ChildProcess | undefined
let nativePidFile: string | undefined

async function stopFixtureServer() {
  // Git Bash can reparent native Windows children, so killing its process tree alone is insufficient.
  // A test-only Node preload records the actual server PID without changing server behavior.
  if (nativePidFile && fs.existsSync(nativePidFile)) {
    const nativePid = Number(fs.readFileSync(nativePidFile, 'utf8'))
    nativePidFile = undefined
    if (!Number.isSafeInteger(nativePid) || nativePid <= 0 || nativePid === process.pid) throw new Error('Invalid fixture PID')
    try { process.kill(nativePid, 'SIGTERM') } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
    }
  }
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return
  const stopped = once(child, 'exit', { signal: AbortSignal.timeout(5_000) })
  if (process.platform === 'win32') {
    // Only our captured child tree is eligible; never search by executable name.
    const result = spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true })
    if (result.status !== 0) {
      try {
        process.kill(child.pid, 0)
        throw new Error('Could not stop companion fixture process: ' + result.stderr.toString())
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
      }
    }
  } else {
    process.kill(-child.pid, 'SIGTERM')
  }
  await stopped
}

afterEach(async () => {
  await stopFixtureServer()
  child = undefined
  if (!fixture) return
  const resolved = fs.realpathSync(fixture)
  if (path.dirname(resolved) !== fs.realpathSync(fixtureParent) ||
      !path.basename(resolved).startsWith('brainstorm-storage-') || fs.lstatSync(fixture).isSymbolicLink()) {
    throw new Error('Unsafe companion fixture cleanup path')
  }
  fs.rmSync(resolved, { recursive: true, force: true })
  fixture = undefined
})

it.skipIf(!bash)('starts the real Bash companion with content/state only under project .ae/brainstorm (requires Bash)', async () => {
  fs.mkdirSync(fixtureParent, { recursive: true })
  fixture = fs.mkdtempSync(path.join(fixtureParent, 'brainstorm-storage-'))
  const project = path.join(fixture, 'project with spaces')
  fs.mkdirSync(project)
  nativePidFile = path.join(fixture, 'native-server.pid')
  const preload = path.join(fixture, 'record-server-pid.cjs')
  fs.writeFileSync(preload, "require('node:fs').writeFileSync(process.env.BRAINSTORM_TEST_PID_FILE, String(process.pid))")
  // Git checkouts on Windows can have CRLF. Git Bash exposes igncr for those files.
  const args = [...(process.platform === 'win32' ? ['-o', 'igncr'] : []),
    script.replaceAll('\\', '/'), '--project-dir', project.replaceAll('\\', '/'), '--foreground']
  child = spawn(bash!, args, {
    cwd: repositoryRoot,
    env: { ...process.env, PATH: path.dirname(process.execPath) + path.delimiter + process.env.PATH,
      BRAINSTORM_TEST_PID_FILE: nativePidFile,
      NODE_OPTIONS: (process.env.NODE_OPTIONS ?? '') + ' --require "' + preload.replaceAll('\\', '/') + '"',
    },
    windowsHide: true,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  let processError: Error | undefined
  child.stdout!.on('data', data => { stdout += String(data) })
  child.stderr!.on('data', data => { stderr += String(data) })
  child.on('error', error => { processError = error })
  let info: { port: number; screen_dir: string; state_dir: string } | undefined
  await expect.poll(() => {
    if (processError) throw processError
    if (child!.exitCode !== null) throw new Error('Companion exited: ' + stderr + '\n' + stdout)
    const line = stdout.split(/\r?\n/).find(value => value.includes('"type":"server-started"'))
    if (line) info = JSON.parse(line)
    return Boolean(info)
  }, { timeout: 10_000 }).toBe(true)
  const sessionRoot = path.dirname(info!.screen_dir)
  expect(path.dirname(sessionRoot)).toBe(path.join(project, '.ae', 'brainstorm'))
  expect(info!.state_dir).toBe(path.join(sessionRoot, 'state'))
  expect(fs.readdirSync(project)).toEqual(['.ae'])
  await expect.poll(() => fs.existsSync(path.join(info!.state_dir, 'server-info'))).toBe(true)
  expect(fs.readFileSync(path.join(info!.state_dir, 'server.pid'), 'utf8').trim()).toMatch(/^\d+$/)
  expect(JSON.parse(fs.readFileSync(path.join(info!.state_dir, 'server-info'), 'utf8'))).toMatchObject(info!)

  const url = 'http://127.0.0.1:' + info!.port
  expect(await (await fetch(url, { signal: AbortSignal.timeout(3_000) })).text()).toContain('Brainstorm Companion')
  fs.writeFileSync(path.join(info!.screen_dir, 'index.html'), '<!doctype html><html><body>project-storage-screen</body></html>')
  fs.writeFileSync(path.join(info!.screen_dir, 'asset.json'), '{"servedFrom":".ae"}')
  const screen = await fetch(url, { signal: AbortSignal.timeout(3_000) })
  expect(screen.status).toBe(200)
  expect(await screen.text()).toContain('project-storage-screen')
  expect(await (await fetch(url + '/files/asset.json', { signal: AbortSignal.timeout(3_000) })).json()).toEqual({ servedFrom: '.ae' })
  await stopFixtureServer()
  await expect.poll(async () => {
    try { await fetch(url, { signal: AbortSignal.timeout(500) }); return true } catch { return false }
  }).toBe(false)
}, 20_000)
