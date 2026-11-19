import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

const engine = fileURLToPath(new URL('../../', import.meta.url))
const scratch = path.join(engine, '.e2e-tmp', 'service-credentials', 'admin-cli-tests')
const cli = fileURLToPath(new URL('../admin-cli.ts', import.meta.url))
let root: string, cwd: string, managed: string, globalDir: string, shim: string
function write(file: string, text: string): void {
  mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, text, { mode: 0o600 })
}
function json(file: string, env: Record<string, string>): void { write(file, JSON.stringify({ env })) }
function command(args: string[], extra: NodeJS.ProcessEnv = {}) {
  // Only the child sees these aliases; neither its config, home nor sqlite can point at the developer's profile.
  const home = path.join(cwd, 'home'), temp = path.join(root, 'tmp')
  const env: NodeJS.ProcessEnv = { AETHER_GLOBAL_DIR: globalDir, PROGRAMDATA: path.dirname(path.dirname(managed)),
    HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'roaming'), LOCALAPPDATA: path.join(home, 'local'),
    XDG_CONFIG_HOME: home, XDG_CACHE_HOME: temp, TMPDIR: temp, TEMP: temp, TMP: temp, DATA_DIR: path.join(cwd, 'must-not-open.db'),
    NODE_ENV: 'test', LOG_LEVEL: 'debug', ...extra }
  if (process.platform === 'win32') {
    env.SystemRoot = process.env.SystemRoot; env.WINDIR = process.env.WINDIR; env.ComSpec = process.env.ComSpec; env.PATHEXT = process.env.PATHEXT
    env.PATH = [path.dirname(process.execPath), path.join(process.env.SystemRoot!, 'System32')].join(path.delimiter)
  } else env.PATH = [path.dirname(process.execPath), '/usr/bin', '/bin'].join(path.delimiter)
  const preload = process.platform === 'win32' ? [] : ['--require', shim]
  const result = spawnSync(process.execPath, [...preload, '--import', 'tsx', cli, ...args], {
    cwd, env, encoding: 'utf8', timeout: 10_000, windowsHide: true,
  })
  if (result.error) throw new Error(`CLI did not finish: ${(result.error as NodeJS.ErrnoException).code}`)
  expect(existsSync(env.DATA_DIR!)).toBe(false)
  return { code: result.status, out: result.stdout, err: result.stderr }
}
/** Inspect the file's actual OS ACL rather than checking that the CLI ran a permissions command. */
function expectPrivateFile(file: string): void {
  const stat = lstatSync(file)
  expect(stat.isFile() && !stat.isSymbolicLink()).toBe(true)
  if (process.platform !== 'win32') { expect(stat.mode & 0o777).toBe(0o600); return }
  const exe = path.join(process.env.SystemRoot!, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const inspect = `
    $ErrorActionPreference = 'Stop'
    $acl = [System.IO.File]::GetAccessControl($env:AETHER_CLI_TEST_ACL_PATH)
    $sidType = [System.Security.Principal.SecurityIdentifier]
    [Console]::WriteLine([System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value)
    [Console]::WriteLine($acl.AreAccessRulesProtected)
    $full = [System.Security.AccessControl.FileSystemRights]::FullControl
    foreach ($rule in $acl.GetAccessRules($true,$true,$sidType)) {
      [Console]::WriteLine(('{0}|{1}|{2}|{3}' -f $rule.IdentityReference.Value,$rule.AccessControlType,$rule.IsInherited,(($rule.FileSystemRights -band $full) -eq $full)))
    }`
  const evidence = spawnSync(exe, ['-NoLogo','-NoProfile','-NonInteractive','-Command',inspect], {
    env:{...process.env,AETHER_CLI_TEST_ACL_PATH:file},encoding:'utf8',windowsHide:true,timeout:10_000,
  })
  const diagnostic = evidence.stderr?.replace(/aether_admin_[A-Za-z0-9_-]{43}/g,'[redacted]').slice(0,900) ?? ''
  expect(evidence.status, 'Windows must confirm the new file ACL: '+diagnostic).toBe(0)
  const [me, protectedAcl, ...rules] = evidence.stdout.trim().split(/\r?\n/)
  expect(me).toMatch(/^S-1-\d+(?:-\d+)+$/)
  expect(protectedAcl).toBe('True')
  expect(rules).toEqual([me+'|Allow|False|True'])
}
const invoke = (action: string, env?: NodeJS.ProcessEnv) => command(['token', action], env)
const clean = (out: string) => ({ code: 0, out: out + '\n', err: '' })

beforeAll(() => { mkdirSync(scratch, { recursive: true }); root = mkdtempSync(path.join(scratch, 'run-')); mkdirSync(path.join(root, 'tmp')) })
beforeEach(() => {
  cwd = mkdtempSync(path.join(root, 'case-'))
  globalDir = path.join(cwd, 'global'); managed = path.join(cwd, 'programdata', 'Aether', 'settings.json')
  mkdirSync(path.join(cwd, 'home'))
  if (process.platform !== 'win32') {
    // Production locates managed settings at a fixed OS path on Unix. Redirect this single file
    // in the isolated child before loading any application module; never inspect system settings.
    const system = process.platform === 'darwin' ? '/Library/Application Support/Aether/settings.json' : '/etc/aether/settings.json'
    shim = path.join(cwd, 'managed-path.cjs')
    write(shim, `const fs = require('node:fs'); for(const method of ['existsSync','readFileSync']) { const read=fs[method]; fs[method]=(p,...rest)=>read(p===${JSON.stringify(system)}?${JSON.stringify(managed)}:p,...rest) }; require('node:module').syncBuiltinESMExports();`)
  }
})
afterAll(() => {
  if (!root || path.dirname(root) !== scratch || !path.basename(root).startsWith('run-') || lstatSync(root).isSymbolicLink() || path.dirname(realpathSync(root)) !== realpathSync(scratch)) throw new Error('Unexpected CLI fixture root')
  rmSync(root, { recursive: true })
})

describe('standalone administrator token commands', () => {
  it('distinguishes an absent setting from an empty one without producing a token', () => {
    expect(invoke('status')).toEqual(clean('not-set'))
    expect(invoke('show')).toMatchObject({ code: 1, out: '' })
    write(path.join(cwd, '.env'), 'AETHER_INSTANCE_TOKEN=""\n')
    expect(invoke('status')).toEqual(clean('empty'))
    expect(invoke('show')).toMatchObject({ code: 1, out: '' })
  }, 15_000)

  it('follows the actual startup precedence, including replacement of the whole project env block', () => {
    const inherited = { AETHER_INSTANCE_TOKEN: 'test-launch' }
    write(path.join(cwd, '.env'), 'AETHER_INSTANCE_TOKEN="test-dotenv"\n')
    expect(invoke('show')).toEqual(clean('test-dotenv'))
    expect(invoke('status', { AETHER_INSTANCE_TOKEN: '' })).toEqual(clean('empty'))
    expect(invoke('show', inherited)).toEqual(clean('test-launch'))
    json(path.join(globalDir, 'aether.json'), { AETHER_INSTANCE_TOKEN: 'test-user' })
    expect(invoke('show', inherited)).toEqual(clean('test-user'))
    json(path.join(cwd, '.aether', 'aether.json'), { AETHER_INSTANCE_TOKEN: 'test-legacy-project' })
    expect(invoke('show', inherited)).toEqual(clean('test-legacy-project'))
    json(path.join(cwd, '.ae', 'aether.json'), { UNRELATED: 'test' })
    expect(invoke('show', inherited)).toEqual(clean('test-launch'))
    json(path.join(cwd, '.ae', 'aether.json'), { AETHER_INSTANCE_TOKEN: 'test-project' })
    expect(invoke('show', inherited)).toEqual(clean('test-project'))
    json(managed, { AETHER_INSTANCE_TOKEN: 'test-managed' })
    expect(invoke('status', inherited)).toEqual(clean('configured'))
    expect(invoke('show', inherited)).toEqual(clean('test-managed'))
    json(managed, { AETHER_INSTANCE_TOKEN: '' })
    expect(invoke('status', inherited)).toEqual(clean('empty'))
  }, 25_000)

  it('generates independent 256-bit candidates without reading or changing configuration', () => {
    const badEnv = { AETHER_ENGINE_PROJECT_ENV: 'invalid-embedded-snapshot' }
    const first = invoke('generate', badEnv), second = invoke('generate', badEnv)
    expect(first).toEqual({ code: 0, out: expect.stringMatching(/^[0-9a-f]{64}\n$/), err: '' })
    expect(second).toEqual({ code: 0, out: expect.stringMatching(/^[0-9a-f]{64}\n$/), err: '' })
    expect(first.out !== second.out).toBe(true)
    expect(invoke('status')).toEqual(clean('not-set'))
  }, 12_000)

  it('does not echo parse fragments, embedded tokens, bad arguments or terminal controls', () => {
    const canary = 'private-test-marker'
    write(path.join(cwd, '.ae', 'aether.json'), '!' + canary)
    expect(invoke('status', { AETHER_INSTANCE_TOKEN: canary })).toEqual(clean('configured'))
    const outputs = [invoke('show', { AETHER_DESKTOP_OWNED: '1', AETHER_INSTANCE_TOKEN: canary }),
      invoke('status', { AETHER_ENGINE_PROJECT_ENV: canary }), invoke('show', { AETHER_INSTANCE_TOKEN: canary + '\nmore' }),
      command(['token', 'show', canary])]
    expect(outputs.map(r => r.code)).toEqual([1, 1, 1, 2]); expect(outputs.every(r => !r.out && r.err.length > 0 && !r.err.includes(canary))).toBe(true)
  }, 15_000)
})

describe('offline management administrator CLI', () => {
  it('creates a private key file, refuses to overwrite it and never prints its key', async () => {
    const primary = path.join(cwd,'isolated engine.db'), output = path.join(cwd,'private output','owner key.txt')
    const { LocalSqliteProcessClient } = await import('../storage/sqlite/local-process-client.js')
    const { up } = await import('../storage/sqlite/migrations/001_initial.js')
    const db = new LocalSqliteProcessClient({url:'file:' + encodeURIComponent(primary)}, {cacheKb:1024,mmapBytes:0})
    try { await up(db) } finally { expect((await db.closeWithReceipt()).healthy).toBe(true) }

    const args = ['admin','create','--data',primary,'--out',output,'--name','CLI 验收管理员']
    const first = command(args)
    expect(first.code).toBe(0); expect(first.out.length > 0 && first.err.length === 0).toBe(true)
    expectPrivateFile(output)
    const original = readFileSync(output,'utf8'), fileId = lstatSync(output,{bigint:true})
    expect(/^aether_admin_[A-Za-z0-9_-]{43}\n$/.test(original)).toBe(true)
    const retry = command(args), after = lstatSync(output,{bigint:true})
    expect(retry.code).toBe(1); expect(retry.out.length === 0 && retry.err.length > 0).toBe(true)
    expect(after.dev === fileId.dev && after.ino === fileId.ino && readFileSync(output,'utf8') === original).toBe(true)
    // Boolean assertions prevent even a failing test from displaying the generated key in the test report.
    expect([first.out,first.err,retry.out,retry.err].every(text => !text.includes(original.trim()) && !/aether_admin_[A-Za-z0-9_-]{43}/.test(text))).toBe(true)
  },25_000)
})
