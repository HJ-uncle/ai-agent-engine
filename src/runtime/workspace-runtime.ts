import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'

export type WorkspaceRuntimeMode = 'restricted-files' | 'docker' | 'host'

export interface WorkspaceExecutionRequest {
  tenantId: string
  sessionId: string
  userId?: string
  workspaceRoot: string
  cwd: string
  command: string
  args: string[]
  interactive?: boolean
  /** Used only by explicitly enabled, unauthenticated single-user host execution. */
  env?: NodeJS.ProcessEnv
}

export interface WorkspaceExecutionPlan {
  binary: string
  args: string[]
  cwd: string
  env: NodeJS.ProcessEnv
  runtime: 'docker' | 'host'
  containerName?: string
  /** Kill the owned container as well as its CLI. Safe to call again after CLI close. */
  cleanup(): Promise<void>
}

export type DockerCommandRunner = (binary: string, args: string[], env: NodeJS.ProcessEnv) => Promise<string>
const execFileAsync = promisify(execFile)
const runDockerCommand: DockerCommandRunner = async (binary, args, env) => {
  const result = await execFileAsync(binary, args, { env, encoding: 'utf8', windowsHide: true, timeout: 15_000, maxBuffer: 1024 * 1024 })
  return result.stdout.trim()
}

function failure(code: string, message: string): Error {
  return Object.assign(new Error(message), { code })
}

/** Approval mode never selects an execution boundary. Only operator configuration can. */
export function getWorkspaceRuntimeMode(env: NodeJS.ProcessEnv = process.env): WorkspaceRuntimeMode {
  const value = env.AETHER_WORKSPACE_RUNTIME ?? (env.AUTH_ENABLED === 'false' ? 'host' : 'restricted-files')
  if (value !== 'host' && value !== 'docker' && value !== 'restricted-files') {
    throw failure('WORKSPACE_RUNTIME_CONFIG', 'AETHER_WORKSPACE_RUNTIME must be restricted-files, docker, or host')
  }
  if (value === 'host' && env.AUTH_ENABLED !== 'false') {
    throw failure('WORKSPACE_RUNTIME_CONFIG', 'Host execution is only available with AUTH_ENABLED=false in a trusted single-user instance')
  }
  return value
}

/** The Docker CLI is trusted control-plane code, but unrelated service secrets are unnecessary. */
function controlEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const allow = new Set(['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP',
    'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'LANG', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG',
    'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH'])
  return Object.fromEntries(Object.entries(source).filter(([key, value]) => allow.has(key) && value !== undefined))
}

function scopePart(value: string | undefined, name: string, optional = false): void {
  if (optional && value === undefined) return
  if (!value || value.length > 128 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw failure('WORKSPACE_EXECUTION_INVALID', `${name} is invalid`)
  }
}

function contained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep))
}

/** A mount source must never be a junction or a path containing a redirected ancestor. */
function actualDirectory(value: string, name: string): string {
  if (!value || !path.isAbsolute(value) || /[,\u0000-\u001f\u007f]/.test(value)) {
    throw failure('WORKSPACE_EXECUTION_INVALID', `${name} must be an absolute directory without control characters or commas`)
  }
  const absolute = path.resolve(value)
  if (absolute === path.parse(absolute).root) throw failure('WORKSPACE_EXECUTION_INVALID', `${name} cannot be a filesystem root`)
  let current = path.parse(absolute).root
  for (const part of path.relative(current, absolute).split(path.sep)) {
    current = path.join(current, part)
    const stat = fs.lstatSync(current)
    if (stat.isSymbolicLink()) throw failure('WORKSPACE_EXECUTION_INVALID', `${name} contains a symbolic link or junction`)
  }
  if (!fs.statSync(absolute).isDirectory()) throw failure('WORKSPACE_EXECUTION_INVALID', `${name} must be a directory`)
  const canonical = fs.realpathSync.native(absolute)
  if (process.platform === 'win32' ? canonical.toLowerCase() !== absolute.toLowerCase() : canonical !== absolute) {
    throw failure('WORKSPACE_EXECUTION_INVALID', `${name} resolves through a filesystem redirection`)
  }
  return canonical
}

function missingContainer(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const record = error as { stderr?: unknown; message?: unknown }
  return /no such (?:object|container)/i.test(String(record.stderr ?? record.message ?? ''))
}

/**
 * One disposable container per process keeps cancellation precise. Only /workspace
 * persists across terminals/jobs; the immutable system image is shared by digest.
 * This is container isolation (shared kernel), not a microVM security claim.
 */
export class WorkspaceRuntime {
  constructor(private readonly environment: NodeJS.ProcessEnv = process.env, private readonly run: DockerCommandRunner = runDockerCommand) {}

