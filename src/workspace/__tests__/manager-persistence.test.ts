import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { WorkspaceManager } from '../manager.js'

type Binding = { tenantId: string; sessionId: string; workspaceRoot: string }
const made: Array<{ root: string; token: string }> = []
const ctx = (tenantId = 'tenant', sessionId = 'session') => ({ tenantId, sessionId })

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  for (const { root, token } of made.splice(0)) {
    // Recursive cleanup is restricted to this test's original mkdtemp folder.
    const resolved = fs.realpathSync(root)
    expect(resolved.toLowerCase()).toBe(path.resolve(root).toLowerCase())
    expect(path.dirname(resolved).toLowerCase()).toBe(fs.realpathSync(os.tmpdir()).toLowerCase())
    expect(path.basename(resolved)).toMatch(/^aether-workspace-persistence-/)
    expect(fs.readFileSync(path.join(root, '.fixture-owner'), 'utf8')).toBe(token)
    fs.rmSync(root, { recursive: true, force: true })
  }
})

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aether-workspace-persistence-'))
  const token = randomUUID()
  fs.writeFileSync(path.join(root, '.fixture-owner'), token)
  made.push({ root, token })
  const privateRoot = path.join(root, 'private'), allowed = path.join(root, 'projects')
  const state = path.join(root, 'state', 'workspace-bindings.json')
  const database = path.join(root, 'state', 'agent.db')
  fs.mkdirSync(privateRoot)
  fs.mkdirSync(allowed)
  fs.mkdirSync(path.dirname(state))
  vi.stubEnv('AETHER_WORKSPACE_BINDINGS_FILE', state)
  vi.stubEnv('DATA_DIR', database)
  vi.stubEnv('WORKSPACE_ROOT', privateRoot)
  vi.stubEnv('AETHER_ALLOWED_WORKSPACE_ROOTS', allowed)
  vi.stubEnv('AUTH_ENABLED', 'true')
  const directory = (name: string) => { const file = path.join(allowed, name); fs.mkdirSync(file, { recursive: true }); return fs.realpathSync(file) }
  return { root, privateRoot, allowed, state, database, directory, manager: () => new WorkspaceManager(privateRoot) }
}

function readState(file: string): { version: number; bindings: Binding[] } { return JSON.parse(fs.readFileSync(file, 'utf8')) }
function writeState(file: string, bindings: Binding[]) { fs.writeFileSync(file, JSON.stringify({ version: 1, bindings }) + '\n') }

