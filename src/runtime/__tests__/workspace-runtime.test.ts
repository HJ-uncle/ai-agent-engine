import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getWorkspaceRuntimeMode, WorkspaceRuntime, type WorkspaceExecutionRequest } from '../workspace-runtime.js'

const fixtureBase = path.resolve('.e2e-tmp')
const fixtures: string[] = []
function fixture(): string {
  fs.mkdirSync(fixtureBase, { recursive: true })
  const root = fs.mkdtempSync(path.join(fixtureBase, 'workspace-runtime-'))
  fixtures.push(root)
  return root
}
function request(root = fixture()): WorkspaceExecutionRequest {
  return { tenantId: 'tenant-a', userId: 'user-a', sessionId: 'session-a', workspaceRoot: root, cwd: root, command: 'node', args: ['--version'] }
}
const image = `aether/workspace@sha256:${'a'.repeat(64)}`
function dockerEnvironment(): NodeJS.ProcessEnv {
  return { AUTH_ENABLED: 'true', AETHER_WORKSPACE_RUNTIME: 'docker', AETHER_WORKSPACE_IMAGE: image,
    PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ENGINE_TOKEN: 'must-not-enter-container', OTHER_PRIVATE_VALUE: 'also-private' }
}
function fakeDocker() {
  let labels: Record<string, string> = {}
  const run = vi.fn(async (_binary: string, args: string[], _env: NodeJS.ProcessEnv): Promise<string> => {
    if (args[0] === 'info' || args[0] === 'image') return 'linux'
    if (args[0] === 'create') {
      labels = {}
      args.forEach((value, index) => { if (value === '--label') { const label = args[index + 1]; const delimiter = label.indexOf('='); labels[label.slice(0, delimiter)] = label.slice(delimiter + 1) } })
      return 'b'.repeat(64)
    }
    if (args[0] === 'inspect') return JSON.stringify(labels)
    if (args[0] === 'rm') return ''
    throw new Error(`Unexpected Docker request ${args[0]}`)
  })
  return { run, setLabels: (value: Record<string, string>) => { labels = value } }
}
afterEach(() => {
  for (const root of fixtures.splice(0)) {
    const relative = path.relative(fixtureBase, root)
    if (!relative.startsWith('workspace-runtime-') || relative.includes(path.sep)) throw new Error('Unsafe test cleanup path')
    fs.rmSync(root, { recursive: true, force: true })
  }
})