  async prepareExecution(request: WorkspaceExecutionRequest): Promise<WorkspaceExecutionPlan> {
    const mode = getWorkspaceRuntimeMode(this.environment)
    if (mode === 'restricted-files') {
      throw failure('WORKSPACE_EXECUTION_UNAVAILABLE', 'This server currently provides a restricted file terminal. External commands require an operator-configured isolated runtime; host execution is disabled.')
    }
    scopePart(request.tenantId, 'tenantId')
    scopePart(request.sessionId, 'sessionId')
    scopePart(request.userId, 'userId', true)
    if (!request.command || request.command.startsWith('-') || /[\u0000-\u001f\u007f]/.test(request.command) ||
      !Array.isArray(request.args) || request.args.some(arg => typeof arg !== 'string' || arg.includes('\0'))) {
      throw failure('WORKSPACE_EXECUTION_INVALID', 'Command or argument vector is invalid')
    }
    if (mode === 'host') {
      return { runtime: 'host', binary: request.command, args: [...request.args], cwd: request.cwd,
        env: { ...(request.env ?? this.environment) }, cleanup: async () => {} }
    }

    const root = actualDirectory(request.workspaceRoot, 'workspaceRoot')
    const cwd = actualDirectory(request.cwd, 'cwd')
    if (!contained(root, cwd)) throw failure('WORKSPACE_EXECUTION_INVALID', 'cwd is outside this execution workspace')
    if (/^[A-Za-z]:|\\/.test(request.command)) throw failure('WORKSPACE_EXECUTION_INVALID', 'Docker commands use Linux executable names or container paths')
    const image = this.environment.AETHER_WORKSPACE_IMAGE ?? ''
    if (!/^(?:[a-zA-Z0-9][a-zA-Z0-9._:/-]*@)?sha256:[a-f0-9]{64}$/.test(image)) {
      throw failure('WORKSPACE_RUNTIME_CONFIG', 'AETHER_WORKSPACE_IMAGE must be an immutable image digest (name@sha256:...) or a local sha256 image ID')
    }
    const binary = this.environment.AETHER_DOCKER_BINARY || (process.platform === 'win32' ? 'docker.exe' : 'docker')
    if (/[\u0000-\u001f\u007f]/.test(binary)) throw failure('WORKSPACE_RUNTIME_CONFIG', 'AETHER_DOCKER_BINARY is invalid')
    const env = controlEnvironment(this.environment)
    try {
      if ((await this.run(binary, ['info', '--format', '{{.OSType}}'], env)).trim() !== 'linux') {
        throw new Error('A Linux container runtime is required')
      }
      if ((await this.run(binary, ['image', 'inspect', image, '--format', '{{.Os}}'], env)).trim() !== 'linux') {
        throw new Error('The configured local image must be a Linux image')
      }
    } catch (error) {
      throw failure('WORKSPACE_EXECUTION_UNAVAILABLE', `Isolated runtime is unavailable; no host fallback was used: ${error instanceof Error ? error.message : String(error)}`)
    }

    const executionId = randomUUID()
    const containerName = `aether-exec-${executionId}`
    const scope = createHash('sha256').update(JSON.stringify([request.tenantId, request.userId ?? '', request.sessionId, root])).digest('hex')
    const relative = path.relative(root, cwd).split(path.sep).join('/')
    const containerCwd = relative ? `/workspace/${relative}` : '/workspace'
    const createArgs = ['create', '--rm', '--pull=never', '--name', containerName,
      '--label', 'io.aether.managed=true', '--label', `io.aether.scope=${scope}`, '--label', `io.aether.execution=${executionId}`,
      '--network=none', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges',
      '--user=10001:10001', '--pids-limit=256', '--memory=1g', '--memory-swap=1g', '--cpus=2',
      '--ulimit=nofile=1024:1024', '--init',
      '--tmpfs', '/tmp:rw,nosuid,nodev,noexec,size=128m,mode=1777',
      '--tmpfs', '/home/aether:rw,nosuid,nodev,size=256m,uid=10001,gid=10001,mode=0700',
      '--mount', `type=bind,source=${root},target=/workspace`, '--workdir', containerCwd,
      '--env', 'HOME=/home/aether', '--env', 'LANG=C.UTF-8', '--env', 'TERM=xterm-256color',
      '--interactive', ...(request.interactive ? ['--tty'] : []),
      '--entrypoint', request.command, image, ...request.args]
    let cleaning: Promise<void> | undefined
    const cleanup = async (): Promise<void> => {
      if (cleaning) return cleaning
      cleaning = (async () => {
        let raw: string
        try { raw = await this.run(binary, ['inspect', '--type', 'container', containerName, '--format', '{{json .Config.Labels}}'], env) }
        catch (error) { if (missingContainer(error)) return; throw error }
        const labels: unknown = JSON.parse(raw)
        if (!labels || typeof labels !== 'object' ||
          (labels as Record<string, unknown>)['io.aether.managed'] !== 'true' ||
          (labels as Record<string, unknown>)['io.aether.scope'] !== scope ||
          (labels as Record<string, unknown>)['io.aether.execution'] !== executionId) {
          throw failure('WORKSPACE_CLEANUP_OWNERSHIP', 'Refusing to remove a container whose ownership labels do not match')
        }
        try { await this.run(binary, ['rm', '--force', containerName], env) }
        catch (error) { if (!missingContainer(error)) throw error }
      })()
      try { await cleaning } finally { cleaning = undefined }
    }
    // Provision before returning a launch plan: killing a docker-run client
    // before its asynchronous create request completes can otherwise orphan a
    // container after cleanup has already observed "not found".
    let containerId: string
    try {
      containerId = (await this.run(binary, createArgs, env)).trim()
      if (!/^[a-f0-9]{64}$/.test(containerId)) throw new Error('Docker did not return a valid container ID')
    } catch (error) {
      await cleanup()
      throw failure('WORKSPACE_EXECUTION_UNAVAILABLE', `Could not provision the isolated process: ${error instanceof Error ? error.message : String(error)}`)
    }
    return { runtime: 'docker', binary, args: ['start', '--attach', '--interactive', containerId], cwd: root, env, containerName, cleanup }
  }
}

const runtime = new WorkspaceRuntime()
export function prepareWorkspaceExecution(request: WorkspaceExecutionRequest): Promise<WorkspaceExecutionPlan> {
  return runtime.prepareExecution(request)
}
