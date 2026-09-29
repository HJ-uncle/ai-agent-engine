import { spawn } from 'node:child_process'
import { throwIfAborted } from '../../core/utils/abort.js'

/** Settle only after the child has exited, so cancellation releases its slot. */
export function runDiagnosticProcess(command: string, args: string[], options: {
  cwd?: string; input?: string; signal?: AbortSignal; timeoutMs?: number
} = {}): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  const { signal } = options
  throwIfAborted(signal)
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: false, windowsHide: true, cwd: options.cwd })
    let stdout = ''
    let stderr = ''
    let timeoutError: Error | undefined
    const timer = setTimeout(() => {
      timeoutError = new Error(`诊断进程超时 (${options.timeoutMs ?? 30_000}ms)`)
      child.kill('SIGTERM')
    }, options.timeoutMs ?? 30_000)
    timer.unref()
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort) }
    const abort = () => { child.kill('SIGTERM') }
    child.stdout.on('data', chunk => { stdout += chunk.toString() })
    child.stderr.on('data', chunk => { stderr += chunk.toString() })
    child.once('error', error => { cleanup(); reject(error) })
    child.once('close', exitCode => {
      cleanup()
      if (signal?.aborted) reject(signal.reason ?? new DOMException('诊断已取消', 'AbortError'))
      else if (timeoutError) reject(timeoutError)
      else resolve({ stdout, stderr, exitCode })
    })
    // EPIPE can occur when a failed CLI exits before consuming unsaved content.
    child.stdin.on('error', () => {})
    child.stdin.end(options.input)
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
  })
}
