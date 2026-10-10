import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CronScheduler } from '../cron-scheduler.js'

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

describe('Cron scheduler lifecycle', () => {
  it('clears the alignment timeout when stopped before the first tick', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-09T00:00:30Z'))
    const scheduler = new CronScheduler()
    const check = vi.spyOn(scheduler, 'checkAndRun').mockResolvedValue()
    scheduler.start()
    expect(vi.getTimerCount()).toBe(1)
    scheduler.stop()
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(120000)
    expect(check).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('can start, stop, and start again without retaining the prior tick generation', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-09T00:00:30Z'))
    const scheduler = new CronScheduler()
    const check = vi.spyOn(scheduler, 'checkAndRun').mockResolvedValue()
    scheduler.start()
    scheduler.stop()
    scheduler.start()
    scheduler.start()
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(30000)
    expect(check).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(60000)
    expect(check).toHaveBeenCalledTimes(2)
    scheduler.stop()
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(120000)
    expect(check).toHaveBeenCalledTimes(2)
  })

  it('lets a real Node process exit naturally after start-stop-start-stop before its first tick', async () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'aether-cron-close-'))
    const moduleUrl = pathToFileURL(path.resolve('src/scheduler/cron-scheduler.ts')).href
    const script = path.join(fixture, 'stop-cron.mjs')
    fs.writeFileSync(script, `
      import assert from 'node:assert/strict';
      const {CronScheduler}=await import(${JSON.stringify(moduleUrl)});
      const timers=()=>process.getActiveResourcesInfo().filter(resource=>resource==='Timeout').length;
      const baseline=timers(); const scheduler=new CronScheduler();
      scheduler.start(); assert.equal(timers(),baseline+1);
      scheduler.stop(); assert.equal(timers(),baseline);
      scheduler.start(); assert.equal(timers(),baseline+1);
      scheduler.stop(); assert.equal(timers(),baseline);
      console.log('cron-stopped-with-no-timer');
    `)
    const env: NodeJS.ProcessEnv = { ...process.env, DATA_DIR: path.join(fixture, 'agent.db'), LOG_LEVEL: 'silent' }
    delete env.NODE_OPTIONS
    const child = spawn(process.execPath, ['--import', 'tsx', script], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''; let stderr = ''; let timer: NodeJS.Timeout | undefined
    child.stdout.on('data', chunk => { stdout += chunk.toString() })
    child.stderr.on('data', chunk => { stderr += chunk.toString() })
    try {
      const exitCode = await Promise.race([
        new Promise<number | null>((resolve, reject) => { child.once('exit', resolve); child.once('error', reject) }),
        new Promise<never>((_, reject) => { timer = setTimeout(() => { child.kill(); reject(new Error('Stopped Cron scheduler retained its process')) }, 6000) }),
      ])
      expect(exitCode, stderr).toBe(0)
      expect(stdout).toContain('cron-stopped-with-no-timer')
    } finally {
      clearTimeout(timer)
      if (child.exitCode === null && child.signalCode === null) child.kill()
      if (path.dirname(fixture) !== path.resolve(os.tmpdir()) || !path.basename(fixture).startsWith('aether-cron-close-')) throw new Error('Unsafe fixture cleanup')
      fs.rmSync(fixture, { recursive: true, force: true })
    }
  }, 10000)
})
