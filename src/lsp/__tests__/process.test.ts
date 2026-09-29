import { describe, expect, it } from 'vitest'
import { runDiagnosticProcess } from '../adapters/process.js'

describe('diagnostic CLI lifecycle', () => {
  it('retains stderr and nonzero exit instead of returning an empty success', async () => {
    const result = await runDiagnosticProcess(process.execPath, ['-e', 'process.stderr.write("bad config");process.exitCode=2'])
    expect(result).toMatchObject({ exitCode: 2, stderr: 'bad config', stdout: '' })
  })
  it('rejects a spawn error', async () => {
    await expect(runDiagnosticProcess('missing-lsp-command-for-test', [])).rejects.toThrow()
  })
  it('stops a running child and settles cancellation', async () => {
    const controller = new AbortController()
    const result = runDiagnosticProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { signal: controller.signal })
    const assertion = expect(result).rejects.toMatchObject({ name: 'AbortError' })
    controller.abort()
    await assertion
  })
  it('bounds an unresponsive diagnostic process and releases it on timeout', async () => {
    await expect(runDiagnosticProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeoutMs: 50 }))
      .rejects.toThrow('诊断进程超时')
  })
})
