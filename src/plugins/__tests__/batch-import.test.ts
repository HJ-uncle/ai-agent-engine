import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import Fastify, { type FastifyInstance } from 'fastify'
import { zipSync, strToU8 } from 'fflate'
import { previewPluginImportBatch, type PluginBatchImportInput } from '../batch-import.js'
import { PluginImporter } from '../importer.js'
import { PluginService } from '../service.js'
import { inspectPluginZip, readPluginZip } from '../zip.js'
import { pluginRoutes } from '../../api/http/routes/plugins.js'
import type { AuthContext } from '../../auth/types.js'

const parent = path.resolve('.e2e-tmp/plugin-batch-import')
const zip = (files: Record<string, string | Uint8Array>, level: 0 | 6 = 6): Buffer => Buffer.from(zipSync(Object.fromEntries(Object.entries(files).map(([name, value]) => [name, typeof value === 'string' ? strToU8(value) : value])), { level }))
const plugin = (id = 'first-plugin'): Buffer => zip({ 'aether-plugin.json': JSON.stringify({ apiVersion: 1, id, name: id, version: '1.0.0', description: 'Batch fixture', runtime: 'node', tools: [{ name: 'echo', description: 'Echo input', inputSchema: { type: 'object' }, entry: 'main.mjs' }] }), 'main.mjs': 'throw new Error("PREVIEW_MUST_NOT_RUN")' })
const input = (bytes: Uint8Array, more: Record<string, unknown> = {}): PluginBatchImportInput => ({ type: 'zip', base64: Buffer.from(bytes).toString('base64'), ...more }) as PluginBatchImportInput
const central = (bytes: Buffer): number => bytes.readUInt32LE(bytes.length - 6)
let root: string, service: PluginService, importer: PluginImporter, app: FastifyInstance | undefined, principal: AuthContext | undefined
beforeEach(async () => {
  await fs.mkdir(parent, { recursive: true }); root = await fs.mkdtemp(path.join(parent, 'run-'))
  vi.stubEnv('DATA_DIR', path.join(root, 'state/agent.db')); vi.stubEnv('AUTH_ENABLED', 'false')
  service = new PluginService(); importer = new PluginImporter(service); principal = undefined
})
afterEach(async () => {
  await app?.close(); app = undefined; vi.restoreAllMocks(); vi.unstubAllEnvs()
  if (path.dirname(root) !== parent || (await fs.lstat(root)).isSymbolicLink()) throw new Error('Unsafe batch test cleanup')
  await fs.rm(root, { recursive: true, force: true })
})
afterAll(async () => { if ((await fs.readdir(parent)).length === 0) await fs.rmdir(parent) })
async function http(): Promise<FastifyInstance> {
  app = Fastify()
  app.addHook('onRequest', async request => { if (principal) (request as typeof request & { authContext?: AuthContext }).authContext = principal })
  await app.register(pluginRoutes); return app
}
const manager = (tenantId: string): AuthContext => ({ tenantId, userId: 'test', roles: ['plugin-manager'], method: 'jwt' }) as AuthContext

