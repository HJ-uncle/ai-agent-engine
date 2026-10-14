import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentContext } from '../../../core/agent-context/index.js'
import { cmdTool } from '../../cmd/execute-command.js'
import { installPackageTool } from '../install-package-tool.js'

const roots: string[] = []
const context = (workspaceDir: string, signal?: AbortSignal) => ({
  workspaceDir,
  signal,
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), child: vi.fn() },
} as unknown as AgentContext)

afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('install_package execution contract', () => {
  it('delegates to the cancellable command job without an implicit timeout', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aether-install-package-')); roots.push(root)
    const execute = vi.spyOn(cmdTool, 'execute').mockResolvedValue({ success: true, output: 'npm ok' })
    const result = await installPackageTool.execute({ packageName: 'left-pad', confirm: true }, context(root))
    expect(result).toMatchObject({ success: true })
    expect(execute).toHaveBeenCalledWith({ command: 'npm', args: ['install', 'left-pad'], cwd: root, background: false }, expect.anything())
  })

  it('passes an explicit timeout as an opt-in bound and keeps package data as argv', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aether-install-package-')); roots.push(root)
    const execute = vi.spyOn(cmdTool, 'execute').mockResolvedValue({ success: true, output: 'npm ok' })
    await installPackageTool.execute({ packageName: 'pkg; echo unsafe', saveDev: true, global: true, timeoutMs: 12_345, confirm: true }, context(root))
    expect(execute).toHaveBeenCalledWith({
      command: 'npm', args: ['install', '-g', '--save-dev', 'pkg; echo unsafe'], cwd: root, timeoutMs: 12_345, background: false,
    }, expect.anything())
  })

  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1])('rejects invalid timeout %s before execution', async timeoutMs => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aether-install-package-')); roots.push(root)
    const execute = vi.spyOn(cmdTool, 'execute')
    const result = await installPackageTool.execute({ packageName: 'left-pad', timeoutMs, confirm: true }, context(root))
    expect(result).toMatchObject({ success: false, error: 'INSTALL_INVALID_ARGUMENTS' })
    expect(execute).not.toHaveBeenCalled()
  })

  it('propagates user cancellation instead of converting it to a successful install result', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aether-install-package-')); roots.push(root)
    vi.spyOn(cmdTool, 'execute').mockResolvedValue({ success: true, output: 'late result' })
    const controller = new AbortController()
    const reason = new Error('user stopped installation')
    controller.abort(reason)
    await expect(installPackageTool.execute({ packageName: 'left-pad', confirm: true }, context(root, controller.signal))).rejects.toThrow('user stopped installation')
  })
})