describe('workspace runtime boundary', () => {
  it('defaults authenticated/unspecified servers to restricted files and rejects host overrides', () => {
    expect(getWorkspaceRuntimeMode({})).toBe('restricted-files')
    expect(getWorkspaceRuntimeMode({ AUTH_ENABLED: 'true' })).toBe('restricted-files')
    expect(() => getWorkspaceRuntimeMode({ AETHER_WORKSPACE_RUNTIME: 'host' })).toThrow(/single-user/)
    expect(() => getWorkspaceRuntimeMode({ AETHER_WORKSPACE_RUNTIME: 'unknown' })).toThrow(/must be/)
  })
  it('does not launch external processes in restricted-file mode', async () => {
    const { run } = fakeDocker()
    await expect(new WorkspaceRuntime({}, run).prepareExecution(request())).rejects.toMatchObject({ code: 'WORKSPACE_EXECUTION_UNAVAILABLE' })
    expect(run).not.toHaveBeenCalled()
  })
  it('preserves explicit trusted single-user host execution without probing Docker', async () => {
    const { run } = fakeDocker()
    const input = request()
    input.env = { LOCAL_VALUE: 'local' }
    const plan = await new WorkspaceRuntime({ AUTH_ENABLED: 'false' }, run).prepareExecution(input)
    expect(plan).toMatchObject({ runtime: 'host', binary: 'node', args: ['--version'], env: { LOCAL_VALUE: 'local' } })
    expect(run).not.toHaveBeenCalled()
  })
  it('requires an immutable pre-provisioned image and never pulls', async () => {
    const { run } = fakeDocker()
    await expect(new WorkspaceRuntime({ ...dockerEnvironment(), AETHER_WORKSPACE_IMAGE: 'node:latest' }, run).prepareExecution(request())).rejects.toThrow(/immutable/)
    expect(run).not.toHaveBeenCalled()
  })
  it('builds a bounded container without host secrets and launches only its exact ID', async () => {
    const { run } = fakeDocker()
    const input = request()
    input.interactive = true
    const plan = await new WorkspaceRuntime(dockerEnvironment(), run).prepareExecution(input)
    const create = run.mock.calls.find(call => call[1][0] === 'create')!
    expect(create[1]).toEqual(expect.arrayContaining(['--pull=never', '--network=none', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--user=10001:10001', '--pids-limit=256', '--memory=1g', '--memory-swap=1g', '--cpus=2', '--tty', '--mount', `type=bind,source=${input.workspaceRoot},target=/workspace`, '--entrypoint', 'node', image, '--version']))
    expect(create[1].filter(arg => arg === '--mount')).toHaveLength(1)
    expect(JSON.stringify(create)).not.toContain('must-not-enter-container')
    expect(JSON.stringify(create)).not.toContain('also-private')
    expect(plan.args).toEqual(['start', '--attach', '--interactive', 'b'.repeat(64)])
    expect(plan.containerName).toMatch(/^aether-exec-[a-f0-9-]+$/)
    await plan.cleanup()
    expect(run.mock.calls.at(-1)?.[1]).toEqual(['rm', '--force', plan.containerName])
  })
  it('keeps attempted Docker flags and shell metacharacters as container command arguments', async () => {
    const { run } = fakeDocker()
    const input = request()
    input.args = ['--privileged', '--mount=type=bind,source=/,target=/host', '; touch /outside', '$(id)']
    await new WorkspaceRuntime(dockerEnvironment(), run).prepareExecution(input)
    const create = run.mock.calls.find(call => call[1][0] === 'create')![1]
    expect(create.slice(create.indexOf(image) + 1)).toEqual(input.args)
    expect(create.slice(0, create.indexOf(image))).not.toContain('--privileged')
  })
  it('maps only contained cwd to a Linux virtual path', async () => {
    const { run } = fakeDocker()
    const input = request()
    input.cwd = path.join(input.workspaceRoot, 'nested', 'project')
    fs.mkdirSync(input.cwd, { recursive: true })
    await new WorkspaceRuntime(dockerEnvironment(), run).prepareExecution(input)
    const create = run.mock.calls.find(call => call[1][0] === 'create')![1]
    expect(create[create.indexOf('--workdir') + 1]).toBe('/workspace/nested/project')
    await expect(new WorkspaceRuntime(dockerEnvironment(), run).prepareExecution({ ...input, cwd: fixture() })).rejects.toThrow(/outside/)
  })
  it('rejects mount punctuation, filesystem roots, executable control characters and host executable paths', async () => {
    const { run } = fakeDocker()
    const runtime = new WorkspaceRuntime(dockerEnvironment(), run)
    const input = request()
    await expect(runtime.prepareExecution({ ...input, workspaceRoot: input.workspaceRoot + ',target=/host' })).rejects.toThrow(/commas/)
    await expect(runtime.prepareExecution({ ...input, workspaceRoot: path.parse(input.workspaceRoot).root })).rejects.toThrow(/filesystem root/)
    await expect(runtime.prepareExecution({ ...input, command: 'node\n--privileged' })).rejects.toThrow(/invalid/)
    await expect(runtime.prepareExecution({ ...input, command: 'C:\\Windows\\cmd.exe' })).rejects.toThrow(/Linux executable/)
    expect(run).not.toHaveBeenCalled()
  })
  it('rejects a junction/symlink mount source before Docker is contacted', async () => {
    const { run } = fakeDocker()
    const root = fixture()
    const actual = path.join(root, 'actual')
    const link = path.join(root, 'redirected')
    fs.mkdirSync(actual)
    fs.symlinkSync(actual, link, process.platform === 'win32' ? 'junction' : 'dir')
    await expect(new WorkspaceRuntime(dockerEnvironment(), run).prepareExecution(request(link))).rejects.toThrow(/symbolic link|junction/)
    expect(run).not.toHaveBeenCalled()
  })
  it('fails closed if Docker is absent and never creates or chooses a host fallback', async () => {
    const run = vi.fn(async (): Promise<string> => { throw Object.assign(new Error('spawn docker ENOENT'), { code: 'ENOENT' }) })
    await expect(new WorkspaceRuntime(dockerEnvironment(), run).prepareExecution(request())).rejects.toMatchObject({ code: 'WORKSPACE_EXECUTION_UNAVAILABLE' })
    expect(run).toHaveBeenCalledTimes(1)
  })
  it('rejects Windows daemons and missing/non-Linux images', async () => {
    const run = vi.fn(async (_binary: string, args: string[]): Promise<string> => args[0] === 'info' ? 'windows' : 'linux')
    await expect(new WorkspaceRuntime(dockerEnvironment(), run).prepareExecution(request())).rejects.toThrow(/Linux container/)
    const badImage = vi.fn(async (_binary: string, args: string[]): Promise<string> => args[0] === 'image' ? 'windows' : 'linux')
    await expect(new WorkspaceRuntime(dockerEnvironment(), badImage).prepareExecution(request())).rejects.toThrow(/Linux image/)
    expect(badImage.mock.calls.some(call => call[1][0] === 'create')).toBe(false)
  })
  it('refuses to remove a container if its private ownership labels changed', async () => {
    const docker = fakeDocker()
    const plan = await new WorkspaceRuntime(dockerEnvironment(), docker.run).prepareExecution(request())
    docker.setLabels({ 'io.aether.managed': 'true', 'io.aether.scope': 'different' })
    await expect(plan.cleanup()).rejects.toMatchObject({ code: 'WORKSPACE_CLEANUP_OWNERSHIP' })
    expect(docker.run.mock.calls.some(call => call[1][0] === 'rm')).toBe(false)
  })
  it('treats already removed containers as clean but propagates daemon/permission failures', async () => {
    const docker = fakeDocker()
    const plan = await new WorkspaceRuntime(dockerEnvironment(), docker.run).prepareExecution(request())
    docker.run.mockRejectedValueOnce(Object.assign(new Error('gone'), { stderr: 'Error: No such container' }))
    await expect(plan.cleanup()).resolves.toBeUndefined()
    docker.run.mockRejectedValueOnce(new Error('permission denied'))
    await expect(plan.cleanup()).rejects.toThrow('permission denied')
    await plan.cleanup()
    expect(docker.run.mock.calls.at(-1)?.[1][0]).toBe('rm')
  })
  it('assigns different process identities even for the same tenant and workspace', async () => {
    const docker = fakeDocker()
    const runtime = new WorkspaceRuntime(dockerEnvironment(), docker.run)
    const input = request()
    const first = await runtime.prepareExecution(input)
    const second = await runtime.prepareExecution(input)
    expect(first.containerName).not.toBe(second.containerName)
  })
})
