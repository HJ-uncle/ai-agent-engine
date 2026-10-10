import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createClient, type Client } from '@libsql/client'
import { pino } from 'pino'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentContext } from '../../../core/agent-context/index.js'
import { commandJobs, type CommandJobSnapshot } from '../../../core/command-jobs/index.js'
import * as database from '../../../storage/sqlite/db.js'
import { up } from '../../../storage/sqlite/migrations/011_add_security_and_perf.js'
import { clearSecurityMode, policyEngine, setSecurityMode } from '../../../security/policy-engine.js'
import { cmdTool, commandJobScope } from '../cmd-tool.js'
import { commandOutputTool, cancelCommandTool } from '../job-tools.js'

let db: Client
let fixture: string
let ctx: AgentContext
const script = (name: string, content: string) => { const file = path.join(fixture, name); fs.writeFileSync(file, content); return file }
const jobOf = (result: { metadata?: Record<string, unknown> }) => result.metadata!.commandJob as CommandJobSnapshot

beforeEach(async () => {
  fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'aether-command-tools-'))
  db = createClient({ url: 'file::memory:' })
  vi.spyOn(database, 'getDb').mockReturnValue(db)
  await up(db)
  await policyEngine.resetDefaults()
  ctx = { tenantId: 'command-tools', sessionId: path.basename(fixture), rootRunId: 'root-run', turnId: 'turn',
    currentToolCallId: 'launch-tool', workspaceDir: fixture, scratchDir: fixture, cwd: fixture, projectRoot: fixture,
    workspacePaths: [fixture], toolProfile: 'code', logger: pino({ level: 'silent' }) } as AgentContext
  setSecurityMode(ctx.tenantId, ctx.sessionId, 'full-access')
})

afterEach(async () => {
  await commandJobs.cancelScope(commandJobScope(ctx), 'test_cleanup')
  clearSecurityMode(ctx.tenantId, ctx.sessionId)
  db.close()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  if (path.dirname(fixture) !== path.resolve(os.tmpdir()) || !path.basename(fixture).startsWith('aether-command-tools-')) throw new Error('Unsafe cleanup path')
  fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
})

