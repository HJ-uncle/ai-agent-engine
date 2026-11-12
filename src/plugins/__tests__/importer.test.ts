import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { zipSync, strToU8 } from 'fflate'
import { PluginImporter, readPluginZip } from '../importer.js'
import { PluginService } from '../service.js'
import type { PluginManifest } from '../types.js'

const manifest: PluginManifest = { apiVersion: 1, id: 'import-test', name: 'Import test', version: '1.0.0', description: 'A test plugin', runtime: 'node', tools: [{ name: 'echo', description: 'Echo input', inputSchema: { type: 'object' }, entry: 'main.mjs' }] }
const contents = { 'aether-plugin.json': JSON.stringify(manifest), 'main.mjs': 'throw new Error("IMPORT_MUST_NOT_EXECUTE")\n' }
const archive = (files: Record<string, string>): string => Buffer.from(zipSync(Object.fromEntries(Object.entries(files).map(([name, content]) => [name, strToU8(content)])))).toString('base64')

describe('plugin importer', () => {
  let temporary: string, service: PluginService, importer: PluginImporter
  beforeEach(async () => { temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'aether-import-')); service = new PluginService(path.join(temporary, 'plugins')); importer = new PluginImporter(service) })
  afterEach(async () => { vi.unstubAllGlobals(); await fs.rm(temporary, { recursive: true, force: true }) })

  it('stages ZIP sources without executing them, then installs a disabled draft and persists its job', async () => {
    const job = await importer.previewImport('tenant-a', { type: 'zip', base64: archive(contents) })
    expect(job.status).toBe('prepared')
    expect(job.manifest?.id).toBe('import-test')
    expect(job.files.map(file => file.path)).toEqual(['main.mjs'])
    expect(await service.list('tenant-a')).toEqual([])
    await expect(importer.getImport('tenant-b', job.jobId)).rejects.toMatchObject({ statusCode: 404 })
    const restarted = new PluginImporter(service)
    expect((await restarted.getImport('tenant-a', job.jobId)).status).toBe('prepared')
    const installed = await restarted.installImport('tenant-a', job.jobId)
    expect(installed.enabled).toBe(false)
    expect(installed.publishedRevision).toBeUndefined()
    expect(installed.files['main.mjs']).toContain('IMPORT_MUST_NOT_EXECUTE')
    expect((await restarted.getImport('tenant-a', job.jobId)).status).toBe('installed')
    expect((await restarted.installImport('tenant-a', job.jobId)).id).toBe(installed.id)
  })

  it('supports local directories and ZIP root folders with explicit subdirectories', async () => {
    const local = path.join(temporary, 'source'); await fs.mkdir(local)
    for (const [name, text] of Object.entries(contents)) await fs.writeFile(path.join(local, name), text)
    const job = await importer.previewImport('tenant', { type: 'local', path: local })
    expect(job.source.path).toBe(local)
    const zip = await importer.previewImport('tenant', { type: 'zip', base64: archive(Object.fromEntries(Object.entries(contents).map(([name, content]) => ['repo/plugins/test/' + name, content]))), subdirectory: 'plugins/test' })
    expect(zip.status).toBe('prepared')
    expect(zip.manifest).toEqual(manifest)
  })

  it('cancels prepared jobs and refuses installation', async () => {
    const job = await importer.previewImport('tenant', { type: 'zip', base64: archive(contents) })
    expect((await importer.cancelImport('tenant', job.jobId)).status).toBe('cancelled')
    expect((await new PluginImporter(service).getImport('tenant', job.jobId)).status).toBe('cancelled')
    await expect(importer.installImport('tenant', job.jobId)).rejects.toMatchObject({ statusCode: 409 })
    expect(await service.list('tenant')).toEqual([])
  })

  it('retries failed installation without duplicating a plugin and rejects concurrent installation or late cancellation', async () => {
    const job = await importer.previewImport('tenant', { type: 'zip', base64: archive(contents) })
    const original = service.create.bind(service)
    const create = vi.spyOn(service, 'create').mockRejectedValueOnce(new Error('temporary installation error'))
    await expect(importer.installImport('tenant', job.jobId)).rejects.toThrow(/temporary/)
    expect((await importer.getImport('tenant', job.jobId)).failureStage).toBe('install')
    let release!: () => void, entered!: () => void
    const enteredPromise = new Promise<void>(resolve => { entered = resolve })
    create.mockImplementationOnce(async (...args) => { entered(); await new Promise<void>(resolve => { release = resolve }); return original(...args) })
    const installing = importer.installImport('tenant', job.jobId)
    await enteredPromise
    await expect(importer.installImport('tenant', job.jobId)).rejects.toMatchObject({ statusCode: 409 })
    await expect(importer.cancelImport('tenant', job.jobId)).rejects.toMatchObject({ code: 'import-committing' })
    release()
    expect((await installing).id).toBe(manifest.id)
    expect(await service.list('tenant')).toHaveLength(1)
  })

  it('recovers the receipt after a restart between plugin commit and job completion', async () => {
    const job = await importer.previewImport('tenant', { type: 'zip', base64: archive(contents) })
    const installed = await importer.installImport('tenant', job.jobId)
    const tenants = await fs.readdir(importer.rootDir), jobFile = path.join(importer.rootDir, tenants[0], job.jobId, 'job.json')
    const receipt = JSON.parse(await fs.readFile(jobFile, 'utf8'))
    receipt.status = 'installing'; delete receipt.pluginId
    await fs.writeFile(jobFile, JSON.stringify(receipt))
    const restarted = new PluginImporter(new PluginService(service.rootDir))
    expect((await restarted.getImport('tenant', job.jobId)).failureStage).toBe('install')
    expect((await restarted.installImport('tenant', job.jobId)).id).toBe(installed.id)
    expect(await service.list('tenant')).toHaveLength(1)
  })

  it('honors already aborted operations and detects source changes before install', async () => {
    const abort = new AbortController(); abort.abort()
    await expect(importer.previewImport('tenant', { type: 'zip', base64: archive(contents) }, abort.signal)).rejects.toMatchObject({ code: 'import-cancelled' })
    const job = await importer.previewImport('tenant', { type: 'zip', base64: archive(contents) })
    const tenants = await fs.readdir(importer.rootDir)
    const source = path.join(importer.rootDir, tenants[0], job.jobId, 'source', 'main.mjs')
    await fs.writeFile(source, 'tampered')
    await expect(importer.installImport('tenant', job.jobId)).rejects.toThrow(/changed/)
    expect((await importer.getImport('tenant', job.jobId)).status).toBe('failed')
    expect(await service.list('tenant')).toEqual([])
  })

  it('uses the same manifest and path validation as manual CRUD', async () => {
    await expect(importer.previewImport('tenant', { type: 'zip', base64: archive({ ...contents, 'aether-plugin.json': JSON.stringify({ ...manifest, tools: [{ ...manifest.tools[0], entry: '../escape.mjs' }] }) }) })).rejects.toThrow()
    await expect(importer.previewImport('tenant', { type: 'zip', base64: archive({ ...contents, 'danger.exe': 'binary' }) })).rejects.toThrow(/文件类型/)
    await expect(importer.previewImport('tenant', { type: 'zip', base64: archive({ ...contents, 'package.json': JSON.stringify({ dependencies: { example: '1.0.0' } }) }) })).rejects.toThrow(/not installed automatically/)
    await expect(importer.previewImport('tenant', { type: 'zip', base64: 'not-base64' })).rejects.toThrow(/base64/)
    await expect(importer.previewImport('tenant', { type: 'local', path: './relative' })).rejects.toThrow(/absolute/)
  })

  it('attaches a durable job receipt when preparation fails', async () => {
    const error = await importer.previewImport('tenant', { type: 'zip', base64: archive({ 'readme.md': 'No supported manifest' }) }).catch(error => error)
    expect(error.jobId).toMatch(/^[\da-f-]{36}$/)
    expect(error.importStatus).toBe('failed')
    const job = await importer.getImport('tenant', error.jobId)
    expect(job.status).toBe('failed'); expect(job.error).toMatch(/aether-plugin.json/)
  })

  it('rejects directory links and files outside the selected directory', async () => {
    const local = path.join(temporary, 'source'), outside = path.join(temporary, 'outside')
    await fs.mkdir(local); await fs.mkdir(outside)
    for (const [name, text] of Object.entries(contents)) await fs.writeFile(path.join(local, name), text)
    await fs.symlink(outside, path.join(local, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
    await expect(importer.previewImport('tenant', { type: 'local', path: local })).rejects.toThrow(/links/)
  })

  it('locks GitHub sources to the resolved commit and never installs during preview', async () => {
    const sha = 'a'.repeat(40), bytes = Buffer.from(archive(Object.fromEntries(Object.entries(contents).map(([name, content]) => [`test-${sha}/plugins/demo/${name}`, content]))), 'base64')
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => { calls.push(url); return calls.length === 1 ? new Response(JSON.stringify({ sha })) : new Response(bytes) }))
    const job = await importer.previewImport('tenant', { type: 'github', repository: 'https://github.com/owner/test', ref: 'release/demo', subdirectory: 'plugins/demo' })
    expect(calls).toEqual(['https://api.github.com/repos/owner/test/commits/release%2Fdemo', `https://codeload.github.com/owner/test/zip/${sha}`])
    expect(job.source.resolvedCommit).toBe(sha)
    expect(job.source.requestedRef).toBe('release/demo')
    expect(await service.list('tenant')).toEqual([])
    await expect(importer.previewImport('tenant', { type: 'github', repository: 'https://evil.example/owner/test' })).rejects.toThrow(/GitHub source/)
  })

  it('downloads an already immutable GitHub SHA directly without depending on API rate limits', async () => {
    const sha = 'ab'.repeat(20), bytes = Buffer.from(archive(Object.fromEntries(Object.entries(contents).map(([name, content]) => [`test-${sha}/${name}`, content]))), 'base64')
    const fetcher = vi.fn(async (_url: string) => new Response(bytes)); vi.stubGlobal('fetch', fetcher)
    const job = await importer.previewImport('tenant', { type: 'github', repository: 'owner/test', ref: sha.toUpperCase() })
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(fetcher.mock.calls[0][0]).toBe(`https://codeload.github.com/owner/test/zip/${sha}`)
    expect(job.source.resolvedCommit).toBe(sha)
    expect(job.source.requestedRef).toBe(sha.toUpperCase())
  })

  it('previews explicit remark adapters with local source imports, pinned adapter deps, and no script execution', async () => {
    const job = await importer.previewImport('tenant', { type: 'zip', format: 'remark', base64: archive({
      'package.json': JSON.stringify({ name: 'remark-fixture', version: '1.0.0', type: 'module', keywords: ['remark-plugin'], dependencies: { 'mdast-util-to-string': '^4.0.0' }, scripts: { postinstall: 'throw NEVER_RUN' } }),
      'index.js': 'export {default} from "./lib/index.js"', 'lib/index.js': 'export default function() {}', 'license': 'MIT',
    }) })
    expect(job.manifest?.id).toBe('remark-fixture')
    expect(job.source.format).toBe('remark')
    expect(job.requirements?.[0]).toMatchObject({ type: 'npm', scripts: 'disabled', packages: { unified: '11.0.5' } })
    expect(job.files.map(file => file.path)).toContain('vendor/lib/index.js')
    expect(job.files.map(file => file.path)).toContain('vendor/LICENSE.txt')
    expect(await service.list('tenant')).toEqual([])
    const tenants = await fs.readdir(importer.rootDir), source = path.join(importer.rootDir, tenants[0], job.jobId, 'source')
    expect(await fs.readFile(path.join(source, 'runner.mjs'), 'utf8')).toContain("from './vendor/index.js'")
    expect(JSON.parse(await fs.readFile(path.join(source, 'package.json'), 'utf8')).scripts).toBeUndefined()
    await expect(importer.previewImport('tenant', { type: 'zip', format: 'remark', base64: archive({ 'package.json': JSON.stringify({ name: 'ordinary-library', type: 'module' }), 'index.js': '' }) })).rejects.toThrow(/remark plugin/)
  })
})

describe('plugin ZIP limits', () => {
  it('rejects traversal and case-colliding entries before extraction', () => {
    expect(() => readPluginZip(Buffer.from(archive({ '../escape.mjs': 'bad' }), 'base64'))).toThrow(/path/)
    expect(() => readPluginZip(Buffer.from(archive({ 'Main.mjs': 'one', 'main.mjs': 'two' }), 'base64'))).toThrow(/Duplicate/)
  })
  it('rejects declared ZIP bombs and Unix symlink entries', () => {
    const original = Buffer.from(archive({ 'main.mjs': 'small' }), 'base64'), bomb = Buffer.from(original)
    const central = bomb.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
    bomb.writeUInt32LE(65 * 1024 * 1024, central + 24)
    expect(() => readPluginZip(bomb)).toThrow(/limits/)
    const linked = Buffer.from(original)
    linked.writeUInt32LE((0xa1ff << 16) >>> 0, central + 38)
    expect(() => readPluginZip(linked)).toThrow(/linked/)
  })
})
