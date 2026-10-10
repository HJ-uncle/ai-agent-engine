import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentContext } from '../../../core/agent-context/index.js'
import { setSecurityMode, clearSecurityMode } from '../../../security/policy-engine.js'
import { runSkillScriptTool } from '../run-skill-script.js'

const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash'
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
let root: string
let ctx: AgentContext
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'aether-skill-exec-'))
  vi.stubEnv('SKILLS_ROOT', root)
  vi.stubEnv('AETHER_GLOBAL_DIR', path.join(root, 'global'))
  vi.stubEnv('BASH_PATH', bash)
  ctx = { tenantId: 'skill-execution', sessionId: path.basename(root), projectRoot: root } as AgentContext
  setSecurityMode(ctx.tenantId, ctx.sessionId, 'standard')
})
afterEach(() => {
  clearSecurityMode(ctx.tenantId, ctx.sessionId)
  vi.unstubAllEnvs()
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 })
})
function command(source: string) {
  const script = path.join(root, 'fixture.cjs')
  fs.writeFileSync(script, source)
  return `"${process.execPath.replace(/\\/g, '/')}" "${script.replace(/\\/g, '/')}"`
}
async function waitFor(file: string) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8')) as { leader: number; child: number }
    await sleep(25)
  }
  throw new Error('fixture did not start')
}

describe.skipIf(!fs.existsSync(bash))('real skill script deadlines and owned cancellation', () => {
  it('accepts timeoutMs=0 and preserves full UTF-8 stdout/stderr', async () => {
    const result = await runSkillScriptTool.execute({ command: command(`console.log('中文开始'); setTimeout(()=>{console.error('完成✓')}, 250)`), timeoutMs: 0 }, ctx)
    expect(result).toMatchObject({ success: true, status: 'succeeded', metadata: { timeoutMs: 0, outputTruncated: false } })
    expect(result.output).toContain('中文开始')
    expect(result.output).toContain('完成✓')
    expect(fs.readFileSync(String(result.metadata?.outputArchivePath), 'utf8')).toContain('完成✓')
  }, 10_000)

  it('rejects invalid deadlines before starting any process', async () => {
    const marker = path.join(root, 'must-not-start')
    const script = command(`require('fs').writeFileSync(${JSON.stringify(marker)},'started')`)
    for (const timeoutMs of [-1, 0.5, NaN, Infinity, 2_147_483_648, '100']) {
      expect(await runSkillScriptTool.execute({ command: script, timeoutMs }, ctx)).toMatchObject({ success: false, status: 'failed' })
    }
    expect(fs.existsSync(marker)).toBe(false)
  })

  it('does not start an already cancelled invocation', async () => {
    const controller = new AbortController(); controller.abort()
    const marker = path.join(root, 'must-not-start')
    const result = await runSkillScriptTool.execute({ command: command(`require('fs').writeFileSync(${JSON.stringify(marker)},'started')`), timeoutMs: 0 }, { ...ctx, signal: controller.signal })
    expect(result.status).toBe('cancelled')
    expect(fs.existsSync(marker)).toBe(false)
    expect(fs.existsSync(path.join(root, '.ae', 'skill-runs'))).toBe(false)
  })

  it('cancels the owned shell and descendant, retains output, and leaves unrelated processes alive', async () => {
    const marker = path.join(root, 'started.json')
    const controller = new AbortController()
    const task = runSkillScriptTool.execute({ command: command(`const {spawn}=require('child_process'); const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'}); require('fs').writeFileSync(${JSON.stringify(marker)},JSON.stringify({leader:process.pid,child:child.pid})); console.log('checkpoint before cancel'); setInterval(()=>{},1000)`), timeoutMs: 0 }, { ...ctx, signal: controller.signal })
    const owned = await waitFor(marker)
    expect(alive(owned.child)).toBe(true)
    controller.abort(new Error('user stopped this skill'))
    const result = await task
    expect(result).toMatchObject({ success: false, status: 'cancelled', error: 'Cancelled' })
    expect(result.output).toContain('checkpoint before cancel')
    expect(alive(owned.leader)).toBe(false)
    expect(alive(owned.child)).toBe(false)
    expect(alive(process.pid)).toBe(true)
    expect(fs.readFileSync(String(result.metadata?.outputArchivePath), 'utf8')).toContain('checkpoint before cancel')
  }, 20_000)

  it('times out and reclaims descendants while preserving partial output', async () => {
    const marker = path.join(root, 'started.json')
    const task = runSkillScriptTool.execute({ command: command(`const child=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'}); require('fs').writeFileSync(${JSON.stringify(marker)},JSON.stringify({leader:process.pid,child:child.pid})); console.log('partial output before timeout'); setInterval(()=>{},1000)`), timeoutMs: 1_000 }, ctx)
    const owned = await waitFor(marker)
    const result = await task
    expect(result).toMatchObject({ success: false, status: 'failed', error: 'TimedOut', metadata: { timeoutMs: 1_000 } })
    expect(result.output).toContain('partial output before timeout')
    expect(result.output).toContain('timed out after 1000ms')
    expect(alive(owned.leader)).toBe(false)
    expect(alive(owned.child)).toBe(false)
  }, 20_000)

  it('drains more than 10MiB without terminating and keeps a complete retrievable artifact', async () => {
    const result = await runSkillScriptTool.execute({ command: command(`console.log('original-output-start'); process.stdout.write('x'.repeat(11*1024*1024)); console.log('original-output-end')`), timeoutMs: 0 }, ctx)
    expect(result).toMatchObject({ success: true, status: 'succeeded', metadata: { outputTruncated: true } })
    expect(result.output).toContain('original-output-end')
    expect(Buffer.byteLength(result.output)).toBeLessThan(10 * 1024 * 1024 + 1024)
    const archive = fs.readFileSync(String(result.metadata?.outputArchivePath), 'utf8')
    expect(archive).toContain('original-output-start')
    expect(archive).toContain('original-output-end')
    expect(Buffer.byteLength(archive)).toBeGreaterThan(11 * 1024 * 1024)
  }, 20_000)
})
