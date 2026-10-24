/** No real processes or mutable installations: verify bounded host discovery and shared observations. */
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { AgentContext } from '../../../core/agent-context/index.js'
import { OfficeEnvironmentService, officeEnvironmentTool, type OfficeEnvironmentPorts } from '../environment.js'

const python = 'C:\\Program Files\\Python315\\python.exe'
const powershell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
const packagePairs = [['docx', 'python-docx'], ['pptx', 'python-pptx'], ['openpyxl', 'openpyxl'],
  ['reportlab', 'reportlab'], ['pymupdf', 'PyMuPDF'], ['pypdf', 'pypdf'], ['PIL', 'Pillow']]
const pythonOutput = JSON.stringify({ version: '3.15.0', packages: packagePairs.map(([module, distribution]) => ({
  module, distribution, available: module !== 'pymupdf', ...(module === 'pymupdf' ? { error: 'ModuleNotFoundError' } : { version: '1.2.3' }),
})) })
const key = (value: string) => path.win32.normalize(value).toLowerCase()
function fixture() {
  let now = 1000
  const env: NodeJS.ProcessEnv = { AUTH_ENABLED: 'false', ProgramFiles: 'C:\\Program Files',
    'ProgramFiles(x86)': 'C:\\Program Files (x86)', LOCALAPPDATA: 'C:\\Users\\reader\\AppData\\Local',
    SystemRoot: 'C:\\Windows', PATH: path.win32.dirname(python), TEMP: 'C:\\Temp', TMP: 'C:\\Temp',
    MODEL_API_KEY: 'never-pass-or-print', PYTHONPATH: 'D:\\other-task', PYTHONSTARTUP: 'D:\\other-task\\start.py' }
  const roots = [env.ProgramFiles!, env['ProgramFiles(x86)']!,
    env.LOCALAPPDATA! + '\\Python', env.LOCALAPPDATA! + '\\Programs\\Python']
  const files = new Set([python, powershell].map(key))
  const aliases = new Map<string, string>()
  const directories = vi.fn(async (_value: string): Promise<string[]> => [])
  const realpath = vi.fn(async (value: string) => {
    if (aliases.has(key(value))) return aliases.get(key(value))!
    if (files.has(key(value)) || roots.some(root => key(value) === key(root))) return path.win32.normalize(value)
    throw new Error('Missing fixture path')
  })
  const run = vi.fn<OfficeEnvironmentPorts['run']>(async (binary) => binary.endsWith('powershell.exe') ? '[]' : pythonOutput)
  const port: OfficeEnvironmentPorts = { environment: () => env, platform: 'win32', now: () => now,
    realpath, isFile: async value => files.has(key(value)), directories, run }
  return { env, files, aliases, roots, realpath, directories, run, port,
    service: new OfficeEnvironmentService(port), advance: (ms: number) => { now += ms } }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

describe('office environment bounded observations', () => {
  it('shares one probe across six sessions, caches results and returns independent snapshots', async () => {
    const f = fixture()
    const results = await Promise.all(Array.from({ length: 6 }, () => f.service.inspect()))
    expect(f.run).toHaveBeenCalledTimes(2)
    expect(results[0]).toMatchObject({ status: 'checked', runtime: 'host', checkedAt: 1000, expiresAt: 121000,
      python: { path: python, source: 'trusted-path', status: 'available', version: '3.15.0' },
      office: { registryStatus: 'checked', conversionVerified: false } })
    expect(results[0].python?.packages?.find(item => item.module === 'pymupdf')).toEqual({
      module: 'pymupdf', distribution: 'PyMuPDF', available: false, error: 'ModuleNotFoundError',
    })
    results[0].limitations.length = 0
    expect(results[1].limitations.length).toBeGreaterThan(0)
    await f.service.inspect()
    expect(f.run).toHaveBeenCalledTimes(2)
    f.advance(120000)
    expect((await f.service.inspect()).checkedAt).toBe(121000)
    expect(f.run).toHaveBeenCalledTimes(4)
  })

  it('invalidates cached environment keys without caching or returning secret values', async () => {
    const f = fixture()
    await f.service.inspect()
    f.env.AETHER_OFFICE_PYTHON = 'D:\\other-task\\python.exe'
    const next = await f.service.inspect()
    expect(next.python).toBeNull()
    expect(next.limitations.join(' ')).toContain('未回退')
    expect(f.run).toHaveBeenCalledTimes(3)
    expect(JSON.stringify(next)).not.toContain('never-pass-or-print')
    expect(JSON.stringify(next)).not.toContain('D:\\\\other-task')
  })

  it('waits for an old environment probe before starting a new one and does not reuse stale evidence', async () => {
    const f = fixture(), gate = deferred<string>()
    f.run.mockImplementation(async binary => binary === python ? gate.promise : '[]')
    const first = f.service.inspect()
    await vi.waitFor(() => expect(f.run).toHaveBeenCalledTimes(2))
    f.env.AETHER_OFFICE_PYTHON = 'D:\\untrusted\\python.exe'
    const changed = f.service.inspect()
    await Promise.resolve()
    expect(f.run).toHaveBeenCalledTimes(2)
    gate.resolve(pythonOutput)
    expect((await first).python?.status).toBe('available')
    expect((await changed).python).toBeNull()
    expect(f.run).toHaveBeenCalledTimes(3)
  })

  it('cancels one caller without aborting another session shared probe', async () => {
    const f = fixture(), gate = deferred<string>(), controller = new AbortController()
    f.run.mockImplementation(async binary => binary === python ? gate.promise : '[]')
    const cancelled = f.service.inspect(controller.signal)
    const rejection = expect(cancelled).rejects.toThrow('caller stopped')
    const survivor = f.service.inspect()
    await vi.waitFor(() => expect(f.run).toHaveBeenCalledTimes(2))
    controller.abort(new Error('caller stopped'))
    await rejection
    gate.resolve(pythonOutput)
    expect((await survivor).python?.status).toBe('available')
    expect(f.run).toHaveBeenCalledTimes(2)
    const alreadyStopped = new AbortController()
    alreadyStopped.abort(new Error('already stopped'))
    await expect(f.service.inspect(alreadyStopped.signal)).rejects.toThrow('already stopped')
  })

  it.each(['docker', 'restricted-files', 'unknown'])('never examines or spawns host programs in %s runtime', async runtime => {
    const f = fixture()
    f.env.AETHER_WORKSPACE_RUNTIME = runtime
    expect(await f.service.inspect()).toMatchObject({ status: 'unavailable', python: null, office: { conversionVerified: false } })
    expect(f.realpath).not.toHaveBeenCalled()
    expect(f.run).not.toHaveBeenCalled()
  })

  it('refuses host discovery for authenticated deployments', async () => {
    const f = fixture()
    f.env.AUTH_ENABLED = 'true'; f.env.AETHER_WORKSPACE_RUNTIME = 'host'
    expect((await f.service.inspect()).status).toBe('unavailable')
    expect(f.run).not.toHaveBeenCalled()
  })

  it('runs fixed isolated scripts with bounded hidden processes and an allowlisted environment', async () => {
    const f = fixture()
    await f.service.inspect()
    const pythonCall = f.run.mock.calls.find(([binary]) => binary === python)!
    expect(pythonCall[1].slice(0, 3)).toEqual(['-I', '-B', '-c'])
    expect(pythonCall[1][3]).not.toContain('pip')
    for (const [binary, , options] of f.run.mock.calls) {
      expect(options).toMatchObject({ cwd: path.win32.dirname(binary), timeout: 3500, maxBuffer: 32768, windowsHide: true })
      expect(options.env).not.toHaveProperty('MODEL_API_KEY')
      expect(options.env).not.toHaveProperty('PYTHONPATH')
      expect(options.env).not.toHaveProperty('PYTHONSTARTUP')
      expect(options.env.PYTHONNOUSERSITE).toBe('1')
      expect(options.env.PATH).toBe(path.win32.dirname(binary))
    }
    const comCall = f.run.mock.calls.find(([binary]) => binary === powershell)!
    expect(comCall[1].slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-Command'])
    expect(comCall[1][3]).toContain('OpenSubKey')
    expect(comCall[1][3]).not.toMatch(/New-Object|CreateInstance|Start-Process|taskkill|\.Quit/)
  })

  it('finds local Python manager installs without executing WindowsApps aliases or workspace PATH programs', async () => {
    const f = fixture(), installed = f.env.LOCALAPPDATA! + '\\Python\\pythoncore-3.15-64\\python.exe'
    f.files.delete(key(python)); f.files.add(key(installed))
    f.env.PATH = ['.', 'D:\\other-task', f.env.LOCALAPPDATA! + '\\Microsoft\\WindowsApps'].join(';')
    f.directories.mockImplementation(async value => value.endsWith('\\Python') ? ['pythoncore-3.15-64'] : [])
    expect((await f.service.inspect()).python).toMatchObject({ path: installed, source: 'standard-installation', status: 'available' })
    expect(f.run.mock.calls.map(([binary]) => binary).sort()).toEqual([installed, powershell].sort())
    expect(f.directories.mock.calls.every(([directory]) => f.roots.includes(directory))).toBe(true)
  })

  it.each(['D:\\tasks\\python.exe', 'C:\\Program Files\\.codex\\python.exe',
    'C:\\Program Files\\codex-runtimes\\python.exe', '\\\\remote\\share\\python.exe'])('does not execute untrusted explicit interpreter %s or fall back', async configured => {
    const f = fixture()
    f.env.AETHER_OFFICE_PYTHON = configured; f.files.add(key(configured))
    expect((await f.service.inspect()).python).toBeNull()
    expect(f.run.mock.calls.map(([binary]) => binary)).toEqual([powershell])
  })

  it('rejects interpreter symlinks and installation-root redirects outside trusted roots', async () => {
    const f = fixture()
    f.aliases.set(key(python), 'D:\\other-task\\python.exe')
    f.files.add(key('D:\\other-task\\python.exe'))
    expect((await f.service.inspect()).python).toBeNull()
    const redirected = fixture()
    redirected.aliases.set(key(redirected.env.ProgramFiles!), 'D:\\other-task')
    expect((await redirected.service.inspect()).python).toBeNull()
    expect(redirected.run.mock.calls.map(([binary]) => binary)).toEqual([powershell])
  })

  it('admits an explicit operator installation root without admitting private app runtimes', async () => {
    const f = fixture(), installed = 'D:\\AetherRuntime\\python.exe'
    f.roots.push('D:\\AetherRuntime'); f.files.add(key(installed))
    f.env.AETHER_OFFICE_RUNTIME_ROOT = 'D:\\AetherRuntime'; f.env.AETHER_OFFICE_PYTHON = installed
    expect((await f.service.inspect()).python).toMatchObject({ path: installed, source: 'configured', status: 'available' })
  })

  it('keeps probe failures bounded and descriptive without leaking raw process output', async () => {
    const f = fixture()
    f.run.mockRejectedValue(new Error('spawn failed MODEL_API_KEY=never-pass-or-print'))
    const result = await f.service.inspect()
    expect(result.python).toMatchObject({ status: 'probe-failed', reason: expect.stringContaining('超时或失败') })
    expect(result.office.registryStatus).toBe('unavailable')
    expect(JSON.stringify(result)).not.toContain('never-pass-or-print')
  })

  it.each(['x'.repeat(32769), '{broken', JSON.stringify({ version: '3.15.0', packages: [] })])('rejects malformed or oversized Python evidence', async output => {
    const f = fixture()
    f.run.mockImplementation(async binary => binary === python ? output : '[]')
    expect((await f.service.inspect()).python?.status).toBe('probe-failed')
  })

  it('reports WPS-compatible COM and soffice as candidates without claiming actual conversion', async () => {
    const f = fixture(), soffice = 'C:\\Program Files\\LibreOffice\\program\\soffice.exe'
    f.files.add(key(soffice))
    const com = ['Word.Application', 'Excel.Application', 'PowerPoint.Application', 'KWps.Application', 'Ket.Application', 'KWpp.Application']
      .map(progId => ({ progId, view: 'Registry64', serverPath: 'C:\\Program Files\\WPS\\wps.exe', serverExists: true }))
    // Windows filesystem canonicalization may change letter case without being a redirection.
    f.aliases.set(key(powershell), powershell.toLowerCase())
    f.run.mockImplementation(async binary => key(binary) === key(powershell) ? JSON.stringify(com) : pythonOutput)
    const result = await f.service.inspect()
    expect(result.office).toEqual({ com, registryStatus: 'checked', libreOfficePath: soffice, conversionVerified: false })
    expect(f.run.mock.calls.map(([binary]) => binary)).not.toContain(soffice)
  })

  it.each([null, [], { path: python }, { install: true }])('rejects all caller-selected programs and installation arguments', async args => {
    const result = await officeEnvironmentTool.execute(args, {} as AgentContext)
    expect(result).toMatchObject({ success: false, error: 'OFFICE_ENVIRONMENT_INVALID_ARGUMENTS' })
  })
})
