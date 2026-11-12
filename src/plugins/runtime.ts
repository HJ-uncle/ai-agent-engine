import path from 'node:path'
import fs from 'node:fs'
import { spawn } from 'node:child_process'
import { stopCommandProcessTree } from '../core/command-jobs/process-tree.js'
import { validatePluginPath } from './service.js'
import { validatePluginArguments } from './schema.js'
import { PluginError, type PluginArtifact, type PluginRunOptions, type PluginRunResult, type PluginSnapshot } from './types.js'

const active = new Map<string, number>()
const MAX_CONCURRENT = 4
function object(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === 'object' && !Array.isArray(value)) }
function limit(value: number | undefined, fallback: number, maximum: number): number {
  const result = value ?? fallback
  if (!Number.isSafeInteger(result) || result < 1 || result > maximum) throw new PluginError('PLUGIN_LIMIT', '插件运行限额无效')
  return result
}
function minimalEnvironment(): NodeJS.ProcessEnv {
  // No NODE_OPTIONS, API keys, proxy credentials or application secrets cross this boundary.
  const names = process.platform === 'win32' ? ['SystemRoot', 'WINDIR', 'TEMP', 'TMP'] : ['TMPDIR', 'LANG', 'LC_ALL']
  const environment = Object.fromEntries(names.flatMap(name => process.env[name] === undefined ? [] : [[name, process.env[name]!]]))
  // The desktop development host runs the engine with electron.exe in Node mode.
  // Its child must keep that launch mode or Electron consumes/closes the stdin pipe.
  // This is a host-selected runtime switch, never a copied user/plugin environment.
  if (process.versions.electron) environment.ELECTRON_RUN_AS_NODE = '1'
  return environment
}
function parseArtifacts(value: unknown): PluginArtifact[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 16) throw new PluginError('PLUGIN_ARTIFACTS', '插件产物列表无效')
  let total = 0
  return value.map(item => {
    if (!object(item) || Object.keys(item).some(key => !['path', 'content', 'encoding'].includes(key)) || typeof item.path !== 'string' || typeof item.content !== 'string' || item.encoding !== undefined && !['utf8', 'base64'].includes(String(item.encoding))) throw new PluginError('PLUGIN_ARTIFACTS', '插件产物格式无效')
    validatePluginPath(item.path)
    const encoding = item.encoding as PluginArtifact['encoding']
    if (encoding === 'base64' && (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(item.content))) throw new PluginError('PLUGIN_ARTIFACTS', '插件产物 Base64 无效')
    total += encoding === 'base64' ? Buffer.byteLength(item.content, 'base64') : Buffer.byteLength(item.content)
    if (total > 2 * 1024 * 1024) throw new PluginError('PLUGIN_ARTIFACTS', '插件产物超过总大小限制')
    return { path: item.path, content: item.content, ...(encoding === undefined ? {} : { encoding }) }
  })
}

/** Only the documented error envelope is a failure; result values remain arbitrary business data. */
function reportedError(value: unknown): string | undefined {
  if (!object(value) || Object.hasOwn(value, 'result') || !Object.hasOwn(value, 'error')) return undefined
  const error = value.error
  if (typeof error === 'string') return (error || '插件报告错误').slice(0, 4000)
  if (object(error) && typeof error.message === 'string') {
    const code = typeof error.code === 'string' || typeof error.code === 'number' ? '[' + String(error.code).slice(0, 128) + '] ' : ''
    return (code + (error.message || '插件报告错误')).slice(0, 4000)
  }
  return undefined
}