describe('WorkspaceManager persistent selections', () => {
  it('restores the selected real directory in a genuinely new process after the binding process exits', () => {
    const f = fixture(), project = f.directory('restart-project')
    fs.writeFileSync(path.join(project, 'kept.txt'), 'retained project content')
    const require = createRequire(import.meta.url), loader = pathToFileURL(require.resolve('tsx')).href
    const managerUrl = new URL('../manager.ts', import.meta.url).href
    const script = `import fs from 'node:fs';import {WorkspaceManager} from ${JSON.stringify(managerUrl)};
      const m=new WorkspaceManager(process.env.WORKSPACE_ROOT),c={tenantId:'tenant',sessionId:'session'};
      const selected=process.env.TEST_BIND_PROJECT?m.bind(c,process.env.TEST_BIND_PROJECT):m.getWorkingDirectory(c);
      console.log(JSON.stringify({pid:process.pid,selected,content:fs.readFileSync(m.resolveSafePath(c,'kept.txt'),'utf8')}));`
    const execute = (bind: boolean) => {
      const env = { ...process.env, ...(bind ? { TEST_BIND_PROJECT: project } : {}) }
      if (!bind) delete env.TEST_BIND_PROJECT
      const child = spawnSync(process.execPath, ['--import', loader, '--input-type=module', '--eval', script], {
        cwd: path.resolve('.'), env, encoding: 'utf8', windowsHide: true, timeout: 15000,
      })
      expect(child.error).toBeUndefined()
      expect(child.status, child.stderr).toBe(0)
      expect(child.signal).toBeNull()
      const result = JSON.parse(child.stdout.trim().split(/\r?\n/).at(-1)!)
      expect(result.pid).toBe(child.pid)
      expect(result.pid).not.toBe(process.pid)
      expect(result.selected).toBe(project)
      expect(result.content).toBe('retained project content')
      return result
    }
    const first = execute(true), state = fs.readFileSync(f.state)
    const second = execute(false)
    expect(second.pid).not.toBe(first.pid)
    expect(fs.readFileSync(f.state)).toEqual(state)
    expect(fs.existsSync(path.join(f.privateRoot, 'tenant', 'session'))).toBe(false)
  }, 40000)

  it('keeps shared ownership until the last same-project session rebinds, then releases the old project', () => {
    const f = fixture(), a = f.directory('project-a'), b = f.directory('project-b'), manager = f.manager()
    manager.bind(ctx('tenant', 'one'), a)
    manager.bind(ctx('tenant', 'two'), a)
    manager.bind(ctx('tenant', 'one'), b)
    expect(f.manager().getWorkingDirectory(ctx('tenant', 'two'))).toBe(a)
    expect(() => f.manager().bind(ctx('other', 'one'), a)).toThrow(/another tenant/)
    manager.bind(ctx('tenant', 'two'), b)
    expect(f.manager().bind(ctx('other', 'one'), a)).toBe(a)
    expect(f.manager().getWorkingDirectory(ctx('tenant', 'one'))).toBe(b)
    expect(f.manager().getWorkingDirectory(ctx('tenant', 'two'))).toBe(b)
    expect(readState(f.state).bindings).toHaveLength(3)
  })

  it('existing manager instances observe persisted rebinds and independent disk updates', () => {
    const f = fixture(), a = f.directory('project-a'), b = f.directory('project-b'), c = f.directory('project-c')
    const first = f.manager(), second = f.manager()
    first.bind(ctx(), a)
    expect(second.getWorkingDirectory(ctx())).toBe(a)
    second.bind(ctx(), b)
    expect(first.getWorkingDirectory(ctx())).toBe(b)
    writeState(f.state, [{ ...ctx(), workspaceRoot: c }])
    expect(first.getWorkingDirectory(ctx())).toBe(c)
    expect(second.getWorkingDirectory(ctx())).toBe(c)
  })

  it('a moved project explicitly fails without scratch fallback and survives another session being bound', () => {
    const f = fixture(), a = f.directory('project-a'), b = f.directory('project-b'), manager = f.manager()
    manager.bind(ctx(), a)
    const before = fs.readFileSync(f.state)
    fs.renameSync(a, path.join(f.allowed, 'project-a-moved'))
    expect(() => manager.getWorkingDirectory({ ...ctx(), cwd: b })).toThrow(/no longer available/)
    expect(() => f.manager().getWorkingDirectory(ctx())).toThrow(/no longer available/)
    expect(fs.readFileSync(f.state)).toEqual(before)
    expect(fs.existsSync(path.join(f.privateRoot, 'tenant', 'session'))).toBe(false)
    manager.bind(ctx('tenant', 'second'), b)
    expect(readState(f.state).bindings).toContainEqual({ ...ctx(), workspaceRoot: a })
    expect(() => manager.getWorkingDirectory(ctx())).toThrow(/no longer available/)
    expect(manager.bind(ctx(), b)).toBe(b)
  })

  it('a moved binding from another tenant does not claim the whole allowlist root', () => {
    const f = fixture(), moved = f.directory('moved-project'), available = f.directory('available-project')
    f.manager().bind(ctx('owner', 'session'), moved)
    fs.renameSync(moved, path.join(f.root, 'moved-outside-allowlist'))
    // The old owner record is retained and must still fail explicitly for its
    // own session, but its missing path must not canonicalize to `projects/`
    // and block unrelated tenants from using another retained project.
    expect(() => f.manager().getWorkingDirectory(ctx('owner', 'session'))).toThrow(/no longer available/)
    expect(f.manager().bind(ctx('other', 'session'), available)).toBe(available)
    expect(readState(f.state).bindings).toContainEqual({ tenantId: 'owner', sessionId: 'session', workspaceRoot: moved })
  })

  it('a narrowed allowlist reports the old selection and preserves it instead of silently resetting', () => {
    const f = fixture(), a = f.directory('project-a'), b = f.directory('project-b')
    f.manager().bind(ctx(), a)
    const before = fs.readFileSync(f.state)
    vi.stubEnv('AETHER_ALLOWED_WORKSPACE_ROOTS', b)
    const narrowed = f.manager()
    expect(() => narrowed.getWorkingDirectory({ ...ctx(), cwd: b, projectRoot: b })).toThrow(/outside.*allowed/)
    expect(fs.readFileSync(f.state)).toEqual(before)
    narrowed.bind(ctx('tenant', 'second'), b)
    expect(readState(f.state).bindings).toContainEqual({ ...ctx(), workspaceRoot: a })
    expect(() => narrowed.getWorkingDirectory(ctx())).toThrow(/outside.*allowed/)
    expect(fs.existsSync(path.join(f.privateRoot, 'tenant', 'session'))).toBe(false)
  })

  it.each(['writeFileSync', 'fsyncSync', 'renameSync'] as const)('%s failure preserves old bytes and all instances keep the old selection', operation => {
    const f = fixture(), a = f.directory('project-a'), b = f.directory('project-b'), manager = f.manager()
    manager.bind(ctx(), a)
    const before = fs.readFileSync(f.state), diskFiles = fs.readdirSync(path.dirname(f.state))
    const fault = vi.spyOn(fs, operation).mockImplementation(() => { throw Object.assign(new Error(`injected-${operation}`), { code: 'EIO' }) })
    try { expect(() => manager.bind(ctx(), b)).toThrow(`injected-${operation}`) }
    finally { fault.mockRestore() }
    expect(fs.readFileSync(f.state)).toEqual(before)
    expect(fs.readdirSync(path.dirname(f.state))).toEqual(diskFiles)
    expect(manager.getWorkingDirectory(ctx())).toBe(a)
    expect(f.manager().getWorkingDirectory(ctx())).toBe(a)
    expect(manager.bind(ctx(), b)).toBe(b)
  })

  it.each([
    ['truncated JSON', '{"version":1,"bindings":['],
    ['unsupported version', JSON.stringify({ version: 2, bindings: [] })],
    ['missing bindings', JSON.stringify({ version: 1 })],
    ['invalid identifier', JSON.stringify({ version: 1, bindings: [{ tenantId: '../other', sessionId: 's', workspaceRoot: path.resolve('.') }] })],
    ['relative path', JSON.stringify({ version: 1, bindings: [{ ...ctx(), workspaceRoot: 'relative/project' }] })],
    ['duplicate session', JSON.stringify({ version: 1, bindings: [{ ...ctx(), workspaceRoot: path.resolve('.') }, { ...ctx(), workspaceRoot: path.resolve('other') }] })],
  ])('rejects %s without overwriting or partially accepting disk state', (_label, contents) => {
    const f = fixture(), a = f.directory('project-a'), manager = f.manager()
    fs.writeFileSync(f.state, contents)
    const before = fs.readFileSync(f.state)
    expect(() => manager.getWorkingDirectory(ctx())).toThrow(/binding state|valid identifier/)
    expect(() => manager.bind(ctx(), a)).toThrow(/binding state|valid identifier/)
    expect(() => f.manager().getWorkingDirectory(ctx())).toThrow(/binding state|valid identifier/)
    expect(fs.readFileSync(f.state)).toEqual(before)
    expect(fs.readdirSync(path.dirname(f.state))).toEqual([path.basename(f.state)])
  })

  it('a configured private-root junction preserves canonical tenant isolation across manager restarts', () => {
    const f = fixture(), realRoot = path.join(f.root, 'real-private'), junction = path.join(f.root, 'private-junction')
    fs.mkdirSync(path.join(realRoot, 'a', 'project'), { recursive: true })
    fs.mkdirSync(path.join(realRoot, 'b', 'project'), { recursive: true })
    fs.symlinkSync(realRoot, junction, process.platform === 'win32' ? 'junction' : 'dir')
    const manager = new WorkspaceManager(junction), a = fs.realpathSync(path.join(junction, 'a', 'project'))
    expect(manager.bind(ctx('a'), path.join(junction, 'a', 'project'))).toBe(a)
    expect(new WorkspaceManager(junction).getWorkingDirectory(ctx('a'))).toBe(a)
    expect(() => manager.bind(ctx('b'), path.join(junction, 'a', 'project'))).toThrow(/another tenant/)
    expect(() => manager.bind(ctx('b'), junction)).toThrow(/private workspace root/)
    expect(manager.bind(ctx('b'), path.join(junction, 'b', 'project'))).toBe(fs.realpathSync(path.join(junction, 'b', 'project')))
    expect(() => new WorkspaceManager(junction).getWorkingDirectory(ctx('a'))).not.toThrow()
  })

  it('a binding-state junction is rejected without touching its target or losing prior records', () => {
    const f = fixture(), a = f.directory('project-a'), target = path.join(f.root, 'state-target')
    fs.mkdirSync(target)
    fs.writeFileSync(path.join(target, 'sentinel.txt'), 'must remain')
    // A directory junction reliably exercises symlink lstat on Windows without
    // requiring the special privilege needed to create a file symlink.
    fs.symlinkSync(target, f.state, process.platform === 'win32' ? 'junction' : 'dir')
    const manager = f.manager()
    expect(() => manager.getWorkingDirectory(ctx())).toThrow(/symbolic link/)
    expect(() => manager.bind(ctx(), a)).toThrow(/symbolic link/)
    expect(fs.lstatSync(f.state).isSymbolicLink()).toBe(true)
    expect(fs.readFileSync(path.join(target, 'sentinel.txt'), 'utf8')).toBe('must remain')
    expect(fs.readdirSync(target)).toEqual(['sentinel.txt'])
  })
})
