/** Actual TypeScript runtime; never substitute a mocked compiler or adapter. */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { typescriptAdapter } from '../adapters/typescript.js'

let fixture: string
const controllers: AbortController[] = []

beforeEach(() => { fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'aether-d8-typescript-')) })
afterEach(() => {
  for (const controller of controllers.splice(0)) controller.abort()
  const resolved = path.resolve(fixture)
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('aether-d8-typescript-')) throw new Error('Unsafe TypeScript fixture cleanup')
  fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
})

describe('D8 real TypeScript diagnostics', () => {
  it('reports a real type mismatch with source coordinates', async () => {
    const file = path.join(fixture, 'type-error.ts')
    fs.writeFileSync(file, 'const count: number = "not a number";\nexport { count };\n')
    expect(await typescriptAdapter.isAvailable(file)).toBe(true)
    const diagnostics = await typescriptAdapter.diagnose(file)
    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'TS2322', severity: 'error', source: 'typescript', line: 1 }),
    ]))
    expect(diagnostics.find(item => item.code === 'TS2322')?.column).toBeGreaterThan(0)
  }, 20_000)

  it('checks unsaved text at its original path so relative imports resolve without changing disk contents', async () => {
    const models = path.join(fixture, 'models.ts')
    const main = path.join(fixture, 'main.ts')
    const saved = "import type { User } from './models';\nconst user: User = { name: 'saved' };\nexport { user };\n"
    const unsaved = "import type { User } from './models';\nconst user: User = { name: 123 };\nexport { user };\n"
    fs.writeFileSync(models, 'export interface User { name: string }\n')
    fs.writeFileSync(main, saved)
    const before = fs.readdirSync(fixture).sort()
    const diagnostics = await typescriptAdapter.diagnose(main, unsaved)
    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'TS2322', severity: 'error', line: 2 }),
    ]))
    expect(diagnostics.some(item => item.code === 'TS2307')).toBe(false)
    expect(fs.readFileSync(main, 'utf8')).toBe(saved)
    expect(fs.readFileSync(models, 'utf8')).toBe('export interface User { name: string }\n')
    expect(fs.readdirSync(fixture).sort()).toEqual(before)
  }, 20_000)

  it('rejects a pre-aborted request before trying to read or diagnose a nonexistent file', async () => {
    const controller = new AbortController()
    controllers.push(controller)
    controller.abort()
    await expect(typescriptAdapter.diagnose(path.join(fixture, 'not-created.ts'), undefined, controller.signal))
      .rejects.toMatchObject({ name: 'AbortError' })
    expect(fs.readdirSync(fixture)).toEqual([])
  })

  it('keeps the engine event loop responsive while a running TypeScript diagnostic is cancelled', async () => {
    const file = path.join(fixture, 'large.ts')
    const source = Array.from({ length: 12_000 }, (_, index) => `export const value${index}: number = ${index};`).join('\n')
    fs.writeFileSync(file, source)
    const controller = new AbortController()
    controllers.push(controller)
    let timerFiredAt = 0
    const startedAt = Date.now()
    const timer = setTimeout(() => { timerFiredAt = Date.now(); controller.abort() }, 30)
    try {
      const outcome = await typescriptAdapter.diagnose(file, source, controller.signal)
        .then(value => ({ value, error: undefined }), error => ({ value: undefined, error: error as Error }))
      expect(timerFiredAt).toBeGreaterThan(0)
      expect(timerFiredAt - startedAt).toBeLessThan(1_500)
      expect(outcome.value).toBeUndefined()
      expect(outcome.error?.name).toBe('AbortError')
      expect(Date.now() - timerFiredAt).toBeLessThan(8_000)
      expect(fs.readFileSync(file, 'utf8')).toBe(source)
    } finally { clearTimeout(timer); controller.abort() }
  }, 15_000)
})
