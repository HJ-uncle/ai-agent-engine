/** Real diagnostic children: cancellation must stop effects before releasing its caller. */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runDiagnosticProcess } from '../adapters/process.js'

let fixture: string
const controllers: AbortController[] = []
const processes: Array<Promise<unknown>> = []
const pids = new Set<number>()
const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

function controller() {
  const value = new AbortController()
  controllers.push(value)
  return value
}

function launch(script: string, options: { signal?: AbortSignal; timeoutMs?: number; maxOutputBytes?: number } = {}) {
  const result = runDiagnosticProcess(process.execPath, ['-e', script], { cwd: fixture, timeoutMs: 8_000, ...options })
    .then(value => ({ value, error: undefined }), error => ({ value: undefined, error: error as Error }))
  processes.push(result)
  return result
}

async function pidFrom(name: string) {
  const file = path.join(fixture, name)
  await expect.poll(() => fs.existsSync(file) ? Number(fs.readFileSync(file, 'utf8')) || 0 : 0,
    { timeout: 5_000 }).toBeGreaterThan(0)
  const pid = Number(fs.readFileSync(file, 'utf8'))
  pids.add(pid)
  return pid
}

async function markerIsGrowing() {
  const marker = path.join(fixture, 'marker')
  await expect.poll(() => fs.existsSync(marker), { timeout: 5_000 }).toBe(true)
  const size = fs.statSync(marker).size
  await expect.poll(() => fs.statSync(marker).size, { timeout: 5_000 }).toBeGreaterThan(size)
}

async function markerHasStopped() {
  const marker = path.join(fixture, 'marker')
  const before = fs.readFileSync(marker, 'utf8')
  await pause(160)
  expect(fs.readFileSync(marker, 'utf8')).toBe(before)
}

beforeEach(() => { fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'aether-d8-diagnostics-')) })
afterEach(async () => {
  for (const value of controllers.splice(0)) value.abort()
  // Emergency cleanup is limited to PIDs recorded by this fixture's own children.
  for (const name of ['leader.pid', 'child.pid', 'grandchild.pid']) {
    const file = path.join(fixture, name)
    if (fs.existsSync(file)) { const pid = Number(fs.readFileSync(file, 'utf8')); if (Number.isSafeInteger(pid) && pid > 0) pids.add(pid) }
  }
  for (const pid of pids) {
    if (!alive(pid)) continue
    if (process.platform === 'win32') spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 3_000 })
    else { try { process.kill(pid, 'SIGKILL') } catch { /* already exited */ } }
  }
  pids.clear()
  await Promise.allSettled(processes.splice(0))
  const resolved = path.resolve(fixture)
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('aether-d8-diagnostics-')) throw new Error('Unsafe diagnostic fixture cleanup')
  fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
})

