import { spawn } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import { throwIfAborted } from '../../core/utils/abort.js'
import { stopCommandProcessTree } from '../../core/command-jobs/process-tree.js'

/** Diagnose in a bounded child; successful cancellation waits for process-tree exit. */
export function runDiagnosticProcess(command: string, args: string[], options: {
  cwd?: string; input?: string; signal?: AbortSignal; timeoutMs?: number; maxOutputBytes?: number
} = {}): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  const { signal } = options
  throwIfAborted(signal)
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs! > 0 ? Math.min(options.timeoutMs!, 120_000) : 30_000
  const outputLimit = Number.isFinite(options.maxOutputBytes) && options.maxOutputBytes! > 0 ? options.maxOutputBytes! : 4 * 1024 * 1024
  return new Promise((resolve, reject) => {
    const startedAt = Date.now()
    const child = spawn(command, args, { shell: false, windowsHide: true, cwd: options.cwd, detached: process.platform !== 'win32' })
    let stdout = ''
    let stderr = ''
    const stdoutDecoder = new StringDecoder('utf8')
    const stderrDecoder = new StringDecoder('utf8')
    let outputBytes = 0
    let stoppedError: Error | undefined
    let terminationError: Error | undefined
    let termination: Promise<void> | undefined
    let settled = false
    let closed = false
    let stopDeadline: ReturnType<typeof setTimeout> | undefined
    const cleanup = () => {
      clearTimeout(timer)
      if (stopDeadline) clearTimeout(stopDeadline)
      signal?.removeEventListener('abort', abort)
    }
    const rejectOnce = (error: unknown) => {
      if (settled) return
      settled = true; cleanup(); reject(error)
    }
    const stop = () => {
      if (termination || closed || settled) return
      stopDeadline = setTimeout(() => {
        try { child.kill('SIGKILL') } catch { /* failed termination remains explicit */ }
        rejectOnce(Object.assign(new Error('诊断进程树退出未确认，终止失败'), { code: 'LSP_TERMINATION_FAILED' }))
      }, 15_000)
      termination = stopCommandProcessTree(child, startedAt).catch(error => {
        terminationError = Object.assign(new Error(`诊断进程树终止失败: ${String(error)}`), { code: 'LSP_TERMINATION_FAILED' })
        try { child.kill('SIGKILL') } catch { /* already exited */ }
      })
    }
    const timer = setTimeout(() => {
      stoppedError = Object.assign(new Error(`诊断进程超时 (${timeoutMs}ms)`), { code: 'LSP_TIMEOUT' })
      stop()
    }, timeoutMs)
    timer.unref()
    const abort = () => { stop() }
    const append = (stream: 'stdout' | 'stderr', chunk: Buffer) => {
      if (settled || stoppedError) return
      outputBytes += chunk.byteLength
      if (outputBytes > outputLimit) {
        stoppedError = Object.assign(new Error(`诊断输出超过 ${outputLimit} bytes，结果不完整`), { code: 'LSP_OUTPUT_LIMIT' })
        stop(); return
      }
      if (stream === 'stdout') stdout += stdoutDecoder.write(chunk)
      else stderr += stderrDecoder.write(chunk)
    }
    child.stdout.on('data', chunk => append('stdout', chunk))
    child.stderr.on('data', chunk => append('stderr', chunk))
    child.once('error', error => { terminationError ??= error })
    child.once('close', async exitCode => {
      closed = true
      await termination
      if (settled) return
      stdout += stdoutDecoder.end(); stderr += stderrDecoder.end()
      settled = true
      cleanup()
      if (terminationError) reject(terminationError)
      else if (signal?.aborted) reject(signal.reason ?? new DOMException('诊断已取消', 'AbortError'))
      else if (stoppedError) reject(stoppedError)
      else resolve({ stdout, stderr, exitCode })
    })
    // EPIPE can occur when a failed CLI exits before consuming unsaved content.
    child.stdin.on('error', () => {})
    child.stdin.end(options.input)
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
  })
}
