import path from 'node:path'
import fs from 'node:fs'
import { spawn } from 'node:child_process'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { stopCommandProcessTree } from '../core/command-jobs/process-tree.js'
import { validatePluginPath } from './service.js'
import { validatePluginArguments } from './schema.js'
import { nodePluginSdk } from './node-sdk.js'
import { PluginError, type PluginArtifact, type PluginRunOptions, type PluginRunResult, type PluginSnapshot } from './types.js'

function object(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === 'object' && !Array.isArray(value)) }
function limit(value: number | undefined): number {
  const result = value ?? 0
  if (!Number.isSafeInteger(result) || result < 0) throw new PluginError('PLUGIN_LIMIT', '插件运行限额无效')
  return result
}
/** Only materialize the result line, never all preceding stdout diagnostics. */
function lastJsonLine(filename: string): string {
  const fd = fs.openSync(filename, 'r'), buffer = Buffer.allocUnsafe(64 * 1024)
  try {
    let position = fs.fstatSync(fd).size, end = -1, start = 0, found = false
    while (position > 0 && !found) {
      const size = Math.min(buffer.length, position); position -= size
      fs.readSync(fd, buffer, 0, size, position)
      for (let index = size - 1; index >= 0; index--) {
        const byte = buffer[index]
        if (end < 0) {
          if (byte === 10 || byte === 13 || byte === 32 || byte === 9) continue
          end = position + index + 1
        }
        if (byte === 10) { start = position + index + 1; found = true; break }
      }
    }
    if (end < 0) return ''
    const result = Buffer.allocUnsafe(end - start)
    let read = 0
    while (read < result.length) { const count = fs.readSync(fd, result, read, result.length - read, start + read); if (!count) break; read += count }
    return result.subarray(0, read).toString('utf8').trim()
  } finally { fs.closeSync(fd) }
}
/** Diagnostics are a bounded preview, not an execution limit. */
function stderrPreview(filename: string): { stderr: string; stderrTruncated?: true } {
  const fd = fs.openSync(filename, 'r')
  try {
    const size = fs.fstatSync(fd).size, length = Math.min(size, 64 * 1024), buffer = Buffer.allocUnsafe(length)
    fs.readSync(fd, buffer, 0, length, size - length)
    return { stderr: buffer.toString('utf8'), ...(size > length ? { stderrTruncated: true as const } : {}) }
  } finally { fs.closeSync(fd) }
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
  if (!Array.isArray(value)) throw new PluginError('PLUGIN_ARTIFACTS', '插件产物列表无效')
  return value.map(item => {
    if (!object(item) || Object.keys(item).some(key => !['path', 'content', 'encoding'].includes(key)) || typeof item.path !== 'string' || typeof item.content !== 'string' || item.encoding !== undefined && !['utf8', 'base64'].includes(String(item.encoding))) throw new PluginError('PLUGIN_ARTIFACTS', '插件产物格式无效')
    validatePluginPath(item.path)
    const encoding = item.encoding as PluginArtifact['encoding']
    if (encoding === 'base64' && (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(item.content))) throw new PluginError('PLUGIN_ARTIFACTS', '插件产物 Base64 无效')
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
  const timeoutMs = limit(options.timeoutMs)
  const maxInputBytes = limit(options.maxInputBytes)
  const maxOutputBytes = limit(options.maxOutputBytes)
  const maxStderrBytes = limit(options.maxStderrBytes)
  const maxMemoryMb = limit(options.maxMemoryMb)
  let input: string
  try { input = JSON.stringify({ tool: toolName, args }) + '\n' }
  catch { throw new PluginError('PLUGIN_INPUT', '插件输入必须是 JSON') }
  if (maxInputBytes && Buffer.byteLength(input) > maxInputBytes) throw new PluginError('PLUGIN_INPUT_LIMIT', '插件输入超过调用方设置的大小限制')
  // Validate exactly the JSON bytes the child receives, without coercion, defaults or mutation.
  validatePluginArguments(tool.inputSchema, JSON.parse(input).args)
  const outputRoot = path.dirname(path.resolve(snapshot.directory))
  const spool = fs.mkdtempSync(path.join(outputRoot, '.plugin-output-'))
  const stdoutFile = path.join(spool, 'stdout'), stderrFile = path.join(spool, 'stderr')
  const startedAt = Date.now()
  try {
    return await new Promise<PluginRunResult>((resolve, reject) => {
      const sdk = options.capability ? ['--import', 'data:text/javascript;base64,' + Buffer.from(nodePluginSdk({ ...options.hostContext, sessionId: options.hostContext?.sessionId ?? null,
        workspacePath: options.hostContext?.workspacePath ?? null, pluginId: snapshot.id, revision: snapshot.revision })).toString('base64')] : []
      const child = spawn(process.execPath, [...(maxMemoryMb ? [`--max-old-space-size=${maxMemoryMb}`] : []), '--disable-proto=throw', '--no-addons', ...sdk, entry], {
        cwd: options.cwd ?? snapshot.directory, env: minimalEnvironment(), windowsHide: true,
        detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      })
      const { stdin: inputStream, stdout: outputStream, stderr: errorStream } = child
      if (!inputStream || !outputStream || !errorStream) { child.kill(); reject(new PluginError('PLUGIN_PIPE', '无法打开插件通信管道')); return }
      const capabilityAbort = new AbortController()
      const capabilitySignal = options.signal ? AbortSignal.any([options.signal, capabilityAbort.signal]) : capabilityAbort.signal
      const pendingCapabilities = new Set<string>()
      const capabilityControllers = new Map<string, AbortController>()
      const eventAcks = new Map<string, { sequence: number; resolve(): void }>()
      let failure: Error | undefined, stopping: Promise<void> | undefined, settled = false
      const counter = (maximum: number, code: string) => {
        let bytes = 0
        return new Transform({ transform(chunk: Buffer, _encoding, callback) {
          bytes += chunk.length
          callback(maximum && bytes > maximum ? new PluginError(code, '插件输出超过调用方设置的大小限制') : null, chunk)
        } })
      }
      // Pipe through ordinary stream backpressure to disk. Large logs do not build
      // an unbounded Buffer[] in the engine while the plugin is running.
      const outputs = Promise.all([
        pipeline(outputStream, counter(maxOutputBytes, 'PLUGIN_OUTPUT_LIMIT'), fs.createWriteStream(stdoutFile, { flags: 'wx' })),
        pipeline(errorStream, counter(maxStderrBytes, 'PLUGIN_STDERR_LIMIT'), fs.createWriteStream(stderrFile, { flags: 'wx' })),
      ].map(output => output.catch(error => { failure ??= error instanceof Error ? error : new Error('插件输出无法保存'); stop(failure) })))
      const dispose = () => { clearTimeout(timer); options.signal?.removeEventListener('abort', aborted); capabilityAbort.abort() }
      const finish = async (code: number | null) => {
        if (settled) return
        settled = true; dispose()
        try {
          await outputs; await stopping
          if (failure) throw failure
          const diagnostics = stderrPreview(stderrFile), errors = diagnostics.stderr
          const line = lastJsonLine(stdoutFile)
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
            ...diagnostics, durationMs: Date.now() - startedAt })
        } catch (error) { reject(error) }
      }
      const stop = (error: Error) => {
        if (settled || stopping) return
        failure = error
        capabilityAbort.abort()
        stopping = stopCommandProcessTree(child, startedAt).catch(cleanup => {
          failure = new PluginError('PLUGIN_CLEANUP', `${error.message}；进程树清理失败：${String(cleanup)}`, 500)
          try { child.kill() } catch { /* The original process may already have exited. */ }
        })
        void stopping.then(() => {
          if (!settled && failure instanceof PluginError && failure.code === 'PLUGIN_CLEANUP') {
            inputStream.destroy(); outputStream.destroy(); errorStream.destroy()
            void finish(child.exitCode)
          }
        })
      }
      const aborted = () => stop(new PluginError('PLUGIN_CANCELLED', '插件运行已取消', 409))
      const timer = timeoutMs ? setTimeout(() => stop(new PluginError('PLUGIN_TIMEOUT', `插件运行超过调用方设置的 ${timeoutMs}ms`)), timeoutMs) : undefined
      child.on('message', message => {
        if (!object(message) || message.aetherCapability !== 1) return
        if (typeof message.id === 'string' && message.cancel === true) {
          capabilityControllers.get(message.id)?.abort(); return
        }
        if (typeof message.id === 'string' && typeof message.ack === 'number') {
          const ack = eventAcks.get(message.id)
          if (ack?.sequence === message.ack) ack.resolve()
          return
        }
        if (!options.capability || typeof message.id !== 'string' || message.id.length > 32 || typeof message.capability !== 'string'
          || typeof message.method !== 'string' || !object(message.args) || (maxInputBytes > 0 && Buffer.byteLength(JSON.stringify(message)) > maxInputBytes)
          || pendingCapabilities.has(message.id)) {
          stop(new PluginError('PLUGIN_CAPABILITY_REQUEST', '插件宿主请求无效')); return
        }
        const id = message.id; pendingCapabilities.add(id)
        const requestController = new AbortController()
        capabilityControllers.set(id, requestController)
        const requestSignal = AbortSignal.any([capabilitySignal, requestController.signal])
        let sequence = 0
        const request = { capability: message.capability, method: message.method, args: message.args }
        const onEvent: NonNullable<Parameters<NonNullable<PluginRunOptions['capability']>>[2]> = event => new Promise<void>((resolveEvent, rejectEvent) => {
          if (requestSignal.aborted || settled || !child.connected) { rejectEvent(new PluginError('PLUGIN_CANCELLED', '流式调用已取消', 409)); return }
          const eventSequence = ++sequence
          const cleanup = () => { eventAcks.delete(id); requestSignal.removeEventListener('abort', onAbort) }
          const fail = () => { cleanup(); rejectEvent(new PluginError('PLUGIN_CANCELLED', '流式调用已取消', 409)) }
          const onAbort = () => fail()
          // At most one outstanding event per request, including asynchronous consumers.
          // Slow consumers apply backpressure; only cancellation or process exit stops them.
          eventAcks.set(id, { sequence: eventSequence, resolve: () => { cleanup(); resolveEvent() } })
          requestSignal.addEventListener('abort', onAbort, { once: true })
          child.send({ aetherCapability: 1, id, event, sequence: eventSequence }, error => {
            if (error) { requestController.abort(); fail() }
          })
        })
        void Promise.resolve().then(() => options.capability!(request, requestSignal, onEvent))
          .then(result => ({ aetherCapability: 1, id, result }), error => ({ aetherCapability: 1, id, error: error instanceof PluginError ? error.message : '宿主能力调用失败' }))
          .then(result => { if (!settled && child.connected) child.send(result, () => undefined) })
          .finally(() => { pendingCapabilities.delete(id); capabilityControllers.delete(id); eventAcks.delete(id) })
      })
      child.once('error', error => { failure = error })
      child.once('disconnect', () => capabilityAbort.abort())
      child.once('close', code => { void finish(code) })
      inputStream.on('error', error => { if ((error as NodeJS.ErrnoException).code !== 'EPIPE') stop(error) })
      options.signal?.addEventListener('abort', aborted, { once: true })
      if (options.signal?.aborted) aborted()
      inputStream.end(input)
    })
  } finally {
    // Only remove the two files and the empty directory created by this invocation.
    if (path.dirname(spool) !== outputRoot || fs.lstatSync(spool).isSymbolicLink()) throw new Error('Unsafe plugin output cleanup')
    for (const filename of [stdoutFile, stderrFile]) if (fs.existsSync(filename)) fs.unlinkSync(filename)
    if (!fs.readdirSync(spool).length) fs.rmdirSync(spool)
  }
}
