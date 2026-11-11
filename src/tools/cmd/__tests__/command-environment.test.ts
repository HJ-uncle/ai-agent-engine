// Real execute_cmd children must retain Windows directory discovery without
// inheriting service secrets or allowing Python Manager to install implicitly.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createClient, type Client } from '@libsql/client'
import { pino } from 'pino'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentContext } from '../../../core/agent-context/index.js'
import { commandJobs } from '../../../core/command-jobs/index.js'
import * as database from '../../../storage/sqlite/db.js'
import { up } from '../../../storage/sqlite/migrations/011_add_security_and_perf.js'
import { clearSecurityMode, policyEngine, setSecurityMode } from '../../../security/policy-engine.js'
import { auditLogStore } from '../../../security/audit-log.js'
import { cmdTool, commandJobScope } from '../cmd-tool.js'
import { createCommandEnvironment } from '../command-environment.js'

const directories = ['LOCALAPPDATA', 'APPDATA', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'TEMP', 'TMP', 'WINDIR']
let db: Client
let fixture: string
let ctx: AgentContext

beforeEach(async () => {
  fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'aether-command-env-'))
  db = createClient({ url: 'file::memory:' })
  vi.spyOn(database, 'getDb').mockReturnValue(db)
  vi.spyOn(auditLogStore, 'append').mockResolvedValue(undefined)
  await up(db)
  await policyEngine.resetDefaults()
  ctx = { tenantId: 'command-env', sessionId: path.basename(fixture), rootRunId: 'environment-root', turnId: 'turn',
    currentToolCallId: 'environment-probe', approvedToolCallId: 'environment-probe',
    workspaceDir: fixture, scratchDir: fixture, cwd: fixture, projectRoot: fixture, workspacePaths: [fixture],
    toolProfile: 'code', logger: pino({ level: 'silent' }) } as AgentContext
})

describe('command environment projection', () => {
  it('normalizes Windows allowlisted names without inheriting unrelated values', () => {
    const source = { Path: 'C:\\bin', LocalAppData: 'C:\\user\\local', AppData: 'C:\\user\\roaming',
      SystemRoot: 'C:\\Windows', home: 'original-home', AETHER_PRIVATE: 'private-sentinel',
      Python_Manager_Automatic_Install: 'true' }
    expect(createCommandEnvironment('standard', 'C:\\project', source, 'win32')).toEqual({
      HOME: 'C:\\project', PATH: 'C:\\bin', SystemRoot: 'C:\\Windows', LOCALAPPDATA: 'C:\\user\\local',
      APPDATA: 'C:\\user\\roaming', PYTHON_MANAGER_AUTOMATIC_INSTALL: 'false',
    })
    expect(source.Python_Manager_Automatic_Install).toBe('true')
  })

  it('removes case aliases of the installation flag in full access', () => {
    const source = { PYTHON_MANAGER_AUTOMATIC_INSTALL: 'true', python_manager_automatic_install: 'true', HOME: 'original-home' }
    expect(createCommandEnvironment('full-access', 'C:\\project', source, 'win32')).toEqual({
      HOME: 'original-home', PYTHON_MANAGER_AUTOMATIC_INSTALL: 'false',
    })
    expect(Object.keys(source)).toHaveLength(3)
  })

  it('leaves the non-Windows restricted projection and full-access inheritance unchanged', () => {
    const source = { PATH: '/usr/bin', HOME: '/user', LOCALAPPDATA: 'irrelevant', PRIVATE_VALUE: 'private-sentinel' }
    expect(createCommandEnvironment('standard', '/project', source, 'linux')).toEqual({ HOME: '/project', PATH: '/usr/bin' })
    expect(createCommandEnvironment('full-access', '/project', source, 'linux')).toEqual(source)
  })

  it('keeps explicit Python manager installs under the existing command policy', async () => {
    setSecurityMode(ctx.tenantId, ctx.sessionId, 'full-access')
    const start = vi.spyOn(commandJobs, 'start')
    expect(await cmdTool.preflight!({ command: 'py', args: ['install', '3.13'] }, ctx)).toBeUndefined()
    expect(start).not.toHaveBeenCalled()
  })
})

afterEach(async () => {
  await commandJobs.cancelScope(commandJobScope(ctx), 'test_cleanup')
  clearSecurityMode(ctx.tenantId, ctx.sessionId)
  db.close()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  if (path.dirname(fixture) !== path.resolve(os.tmpdir()) || !path.basename(fixture).startsWith('aether-command-env-')) throw new Error('Unsafe cleanup path')
  fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
})

describe.skipIf(process.platform !== 'win32')('Windows command child environment', () => {
  it.each(['safe', 'standard'] as const)('retains installed-runtime directories and disables implicit installation in %s', async mode => {
    setSecurityMode(ctx.tenantId, ctx.sessionId, mode)
    vi.stubEnv('AETHER_COMMAND_PRIVATE_FIXTURE', 'private-sentinel')
    vi.stubEnv('PYTHON_MANAGER_AUTOMATIC_INSTALL', 'true')
    const expected = Object.fromEntries(directories.filter(name => process.env[name] !== undefined).map(name => [name, process.env[name]]))
    expect(expected).toHaveProperty('LOCALAPPDATA')
    const source = `const names=${JSON.stringify(directories)};process.stdout.write(JSON.stringify({directories:Object.fromEntries(names.filter(n=>process.env[n]!==undefined).map(n=>[n,process.env[n]])),home:process.env.HOME,automaticInstall:process.env.PYTHON_MANAGER_AUTOMATIC_INSTALL,privatePresent:'AETHER_COMMAND_PRIVATE_FIXTURE' in process.env}));`
    const result = await cmdTool.execute({ command: process.execPath, args: ['-e', source], timeoutMs: 10_000 }, ctx)
    expect(result.success).toBe(true)
    expect(JSON.parse(result.output)).toEqual({ directories: expected, home: fs.realpathSync(fixture), automaticInstall: 'false', privatePresent: false })
    expect(process.env.PYTHON_MANAGER_AUTOMATIC_INSTALL).toBe('true')
  })

  it('also disables implicit installation in full access without changing its inheritance contract', async () => {
    setSecurityMode(ctx.tenantId, ctx.sessionId, 'full-access')
    vi.stubEnv('AETHER_COMMAND_PRIVATE_FIXTURE', 'private-sentinel')
    vi.stubEnv('PYTHON_MANAGER_AUTOMATIC_INSTALL', 'true')
    const result = await cmdTool.execute({ command: process.execPath, args: ['-e', "process.stdout.write(JSON.stringify({automaticInstall:process.env.PYTHON_MANAGER_AUTOMATIC_INSTALL,privatePresent:'AETHER_COMMAND_PRIVATE_FIXTURE' in process.env}));"], timeoutMs: 10_000 }, ctx)
    expect(result.success).toBe(true)
    expect(JSON.parse(result.output)).toEqual({ automaticInstall: 'false', privatePresent: true })
    expect(process.env.PYTHON_MANAGER_AUTOMATIC_INSTALL).toBe('true')
  })
})
