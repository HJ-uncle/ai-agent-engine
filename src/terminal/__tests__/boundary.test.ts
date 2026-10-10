import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

const mock = vi.hoisted(() => ({
  fake: { write: vi.fn(), resize: vi.fn(), kill: vi.fn(), onData: vi.fn(), onExit: vi.fn() },
  prepare: vi.fn(),
  mode: vi.fn(() => 'restricted-files'),
}))
vi.mock('node-pty', () => ({ spawn: vi.fn(() => mock.fake) }))
vi.mock('../../runtime/workspace-runtime.js', () => ({ getWorkspaceRuntimeMode: mock.mode, prepareWorkspaceExecution: mock.prepare }))
const { terminalManager } = await import('../index.js')
const pty = await import('node-pty')

describe('terminal resource boundary', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    mock.fake.kill.mockImplementation(() => {
      const onExit = mock.fake.onExit.mock.calls.at(-1)?.[0] as ((event: { exitCode: number }) => void) | undefined
      onExit?.({ exitCode: 0 })
    })
    await terminalManager.killAll()
    mock.mode.mockReturnValue('restricted-files')
  })
  afterEach(async () => { await terminalManager.killAll() })
  it('fails closed for a missing cwd and bounds input/resize', async () => {
    await expect(terminalManager.create('t1', 'Z:/path-that-does-not-exist', 120, 30, [], { tenantId: 'a' })).rejects.toThrow('does not exist')
    const cwd = process.cwd()
    const session = await terminalManager.create('t2', cwd, 120, 30, [cwd], { tenantId: 'a', userId: 'u' })
    expect(session.tenantId).toBe('a')
    expect(terminalManager.write('t2', 'ok')).toBe(true)
    expect(terminalManager.write('t2', 'x'.repeat(64 * 1024 + 1))).toBe(false)
    expect(terminalManager.resize('t2', 0, 30)).toBe(false)
    expect(terminalManager.resize('t2', 120, 30)).toBe(true)
  })
  it('does not launch a host terminal when the configured Docker runtime is unavailable', async () => {
    mock.mode.mockReturnValue('docker')
    mock.prepare.mockRejectedValueOnce(new Error('isolated runtime unavailable'))
    await expect(terminalManager.create('docker-failed', process.cwd(), 120, 30, [process.cwd()], { tenantId: 'a', userId: 'u', sessionId: 'root-session' })).rejects.toThrow(/unavailable/)
    expect(pty.spawn).not.toHaveBeenCalled()
  })
  it('starts the prepared isolated shell and awaits owned container removal on kill', async () => {
    mock.mode.mockReturnValue('docker')
    const cleanup = vi.fn(async () => {})
    mock.prepare.mockResolvedValueOnce({ runtime: 'docker', binary: 'docker.exe', args: ['start', '--attach', 'container-id'], cwd: process.cwd(), env: { PATH: 'operator-path' }, cleanup })
    const session = await terminalManager.create('docker-ok', process.cwd(), 120, 30, [process.cwd()], { tenantId: 'a', userId: 'u', sessionId: 'root-session' })
    expect(mock.prepare).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 'a', userId: 'u', sessionId: 'root-session', command: '/bin/bash', args: ['--noprofile', '--norc'], interactive: true }))
    expect(pty.spawn).toHaveBeenCalledWith('docker.exe', ['start', '--attach', 'container-id'], expect.objectContaining({ env: { PATH: 'operator-path' } }))
    expect(session.title).toBe('isolated-linux')
    await terminalManager.kill('docker-ok')
    expect(cleanup).toHaveBeenCalledOnce()
    expect(mock.fake.kill).toHaveBeenCalledOnce()
    expect(terminalManager.get('docker-ok')).toBeUndefined()
    const onExit = mock.fake.onExit.mock.calls.at(-1)?.[0] as ((event: { exitCode: number }) => void)
    onExit({ exitCode: 0 })
  })
  it('waits for and cancels a Docker create already in progress during shutdown', async () => {
    mock.mode.mockReturnValue('docker')
    const cleanup = vi.fn(async () => {})
    let ready!: (value: unknown) => void
    mock.prepare.mockReturnValueOnce(new Promise(resolve => { ready = resolve }))
    const creation = terminalManager.create('pending-stop', process.cwd())
    const rejected = expect(creation).rejects.toThrow(/cancelled/)
    const shutdown = terminalManager.killAll()
    ready({ runtime: 'docker', binary: 'docker.exe', args: ['start', 'pending-container'], cwd: process.cwd(), env: {}, cleanup })
    await rejected
    await shutdown
    expect(cleanup).toHaveBeenCalledOnce()
    expect(pty.spawn).not.toHaveBeenCalled()
  })
  it('reports cleanup failure rather than pretending the container stopped', async () => {
    mock.mode.mockReturnValue('docker')
    const cleanup = vi.fn(async () => {}).mockRejectedValueOnce(new Error('daemon unavailable'))
    mock.prepare.mockResolvedValueOnce({ runtime: 'docker', binary: 'docker.exe', args: ['start', 'container-id'], cwd: process.cwd(), env: {}, cleanup })
    await terminalManager.create('cleanup-failed', process.cwd())
    await expect(terminalManager.kill('cleanup-failed')).rejects.toThrow(/daemon unavailable/)
    expect(terminalManager.get('cleanup-failed')).toBeDefined()
    await terminalManager.kill('cleanup-failed')
  })
  it('rejects a duplicate id and invalid dimensions before opening another PTY', async () => {
    await terminalManager.create('unique', process.cwd())
    await expect(terminalManager.create('unique', process.cwd())).rejects.toThrow(/already exists/)
    await expect(terminalManager.create('invalid', process.cwd(), -1, 30)).rejects.toThrow(/dimensions/)
    expect(pty.spawn).toHaveBeenCalledOnce()
  })

  it('merges concurrent close requests and waits for the PTY exit event', async () => {
    let kills = 0
    let exit!: (event: { exitCode: number }) => void
    mock.fake.kill.mockImplementation(() => { kills++ })
    mock.fake.onExit.mockImplementation(listener => { exit = listener })
    await terminalManager.create('close-once', process.cwd())
    const first = terminalManager.kill('close-once')
    const second = terminalManager.kill('close-once')
    await Promise.resolve()
    expect(kills).toBe(1)
    let settled = false
    void first.then(() => { settled = true })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(settled).toBe(false)
    exit({ exitCode: 0 })
    await Promise.all([first, second])
    expect(terminalManager.get('close-once')).toBeUndefined()
  })
})