describe('batch plugin previews', () => {
  it('prepares a single native ZIP without installing, publishing, executing or returning files', async () => {
    const result = await previewPluginImportBatch(importer, 'tenant-a', input(plugin()))
    expect(result.imports).toHaveLength(1)
    expect(result.imports[0]).toMatchObject({ fileName: 'plugin.zip', import: { status: 'prepared', manifest: { id: 'first-plugin' } } })
    expect(result.imports[0].import).not.toHaveProperty('files')
    expect(await service.list('tenant-a')).toEqual([])
    expect((await importer.getImport('tenant-a', result.imports[0].import!.jobId)).files).toHaveLength(1)
  })
  it('splits a delivery bundle once and keeps a broken child independent of valid siblings', async () => {
    const bytes = zip({ 'plugins/one.zip': plugin('first-plugin'), 'plugins/broken.zip': 'broken', 'plugins/no-manifest.zip': zip({ 'README.md': 'missing manifest' }), 'plugins/two.zip': plugin('second-plugin'), '使用说明.md': 'Instructions', 'manifest.json': '{}', 'evidence/one/tests.json': '{}', 'screenshots/one/view.png': new Uint8Array([1, 2, 3]) })
    const result = await previewPluginImportBatch(importer, 'tenant', input(bytes))
    expect(result.imports.map(item => item.fileName)).toEqual(['one.zip', 'broken.zip', 'no-manifest.zip', 'two.zip'])
    expect(result.imports.map(item => item.import?.status)).toEqual(['prepared', undefined, 'failed', 'prepared'])
    expect(result.imports[1].error).toMatch(/ZIP/); expect(result.imports[2].error).toMatch(/aether-plugin/)
    expect(result.imports.every(item => !item.import || !('files' in item.import))).toBe(true)
    expect(await service.list('tenant')).toEqual([])
  })
  it('does not decompress allowlisted screenshots and docs', async () => {
    const bytes = zip({ 'plugins/one.zip': plugin(), 'screenshots/one/large.png': 'repeated'.repeat(10000) })
    const entry = inspectPluginZip(bytes).entries.find(item => item.name.endsWith('.png'))!
    bytes.fill(255, entry.data, entry.data + entry.compressed)
    expect((await previewPluginImportBatch(importer, 'tenant', input(bytes))).imports[0].import?.status).toBe('prepared')
    expect(() => readPluginZip(bytes)).toThrow(/compressed|limits|checksum/)
  })
  it('supports explicit remark adapters, local directories and ZIP paths using the same preview lifecycle', async () => {
    const remark = zip({ 'package.json': JSON.stringify({ name: 'remark-fixture', version: '1.0.0', type: 'module', keywords: ['remark-plugin'] }), 'index.js': 'export default function(){}' })
    expect((await previewPluginImportBatch(importer, 'tenant', input(remark, { format: 'remark' }))).imports[0].import).toMatchObject({ status: 'prepared', requirements: [{ type: 'npm', scripts: 'disabled' }] })
    const archive = path.join(root, 'single.zip'); await fs.writeFile(archive, plugin())
    expect((await previewPluginImportBatch(importer, 'tenant', { type: 'zip', path: archive })).imports[0].fileName).toBe('single.zip')
    const source = path.join(root, 'source'); await fs.mkdir(source)
    for (const [name, bytes] of Object.entries(readPluginZip(plugin()))) await fs.writeFile(path.join(source, name), bytes)
    expect((await previewPluginImportBatch(importer, 'tenant', { type: 'local', path: source })).imports[0].import?.status).toBe('prepared')
  })
  it('rejects recursion per child while continuing the following package', async () => {
    const bundle = zip({ 'plugins/nested.zip': zip({ 'plugins/deeper.zip': plugin() }), 'plugins/valid.zip': plugin('valid-plugin') })
    const result = await previewPluginImportBatch(importer, 'tenant', input(bundle))
    expect(result.imports[0].error).toMatch(/Nested/); expect(result.imports[1].import?.status).toBe('prepared')
  })
  it('checks the whole count before staging, honors remaining slots and accepts the exact limit', async () => {
    const bundle = (count: number) => zip(Object.fromEntries(Array.from({ length: count }, (_, i) => [`plugins/p${i}.zip`, plugin(`plugin-${i}`)])))
    await expect(previewPluginImportBatch(importer, 'tenant', input(bundle(21)))).rejects.toThrow(/21.*20/)
    await expect(previewPluginImportBatch(importer, 'tenant', input(bundle(2), { maxPlugins: 1 }))).rejects.toThrow(/2.*1/)
    await expect(fs.access(importer.rootDir)).rejects.toThrow()
    const result = await previewPluginImportBatch(importer, 'tenant', input(bundle(20)))
    expect(result.imports).toHaveLength(20); expect(result.imports.every(item => item.import?.status === 'prepared')).toBe(true)
  })
  it.each([0, 21, 1.5, '2', null])('rejects invalid maxPlugins %s before staging', async maxPlugins => {
    await expect(previewPluginImportBatch(importer, 'tenant', input(plugin(), { maxPlugins }))).rejects.toThrow(/maxPlugins/)
    await expect(fs.access(importer.rootDir)).rejects.toThrow()
  })
  it('rejects unknown layout, invalid base64 and oversized outer ZIP without creating jobs', async () => {
    for (const bytes of [zip({ 'README.md': 'No plugin' }), zip({ 'plugins/a.zip': plugin(), 'execute.exe': 'x' }), Buffer.alloc(20 * 1024 * 1024 + 1)]) await expect(previewPluginImportBatch(importer, 'tenant', input(bytes))).rejects.toThrow()
    await expect(previewPluginImportBatch(importer, 'tenant', { type: 'zip', base64: '!!!!' })).rejects.toThrow(/base64/)
    await expect(fs.access(importer.rootDir)).rejects.toThrow()
  })
  it('rejects cumulative nested expansion before staging or inflating the sources', async () => {
    const nested = zip({ 'main.mjs': 'x' }), offset = central(nested)
    nested.writeUInt32LE(33 * 1024 * 1024, offset + 24); nested.writeUInt32LE(33 * 1024 * 1024, 22)
    await expect(previewPluginImportBatch(importer, 'tenant', input(zip({ 'plugins/a.zip': nested, 'plugins/b.zip': nested })))).rejects.toThrow(/Combined.*64 MiB/)
    await expect(fs.access(importer.rootDir)).rejects.toThrow()
  })
  it('honors cancellation before staging', async () => {
    const abort = new AbortController(); abort.abort()
    await expect(previewPluginImportBatch(importer, 'tenant', input(plugin()), abort.signal)).rejects.toMatchObject({ code: 'import-cancelled' })
    await expect(fs.access(importer.rootDir)).rejects.toThrow()
  })
  it('cancels already prepared children when the caller disconnects before the next child', async () => {
    const abort = new AbortController(), original = importer.previewImport.bind(importer)
    let jobId = ''
    const preparing = vi.spyOn(importer, 'previewImport').mockImplementation(async (...args) => {
      const job = await original(...args); jobId = job.jobId; abort.abort(); return job
    })
    await expect(previewPluginImportBatch(importer, 'tenant', input(zip({ 'plugins/a.zip': plugin(), 'plugins/b.zip': plugin('second-plugin') })), abort.signal)).rejects.toMatchObject({ code: 'import-cancelled' })
    expect(preparing).toHaveBeenCalledTimes(1)
    expect((await importer.getImport('tenant', jobId)).status).toBe('cancelled')
    const tenants = await fs.readdir(importer.rootDir)
    await expect(fs.access(path.join(importer.rootDir, tenants[0], jobId, 'source'))).rejects.toThrow()
  })
})