describe('D8 diagnostic subprocess lifecycle', () => {
  it.each(['cancel', 'timeout'] as const)('settles %s after stopping the real child and grandchild and their file effects', async operation => {
    const grandchild = `
      const fs = require('node:fs');
      fs.writeFileSync('grandchild.pid', String(process.pid));
      fs.appendFileSync('marker', 'started\\n');
      setInterval(() => fs.appendFileSync('marker', 'tick\\n'), 20);
    `
    const child = `
      require('node:fs').writeFileSync('child.pid', String(process.pid));
      require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { stdio: 'inherit', windowsHide: true });
      setInterval(() => {}, 1000);
    `
    const abort = controller()
    const running = launch(`
      require('node:fs').writeFileSync('leader.pid', String(process.pid));
      require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(child)}], { stdio: 'inherit', windowsHide: true });
      setInterval(() => {}, 1000);
    `, { signal: abort.signal, timeoutMs: operation === 'timeout' ? 2_500 : 10_000 })
    const leaderPid = await pidFrom('leader.pid')
    const childPid = await pidFrom('child.pid')
    const grandchildPid = await pidFrom('grandchild.pid')
    await markerIsGrowing()
    expect([leaderPid, childPid, grandchildPid].every(alive)).toBe(true)
    if (operation === 'cancel') abort.abort()
    const result = await running
    expect(result.value).toBeUndefined()
    if (operation === 'cancel') expect(result.error?.name).toBe('AbortError')
    else expect(result.error?.message).toMatch(/超时|timed?\s*out|timeout/i)
    expect([leaderPid, childPid, grandchildPid].some(alive)).toBe(false)
    await markerHasStopped()
  }, 15_000)

  it('cancels a descendant retaining output pipes after its leader has already exited', async () => {
    const descendant = `
      const fs = require('node:fs');
      fs.writeFileSync('child.pid', String(process.pid));
      fs.appendFileSync('marker', 'started\\n');
      setInterval(() => fs.appendFileSync('marker', 'tick\\n'), 20);
    `
    const abort = controller()
    const running = launch(`
      const fs = require('node:fs');
      fs.writeFileSync('leader.pid', String(process.pid));
      require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], {
        stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true, detached: process.platform === 'win32',
      });
      const ready = setInterval(() => {
        if (fs.existsSync('marker')) { clearInterval(ready); process.exit(0); }
      }, 10);
    `, { signal: abort.signal, timeoutMs: 10_000 })
    const leaderPid = await pidFrom('leader.pid')
    const childPid = await pidFrom('child.pid')
    await expect.poll(() => alive(leaderPid), { timeout: 5_000 }).toBe(false)
    expect(alive(childPid)).toBe(true)
    await markerIsGrowing()
    abort.abort()
    const result = await running
    expect(result.error?.name).toBe('AbortError')
    expect(result.value).toBeUndefined()
    expect(alive(childPid)).toBe(false)
    await markerHasStopped()
  }, 15_000)

  it('decodes multibyte stdout and stderr correctly when the child writes one byte at a time', async () => {
    const result = await launch(`
      const stdout = Buffer.from('中🙂文');
      const stderr = Buffer.from('错🧪误');
      let index = 0;
      const next = () => {
        if (index === stdout.length) return;
        process.stdout.write(stdout.subarray(index, index + 1));
        process.stderr.write(stderr.subarray(index, index + 1));
        index++; setTimeout(next, 15);
      };
      next();
    `)
    expect(result.error).toBeUndefined()
    expect(result.value).toEqual({ stdout: '中🙂文', stderr: '错🧪误', exitCode: 0 })
  })

  it('rejects combined output overflow and stops the process instead of accepting partial diagnostics', async () => {
    const result = launch(`
      const fs = require('node:fs');
      fs.writeFileSync('leader.pid', String(process.pid));
      fs.appendFileSync('marker', 'started\\n');
      setInterval(() => fs.appendFileSync('marker', 'tick\\n'), 20);
      setTimeout(() => { process.stdout.write('o'.repeat(80)); process.stderr.write('e'.repeat(80)); }, 250);
    `, { maxOutputBytes: 128 })
    const pid = await pidFrom('leader.pid')
    await markerIsGrowing()
    const settled = await result
    expect(settled.value).toBeUndefined()
    expect(settled.error?.message).toMatch(/输出|output|limit/i)
    expect(alive(pid)).toBe(false)
    await markerHasStopped()
  }, 15_000)

  it('rejects an already cancelled request before any executable is launched', async () => {
    const abort = controller()
    abort.abort()
    const result = await Promise.resolve().then(() => runDiagnosticProcess(process.execPath,
      ['-e', "require('node:fs').writeFileSync('must-not-start', 'spawned')"], { cwd: fixture, signal: abort.signal }))
      .then(value => ({ value, error: undefined }), error => ({ value: undefined, error: error as Error }))
    expect(result.error?.name).toBe('AbortError')
    expect(result.value).toBeUndefined()
    expect(fs.existsSync(path.join(fixture, 'must-not-start'))).toBe(false)
  })
})