/** A cancellable process boundary, not an operating-system filesystem or network sandbox. */
export async function runPlugin(snapshot: PluginSnapshot, toolName: string, args: unknown, options: PluginRunOptions = {}): Promise<PluginRunResult> {
  const tool = snapshot.manifest.tools.find(item => item.name === toolName)
  if (!tool) throw new PluginError('PLUGIN_TOOL', '插件工具不存在', 404)
  validatePluginPath(tool.entry)
  const entry = path.resolve(snapshot.directory, tool.entry)
  if (!entry.startsWith(path.resolve(snapshot.directory) + path.sep) || !entry.endsWith('.mjs')) throw new PluginError('PLUGIN_ENTRY', '插件入口越界')
  if (fs.lstatSync(entry).isSymbolicLink() || !fs.statSync(entry).isFile()) throw new PluginError('PLUGIN_ENTRY', '插件入口不是普通文件')
  if (options.signal?.aborted) throw new PluginError('PLUGIN_CANCELLED', '插件运行已取消', 409)
  const timeoutMs = limit(options.timeoutMs, 60_000, 300_000)
  const maxInputBytes = limit(options.maxInputBytes, 256 * 1024, 1024 * 1024)
  const maxOutputBytes = limit(options.maxOutputBytes, 2 * 1024 * 1024, 8 * 1024 * 1024)
  const maxStderrBytes = limit(options.maxStderrBytes, 256 * 1024, 1024 * 1024)
  let input: string
  try { input = JSON.stringify({ tool: toolName, args }) + '\n' }
  catch { throw new PluginError('PLUGIN_INPUT', '插件输入必须是 JSON') }
  if (Buffer.byteLength(input) > maxInputBytes) throw new PluginError('PLUGIN_INPUT_LIMIT', '插件输入超过大小限制')
  // Validate exactly the JSON bytes the child receives, without coercion, defaults or mutation.
  validatePluginArguments(tool.inputSchema, JSON.parse(input).args)
  const scope = options.tenantId ?? snapshot.tenantId ?? snapshot.directory
  if ((active.get(scope) ?? 0) >= MAX_CONCURRENT) throw new PluginError('PLUGIN_BUSY', '当前租户插件并发已达上限，请稍后重试', 429)
  active.set(scope, (active.get(scope) ?? 0) + 1)
  const startedAt = Date.now()
  try {
    return await new Promise<PluginRunResult>((resolve, reject) => {
      const child = spawn(process.execPath, ['--max-old-space-size=128', '--disable-proto=throw', '--no-addons', entry], {
        cwd: options.cwd ?? snapshot.directory, env: minimalEnvironment(), windowsHide: true,
        detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'],
      })
      const stdout: Buffer[] = [], stderr: Buffer[] = []
      let stdoutBytes = 0, stderrBytes = 0, failure: Error | undefined, stopping: Promise<void> | undefined, settled = false
      const dispose = () => { clearTimeout(timer); options.signal?.removeEventListener('abort', aborted) }
      const finish = async (code: number | null) => {
        if (settled) return
        settled = true; dispose()
        try {
          await stopping
          if (failure) throw failure
          const errors = Buffer.concat(stderr).toString('utf8')
          const line = Buffer.concat(stdout).toString('utf8').trim().split(/\r?\n/).at(-1)
          let parsed: unknown, validJson = false
          if (line) { try { parsed = JSON.parse(line); validJson = true } catch { /* Exit failures may still carry stderr. */ } }
          const explicitError = reportedError(parsed)
          if (code !== 0) {
            const details = [explicitError, errors ? errors.slice(-4000) : undefined].filter(Boolean).join('\n').slice(0, 4000)
            throw new PluginError('PLUGIN_EXIT', '插件进程退出（' + (code ?? 'signal') + '）' + (details ? ': ' + details : ''))
          }
          if (!line) throw new PluginError('PLUGIN_OUTPUT', '插件没有返回 JSON 结果')
          if (!validJson) throw new PluginError('PLUGIN_OUTPUT', '插件最后一行不是有效 JSON')
          if (explicitError !== undefined) throw new PluginError('PLUGIN_REPORTED_ERROR', '插件报告错误：' + explicitError)
          const envelope = object(parsed) && Object.hasOwn(parsed, 'result') ? parsed : undefined
          resolve({ result: envelope ? envelope.result : parsed, artifacts: envelope ? parseArtifacts(envelope.artifacts) : [],
            stderr: errors, durationMs: Date.now() - startedAt })
        } catch (error) { reject(error) }
      }
      const stop = (error: Error) => {
        if (settled || stopping) return
        failure = error
        stopping = stopCommandProcessTree(child, startedAt).catch(cleanup => {
          failure = new PluginError('PLUGIN_CLEANUP', `${error.message}；进程树清理失败：${String(cleanup)}`, 500)
          try { child.kill() } catch { /* The original process may already have exited. */ }
        })
        void stopping.then(() => {
          if (!settled && failure instanceof PluginError && failure.code === 'PLUGIN_CLEANUP') {
            child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy()
            void finish(child.exitCode)
          }
        })
      }
      const aborted = () => stop(new PluginError('PLUGIN_CANCELLED', '插件运行已取消', 409))
      const timer = setTimeout(() => stop(new PluginError('PLUGIN_TIMEOUT', `插件运行超过 ${timeoutMs}ms`)), timeoutMs)
      child.stdout.on('data', (chunk: Buffer) => {
        stdoutBytes += chunk.length
        if (stdoutBytes > maxOutputBytes) stop(new PluginError('PLUGIN_OUTPUT_LIMIT', '插件标准输出超过大小限制'))
        else stdout.push(chunk)
      })
      child.stderr.on('data', (chunk: Buffer) => {
        stderrBytes += chunk.length
        if (stderrBytes > maxStderrBytes) stop(new PluginError('PLUGIN_STDERR_LIMIT', '插件错误输出超过大小限制'))
        else stderr.push(chunk)
      })
      child.once('error', error => { failure = error })
      child.once('close', code => { void finish(code) })
      child.stdin.on('error', error => { if ((error as NodeJS.ErrnoException).code !== 'EPIPE') stop(error) })
      options.signal?.addEventListener('abort', aborted, { once: true })
      if (options.signal?.aborted) aborted()
      child.stdin.end(input)
    })
  } finally {
    const remaining = (active.get(scope) ?? 1) - 1
    if (remaining) active.set(scope, remaining); else active.delete(scope)
  }
}