describe('D7 command tools with real policy and processes', () => {
  it('keeps foreground output compatibility and reports real exit code, cwd and literal arguments', async () => {
    const file = script('foreground.cjs', "process.stdout.write(JSON.stringify({cwd:process.cwd(),args:process.argv.slice(2)}));process.stderr.write('stderr evidence');process.exitCode=3")
    const args = ['two words', '中文🙂', 'quote"inside', '%literal%']
    const result = await cmdTool.execute({ command: process.execPath, args: [file, ...args] }, ctx)
    expect(result.success).toBe(false)
    expect(result.output).toContain(JSON.stringify({ cwd: fs.realpathSync(fixture), args }))
    expect(result.output).toContain('stderr evidence')
    expect(result.output).toContain('[COMMAND_EXIT_FAILED] status=failed; exitCode=3; signal=none')
    expect(result.metadata).toMatchObject({ exitCode: 3, commandJob: { status: 'failed', background: false, exitCode: 3 } })
  })

  it.each(['node -v', 'where python', 'cmd /c "node -v & python --version"'])('rejects an entire shell line with repair instructions before spawning: %s', async command => {
    const start = vi.spyOn(commandJobs, 'start')
    const result = await cmdTool.execute({ command }, ctx)
    expect(result).toMatchObject({ success: false, error: 'COMMAND_INVALID_ARGUMENTS' })
    expect(result.output).toContain('{"command":"node","args":["-v"]}')
    expect(result.output).toContain('无需嵌套 cmd')
    expect(start).not.toHaveBeenCalled()
  })

  it('allows a real executable path containing spaces through the policy preflight', async () => {
    const executable = script('runtime with spaces.exe', 'fixture')
    expect(await cmdTool.preflight!({ command: executable, args: ['-v'] }, ctx)).toBeUndefined()
  })

  it('uses live root mode for commands despite a stale child snapshot, including permission revocation', async () => {
    const child = { ...ctx, rootSessionId: ctx.sessionId, sessionId: ctx.sessionId + '-child' }
    const input = { command: 'cmd.exe', args: ['/d', '/s', '/c', 'netstat -ano | findstr :8765'] }
    setSecurityMode(child.tenantId, child.sessionId, 'standard')
    try {
      expect(await cmdTool.preflight!(input, child)).toBeUndefined()
      setSecurityMode(child.tenantId, child.sessionId, 'full-access')
      setSecurityMode(ctx.tenantId, ctx.sessionId, 'standard')
      expect(await cmdTool.preflight!(input, child)).toMatchObject({ needsConfirmation: true })
      setSecurityMode(ctx.tenantId, ctx.sessionId, 'safe')
      expect(await cmdTool.preflight!(input, child)).toMatchObject({ success: false, metadata: { blocked: true } })
      const foreign = { ...child, tenantId: child.tenantId + '-other' }
      setSecurityMode(ctx.tenantId, ctx.sessionId, 'full-access')
      vi.stubEnv('DEFAULT_SECURITY_MODE', 'standard')
      expect(await cmdTool.preflight!(input, foreign)).toMatchObject({ needsConfirmation: true })
    } finally { clearSecurityMode(child.tenantId, child.sessionId) }
  })

  it.skipIf(process.platform !== 'win32')('rejects multiline batch arguments before policy approval or process launch', async () => {
    const batch = script('multiline.cmd', '@echo off\r\necho should-not-run > unexpected.txt')
    const start = vi.spyOn(commandJobs, 'start')
    const policy = vi.spyOn(policyEngine, 'evaluate')
    const result = await cmdTool.execute({ command: batch, args: ['first\nsecond'] }, ctx)
    expect(result).toMatchObject({ success: false, error: 'COMMAND_INVALID_ARGUMENTS' })
    expect(result.output).toContain('直接调用 node/python')
    expect(start).not.toHaveBeenCalled()
    expect(policy).not.toHaveBeenCalled()
    expect(fs.existsSync(path.join(fixture, 'unexpected.txt'))).toBe(false)
  })

  it.each(['standard', 'safe'] as const)('preserves PATH/PATHEXT without leaking unrelated environment in %s mode', async mode => {
    vi.stubEnv('PATHEXT', '.EXE;.CMD')
    vi.stubEnv('AETHER_COMMAND_PRIVATE_FIXTURE', 'must-not-enter-command')
    setSecurityMode(ctx.tenantId, ctx.sessionId, mode)
    const start = vi.spyOn(commandJobs, 'start')
    const file = script('environment.cjs', 'process.stdout.write(JSON.stringify({pathext:process.env.PATHEXT,privateValue:process.env.AETHER_COMMAND_PRIVATE_FIXTURE??null}))')
    const approved = { ...ctx, approvedToolCallId: ctx.currentToolCallId }
    const result = await cmdTool.execute({ command: process.execPath, args: [file] }, approved)
    expect(result.success).toBe(true)
    expect(JSON.parse(result.output)).toEqual({ pathext: '.EXE;.CMD', privateValue: null })
    expect(start.mock.calls.at(-1)?.[0].env).toMatchObject({ PATH: process.env.PATH, PATHEXT: '.EXE;.CMD' })
    expect(start.mock.calls.at(-1)?.[0].env).not.toHaveProperty('AETHER_COMMAND_PRIVATE_FIXTURE')
  })

  it('returns a background launch before completion, then reads its persisted success and output', async () => {
    const file = script('background.cjs', "process.stdout.write('started');const t=setInterval(()=>{if(require('node:fs').existsSync('release')){clearInterval(t);process.stdout.write(' finished')}},10)")
    const result = await cmdTool.execute({ command: process.execPath, args: [file], background: true }, ctx)
    expect(result.success).toBe(true)
    const job = jobOf(result)
    expect(job).toMatchObject({ status: 'running', background: true, sessionId: ctx.sessionId,
      ownerSessionId: ctx.sessionId, runId: 'root-run', turnId: 'turn', toolCallId: 'launch-tool' })
    fs.writeFileSync(path.join(fixture, 'release'), 'go')
    expect((await commandJobs.wait(commandJobScope(ctx), job.jobId))?.status).toBe('succeeded')
    const output = await commandOutputTool.execute({ jobId: job.jobId, cursor: 0 }, ctx)
    expect(output.success).toBe(true)
    expect(JSON.parse(output.output).entries.map((entry: { text: string }) => entry.text).join('')).toBe('started finished')
    expect(jobOf(output)).toMatchObject({ status: 'succeeded', exitCode: 0 })
  })

  it('reuses exact invocation approval for background launch and does not create a job before approval', async () => {
    setSecurityMode(ctx.tenantId, ctx.sessionId, 'safe')
    await policyEngine.upsertRule({ name: 'ask-fixture-node', command: path.basename(process.execPath).toLowerCase(), action: 'ask', priority: 1, enabled: true })
    const file = script('approved.cjs', "require('node:fs').writeFileSync('effect', 'approved')")
    const args = { command: process.execPath, args: [file], background: true }
    expect((await cmdTool.preflight!(args, ctx))?.needsConfirmation).toBe(true)
    expect((await cmdTool.execute(args, ctx)).needsConfirmation).toBe(true)
    expect(await commandJobs.list(commandJobScope(ctx))).toEqual([])
    expect(fs.existsSync(path.join(fixture, 'effect'))).toBe(false)
    const approved = { ...ctx, approvedToolCallId: ctx.currentToolCallId }
    const result = await cmdTool.execute(args, approved)
    expect(result.success).toBe(true)
    await commandJobs.wait(commandJobScope(ctx), jobOf(result).jobId)
    expect(fs.readFileSync(path.join(fixture, 'effect'), 'utf8')).toBe('approved')
    expect((await cmdTool.execute(args, { ...approved, currentToolCallId: 'different-tool' })).needsConfirmation).toBe(true)
    expect(await commandJobs.list(commandJobScope(ctx))).toHaveLength(1)
  })

  it('requires confirmation for background interpreters and validates flags before launch', async () => {
    setSecurityMode(ctx.tenantId, ctx.sessionId, 'safe')
    const denied = await cmdTool.execute({ command: process.execPath, args: ['-e', 'process.exit(0);'], background: true }, ctx)
    expect(denied).toMatchObject({ success: false, needsConfirmation: true })
    for (const args of [null, { command: process.execPath, background: 'true' }, { command: process.execPath, timeoutMs: NaN }, { command: process.execPath, cwd: 1 }]) {
      expect(await cmdTool.execute(args, ctx)).toMatchObject({ success: false, error: 'COMMAND_INVALID_ARGUMENTS' })
    }
    expect(await commandJobs.list(commandJobScope(ctx))).toEqual([])
  })

  it('rejects workspace traversal before background spawning', async () => {
    setSecurityMode(ctx.tenantId, ctx.sessionId, 'safe')
    const approved = { ...ctx, approvedToolCallId: ctx.currentToolCallId }
    await expect(cmdTool.execute({ command: process.execPath, args: [], cwd: path.dirname(fixture), background: true }, approved)).rejects.toThrow('outside')
    expect(await commandJobs.list(commandJobScope(ctx))).toEqual([])
  })

  it('cancels an owned background job while foreign sessions and sibling agents cannot inspect or stop it', async () => {
    const file = script('owned.cjs', "process.stdout.write('owned output');setInterval(()=>{},1000)")
    const childCtx = { ...ctx, rootSessionId: ctx.sessionId, sessionId: 'child-owner', runId: 'child-run' }
    setSecurityMode(childCtx.tenantId, childCtx.sessionId, 'full-access')
    try {
      const started = await cmdTool.execute({ command: process.execPath, args: [file], background: true }, childCtx)
      const job = jobOf(started)
      for (const foreign of [{ ...ctx, sessionId: 'foreign-session' }, { ...childCtx, sessionId: 'sibling' }]) {
        expect(await commandOutputTool.execute({ jobId: job.jobId }, foreign)).toMatchObject({ success: false, error: 'COMMAND_JOB_NOT_FOUND' })
        expect(await cancelCommandTool.execute({ jobId: job.jobId }, foreign)).toMatchObject({ success: false, error: 'COMMAND_JOB_NOT_FOUND' })
      }
      expect((await commandJobs.get(commandJobScope(ctx), job.jobId))?.status).toBe('running')
      const stopped = await cancelCommandTool.execute({ jobId: job.jobId }, ctx)
      expect(stopped.success).toBe(true)
      expect(jobOf(stopped).status).toBe('cancelled')
    } finally { clearSecurityMode(childCtx.tenantId, childCtx.sessionId) }
  })

  it('reports timeout as failed foreground work while retaining partial output', async () => {
    const file = script('timeout.cjs', "process.stdout.write('partial evidence');setInterval(()=>{},1000)")
    const result = await cmdTool.execute({ command: process.execPath, args: [file], timeoutMs: 500 }, ctx)
    expect(result).toMatchObject({ success: false, error: 'COMMAND_TIMEOUT', metadata: { commandJob: { status: 'timed_out' } } })
    expect(result.output).toContain('partial evidence')
    expect(result.output).toContain('timed out')
  }, 15_000)

  it('does not impose a synthetic deadline on an omitted Code timeout', async () => {
    const launchSpy = vi.spyOn(commandJobs, 'start')
    const file = script('long-code.cjs', "setTimeout(() => process.stdout.write('completed after the normal timeout window'), 150)")
    const result = await cmdTool.execute({ command: process.execPath, args: [file] }, ctx)
    expect(result.success).toBe(true)
    expect(result.output).toContain('completed after the normal timeout window')
    expect(launchSpy.mock.calls.at(-1)?.[0].timeoutMs).toBeUndefined()
    launchSpy.mockRestore()
  })
})