describe('batch ZIP safety', () => {
  it.each(['../escape.zip', '/absolute.zip', 'C:/drive.zip', 'plugins/../../escape.zip', 'plugins\\escape.zip', 'plugins/con.zip'])('rejects unsafe outer path %s', async name => {
    await expect(previewPluginImportBatch(importer, 'tenant', input(zip({ [name]: plugin() })))).rejects.toThrow(/path/)
  })
  it('rejects duplicate case-insensitive paths, file-directory collisions, symlinks and metadata mismatches', () => {
    expect(() => readPluginZip(zip({ 'Main.mjs': 'a', 'main.mjs': 'b' }))).toThrow(/Duplicate/)
    expect(() => readPluginZip(zip({ 'a': 'a', 'a/b': 'b' }))).toThrow(/Conflicting/)
    const linked = zip({ 'plugins/link.zip': plugin() }); linked.writeUInt32LE((0xa1ff << 16) >>> 0, central(linked) + 38)
    expect(() => inspectPluginZip(linked)).toThrow(/linked/)
    const mismatch = zip({ 'x': 'small' }); mismatch.writeUInt32LE(100, central(mismatch) + 24)
    expect(() => inspectPluginZip(mismatch)).toThrow(/metadata/)
  })
  it('rejects both declared ZIP bombs and a compressed stream that expands beyond its declared size', () => {
    const declared = zip({ 'x': 'small' }); declared.writeUInt32LE(65 * 1024 * 1024, central(declared) + 24)
    expect(() => inspectPluginZip(declared)).toThrow(/limits/)
    const hidden = zip({ 'x': 'x'.repeat(2 * 1024 * 1024) }); hidden.writeUInt32LE(1, central(hidden) + 24); hidden.writeUInt32LE(1, 22)
    expect(() => readPluginZip(hidden)).toThrow(/limits/)
    const checksum = zip({ 'x': 'real content' }, 0); checksum[30 + 1] ^= 1
    expect(() => readPluginZip(checksum)).toThrow(/checksum/)
  })
})

describe('batch import HTTP and tenant boundaries', () => {
  it('stages individual tenant-owned jobs and keeps install/cancel access isolated', async () => {
    const server = await http(); principal = manager('tenant-a')
    const response = await server.inject({ method: 'POST', url: '/plugins/imports/preview-batch', payload: input(zip({ 'plugins/a.zip': plugin(), 'plugins/b.zip': plugin('second-plugin') })) })
    expect(response.statusCode).toBe(200)
    const jobs = response.json().data.imports
    expect(jobs).toHaveLength(2); expect(jobs[0].import.files).toBeUndefined()
    principal = manager('tenant-b')
    for (const method of ['GET', 'DELETE', 'POST'] as const) expect((await server.inject({ method, url: `/plugins/imports/${jobs[0].import.jobId}${method === 'POST' ? '/install' : ''}` })).statusCode).toBe(404)
    principal = manager('tenant-a')
    expect((await server.inject({ method: 'GET', url: `/plugins/imports/${jobs[0].import.jobId}` })).json().data.import.status).toBe('prepared')
    const installed = (await server.inject({ method: 'POST', url: `/plugins/imports/${jobs[0].import.jobId}/install` })).json().data.plugin
    expect(installed.enabled).toBe(false); expect(installed.publishedRevision).toBeUndefined()
    expect((await server.inject({ method: 'DELETE', url: `/plugins/imports/${jobs[1].import.jobId}` })).statusCode).toBe(200)
    expect(await service.list('tenant-b')).toEqual([])
  })
  it('preserves the single-preview endpoint and returns 4xx for invalid batch requests or unauthorized users', async () => {
    const server = await http()
    const single = await server.inject({ method: 'POST', url: '/plugins/imports/preview', payload: input(plugin()) })
    expect(single.json().data.import.status).toBe('prepared')
    expect((await server.inject({ method: 'POST', url: '/plugins/imports/preview-batch', payload: input(zip({ 'plugins/a.zip': plugin(), 'plugins/b.zip': plugin() }), { maxPlugins: 1 }) })).statusCode).toBe(400)
    principal = { ...manager('tenant'), roles: ['viewer'] }
    expect((await server.inject({ method: 'POST', url: '/plugins/imports/preview-batch', payload: input(plugin()) })).statusCode).toBe(403)
  })
})
