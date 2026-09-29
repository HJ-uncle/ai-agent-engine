import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { eslintAdapter } from '../adapters/eslint.js'
import { runDiagnosticProcess } from '../adapters/process.js'

vi.mock('../adapters/process.js', () => ({ runDiagnosticProcess: vi.fn() }))
afterEach(() => { vi.restoreAllMocks(); vi.mocked(runDiagnosticProcess).mockReset() })

describe('ESLint execution integrity', () => {
  it('does not include an installed but unconfigured ESLint in default file diagnostics', async () => {
    vi.spyOn(fs, 'existsSync').mockImplementation(file => String(file).endsWith(path.join('bin', 'eslint.js')))
    vi.spyOn(fs, 'readFileSync').mockReturnValue('{}')
    expect(await eslintAdapter.isAvailable(path.resolve('fixture.ts'))).toBe(false)
  })

  it.each([
    { stdout: '', stderr: 'configuration failed', exitCode: 2 },
    { stdout: 'invalid json', stderr: '', exitCode: 0 },
  ])('propagates a failed run rather than an empty pass: %j', async result => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true)
    vi.mocked(runDiagnosticProcess).mockResolvedValue(result)
    await expect(eslintAdapter.diagnose(path.resolve('fixture.ts'), 'const x = 1')).rejects.toThrow()
  })

  it('keeps ignored-file notices at valid editor coordinates and sends unsaved content through stdin', async () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true)
    vi.mocked(runDiagnosticProcess).mockResolvedValue({ stdout: JSON.stringify([{ messages: [{ severity: 1, message: 'File ignored' }] }]), stderr: '', exitCode: 0 })
    const filePath = path.resolve('fixture.ts')
    const diagnostics = await eslintAdapter.diagnose(filePath, 'const unsaved = 1')
    expect(diagnostics).toMatchObject([{ line: 1, column: 1, severity: 'warning', message: 'File ignored' }])
    expect(runDiagnosticProcess).toHaveBeenCalledWith(expect.any(String), expect.arrayContaining(['--stdin', '--stdin-filename', filePath]), expect.objectContaining({ input: 'const unsaved = 1' }))
  })
})
