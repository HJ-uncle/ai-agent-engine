import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PluginService, validatePluginInput } from '../service.js'
import { runPlugin } from '../runtime.js'
import type { PluginManifest } from '../types.js'

const parent = path.resolve('.e2e-tmp', 'plugin-service-runtime')
let root: string, service: PluginService
const manifest: PluginManifest = { apiVersion: 1, id: 'example', name: 'Example', version: '1.0.0', description: 'Test plugin', runtime: 'node',
  tools: [{ name: 'echo', description: 'Echo JSON', inputSchema: { type: 'object', properties: { text: { type: 'string' } } }, entry: 'main.mjs' }] }
const echo = `let raw='';for await(const c of process.stdin)raw+=c;const {tool,args}=JSON.parse(raw);console.log('diagnostic');console.log(JSON.stringify({result:{tool,args,secret:process.env.AETHER_PLUGIN_TEST_SECRET??null,options:process.env.NODE_OPTIONS??null},artifacts:[{path:'reports/result.txt',content:'hello'}]}));`
const input = (source = echo) => ({ manifest: structuredClone(manifest), files: { 'main.mjs': source } })

beforeEach(() => { fs.mkdirSync(parent, { recursive: true }); root = fs.mkdtempSync(path.join(parent, 'fixture-')); service = new PluginService(path.join(root, 'plugins')) })
afterEach(() => {
  vi.unstubAllEnvs()
  if (path.dirname(root) !== parent || !path.basename(root).startsWith('fixture-')) throw new Error('Unsafe plugin fixture cleanup')
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

describe('plugin revision storage', () => {
  it('checks enable/delete expected revisions inside the mutation lock', async () => {
    await service.create('alice', input())
    await service.update('alice', 'example', { ...input(), expectedRevision: 1 })
    await service.publish('alice', 'example', 2)
    await expect(service.setEnabled('alice', 'example', false, 1)).rejects.toMatchObject({ code: 'PLUGIN_CONFLICT' })
    expect((await service.get('alice', 'example')).enabled).toBe(true)
    await expect(service.remove('alice', 'example', 1)).rejects.toMatchObject({ code: 'PLUGIN_CONFLICT' })
    expect((await service.get('alice', 'example')).revision).toBe(2)
    expect((await service.setEnabled('alice', 'example', false, 2)).enabled).toBe(false)
    await service.remove('alice', 'example', 2)
    expect(await service.list('alice')).toEqual([])
  })
  it('publishes exact revisions, preserves prior code, rejects drafts and conflicts, and keeps tenants separate', async () => {
    const created = await service.create('alice', input())
    expect(created).toMatchObject({ revision: 1, enabled: false })
    expect(created.publishedRevision).toBeUndefined()
    await expect(service.snapshot('alice', 'example', 1)).rejects.toMatchObject({ code: 'PLUGIN_DISABLED' })
    const first = await service.publish('alice', 'example', 1)
    expect(first.revisions[0].publishedAt).toBeTypeOf('number')
    const initial = await service.snapshot('alice', 'example', 1)
    const edited = await service.update('alice', 'example', { ...input('console.log(JSON.stringify("second"))'), expectedRevision: 1 })
    expect(edited).toMatchObject({ revision: 2, publishedRevision: 1, enabled: true })
    expect((await service.snapshot('alice', 'example', 1)).files['main.mjs']).toBe(echo)
    await expect(service.snapshot('alice', 'example', 2)).rejects.toMatchObject({ code: 'PLUGIN_DISABLED' })
    expect((await service.snapshot('alice', 'example', 2, { allowDraft: true })).hash).not.toBe(initial.hash)
    await expect(service.update('alice', 'example', { ...input(), expectedRevision: 1 })).rejects.toMatchObject({ code: 'PLUGIN_CONFLICT' })
    await expect(service.publish('alice', 'example', 1)).rejects.toMatchObject({ code: 'PLUGIN_CONFLICT' })
    await service.publish('alice', 'example', 2)
    expect((await service.snapshot('alice', 'example', 1)).hash).toBe(initial.hash)
    await service.create('bob', input())
    expect(await service.list('bob')).toHaveLength(1)
    await expect(service.snapshot('bob', 'example', 1)).rejects.toMatchObject({ code: 'PLUGIN_DISABLED' })
    await service.setEnabled('alice', 'example', false)
    await expect(service.snapshot('alice', 'example', 1)).rejects.toMatchObject({ code: 'PLUGIN_DISABLED' })
    await service.remove('alice', 'example')
    expect(await service.list('alice')).toEqual([])
    expect(await service.list('bob')).toHaveLength(1)
  })

  it('detects changed executable bytes before publication and execution', async () => {
    await service.create('alice', input())
    const draft = await service.snapshot('alice', 'example', 1, { allowDraft: true })
    fs.writeFileSync(path.join(draft.directory, 'main.mjs'), 'console.log("tampered")')
    await expect(service.publish('alice', 'example', 1)).rejects.toMatchObject({ code: 'PLUGIN_TAMPERED' })
    expect((await service.get('alice', 'example')).enabled).toBe(false)
  })

  it.each(['../escape.mjs', '/absolute.mjs', 'C:/escape.mjs', 'folder\\escape.mjs', 'folder/../escape.mjs', 'con.mjs', '.git/escape.mjs', 'node_modules/test.mjs'])('rejects unsafe source path %s', file => {
    expect(() => validatePluginInput({ ...input(), files: { 'main.mjs': echo, [file]: 'bad' } })).toThrow()
  })

  it('rejects binary, case-colliding and oversized source files plus invalid entry/schema/name identities', () => {
    expect(() => validatePluginInput({ ...input(), files: { 'main.mjs': echo, 'bad.exe': 'bad' } })).toThrow()
    expect(() => validatePluginInput({ ...input(), files: { 'main.mjs': echo, 'Main.mjs': echo } })).toThrow()
    expect(() => validatePluginInput(input('a'.repeat(1024 * 1024 + 1)))).toThrow()
    expect(() => validatePluginInput({ ...input(), manifest: { ...manifest, tools: [{ ...manifest.tools[0], entry: 'missing.mjs' }] } })).toThrow()
    expect(() => validatePluginInput({ ...input(), manifest: { ...manifest, tools: [{ ...manifest.tools[0], inputSchema: { type: 'string' } }] } })).toThrow()
    expect(() => validatePluginInput({ ...input(), manifest: { ...manifest, id: 'bad--id' } })).toThrow()
    expect(() => validatePluginInput({ ...input(), manifest: { ...manifest, id: 'x'.repeat(48), tools: [{ ...manifest.tools[0], name: 'too_long_name' }] } })).toThrow()
  })

  it('refuses directory links and preserves the outside target', async () => {
    const external = path.join(root, 'external'); fs.mkdirSync(external); fs.writeFileSync(path.join(external, 'marker'), 'keep')
    const linked = path.join(root, 'linked'); fs.symlinkSync(external, linked, process.platform === 'win32' ? 'junction' : 'dir')
    await expect(new PluginService(linked).create('alice', input())).rejects.toMatchObject({ code: 'PLUGIN_LINK' })
    expect(fs.readFileSync(path.join(external, 'marker'), 'utf8')).toBe('keep')
  })

  it('seals prepared dependency bytes and preserves their version across ordinary source edits', async () => {
    const prepared = path.join(root, 'prepared'); fs.mkdirSync(path.join(prepared, 'node_modules', 'library'), { recursive: true })
    fs.writeFileSync(path.join(prepared, 'node_modules', 'library', 'index.js'), 'module.exports="first"')
    fs.writeFileSync(path.join(prepared, 'package-lock.json'), '{"lockfileVersion":3}')
    const authored = { ...input(), files: { ...input().files, 'package.json': '{"dependencies":{"library":"1.0.0"}}' } }
    await service.create('alice', authored, { directory: prepared }); await service.publish('alice', 'example', 1)
    fs.writeFileSync(path.join(prepared, 'node_modules', 'library', 'index.js'), 'module.exports="changed outside"')
    const first = await service.snapshot('alice', 'example', 1)
    expect(fs.readFileSync(path.join(first.directory, 'node_modules', 'library', 'index.js'), 'utf8')).toBe('module.exports="first"')
    await service.update('alice', 'example', { ...authored, expectedRevision: 1 })
    const second = await service.snapshot('alice', 'example', 2, { allowDraft: true })
    expect(fs.readFileSync(path.join(second.directory, 'node_modules', 'library', 'index.js'), 'utf8')).toBe('module.exports="first"')
    fs.writeFileSync(path.join(second.directory, 'node_modules', 'library', 'index.js'), 'changed')
    await expect(service.publish('alice', 'example', 2)).rejects.toMatchObject({ code: 'PLUGIN_TAMPERED' })
  })
})

async function draft(source: string) {
  await service.create('runner', input(source))
  return service.snapshot('runner', 'example', 1, { allowDraft: true })
}

describe('isolated Node plugin execution', () => {
  it('rejects explicit error envelopes and preserves bounded exit diagnostics without interpreting business result fields', async () => {
    const snapshot = await draft('console.log(JSON.stringify({error:"missing input"}))')
    await expect(runPlugin(snapshot, 'echo', {})).rejects.toMatchObject({ code: 'PLUGIN_REPORTED_ERROR', message: expect.stringContaining('missing input') })
    await service.update('runner', 'example', { ...input('console.log(JSON.stringify({error:{message:"invalid timezone",code:"BAD_ZONE"}}))'), expectedRevision: 1 })
    await expect(runPlugin(await service.snapshot('runner', 'example', 2, { allowDraft: true }), 'echo', {}))
      .rejects.toMatchObject({ code: 'PLUGIN_REPORTED_ERROR', message: expect.stringContaining('[BAD_ZONE] invalid timezone') })
    await service.update('runner', 'example', { ...input('console.log("diagnostic");console.log(JSON.stringify({error:{message:"stdin was empty",code:"NO_INPUT"}}));console.error("stderr detail");process.exitCode=1'), expectedRevision: 2 })
    await expect(runPlugin(await service.snapshot('runner', 'example', 3, { allowDraft: true }), 'echo', {}))
      .rejects.toMatchObject({ code: 'PLUGIN_EXIT', message: expect.stringContaining('[NO_INPUT] stdin was empty\nstderr detail') })
    await service.update('runner', 'example', { ...input('console.log(JSON.stringify({error:"x".repeat(20000)}));process.exitCode=1'), expectedRevision: 3 })
    try { await runPlugin(await service.snapshot('runner', 'example', 4, { allowDraft: true }), 'echo', {}); expect.fail('must reject') }
    catch (error) { expect((error as Error).message.length).toBeLessThan(4100) }
    await service.update('runner', 'example', { ...input('console.log(JSON.stringify({result:{ok:false,error:"business value"}}))'), expectedRevision: 4 })
    expect((await runPlugin(await service.snapshot('runner', 'example', 5, { allowDraft: true }), 'echo', {})).result).toEqual({ ok: false, error: 'business value' })
    await service.update('runner', 'example', { ...input('console.log(JSON.stringify({result:7,error:"result envelope takes precedence"}))'), expectedRevision: 5 })
    expect((await runPlugin(await service.snapshot('runner', 'example', 6, { allowDraft: true }), 'echo', {})).result).toBe(7)
  })
  it('rejects invalid arguments before spawning and sends valid arguments without defaults or coercion', async () => {
    const marker = path.join(root, 'ran.txt')
    const authored = input("import fs from 'node:fs';fs.writeFileSync(" + JSON.stringify(marker) + ",'ran');let raw='';for await(const c of process.stdin)raw+=c;console.log(JSON.stringify({result:JSON.parse(raw).args}))")
    authored.manifest.tools[0].inputSchema = { type: 'object', properties: {
      text: { type: 'string', minLength: 2 }, count: { type: 'integer', default: 7 },
    }, required: ['text'], additionalProperties: false }
    await service.create('runner', authored)
    const snapshot = await service.snapshot('runner', 'example', 1, { allowDraft: true })
    for (const args of [{}, { text: 7 }, { text: 'ok', count: '2' }, { text: 'ok', unexpected: true }])
      await expect(runPlugin(snapshot, 'echo', args)).rejects.toMatchObject({ code: 'PLUGIN_ARGUMENTS' })
    expect(fs.existsSync(marker)).toBe(false)
    expect((await runPlugin(snapshot, 'echo', { text: 'ok' })).result).toEqual({ text: 'ok' })
    expect(fs.readFileSync(marker, 'utf8')).toBe('ran')
  })
  it('passes structured stdin, accepts final JSON after logs, returns artifacts and excludes inherited secrets', async () => {
    vi.stubEnv('AETHER_PLUGIN_TEST_SECRET', 'must-not-cross')
    vi.stubEnv('NODE_OPTIONS', '--require=does-not-exist.cjs')
    const snapshot = await draft(echo)
    const result = await runPlugin(snapshot, 'echo', { text: 'hello' })
    expect(result.result).toEqual({ tool: 'echo', args: { text: 'hello' }, secret: null, options: null })
    expect(result.artifacts).toEqual([{ path: 'reports/result.txt', content: 'hello' }])
    expect(result.durationMs).toBeGreaterThan(0)
  })

  it('accepts ordinary JSON results and rejects malformed JSON and unsafe artifact paths', async () => {
    const snapshot = await draft('console.log(JSON.stringify([1,2,3]))')
    expect((await runPlugin(snapshot, 'echo', {})).result).toEqual([1, 2, 3])
    await service.update('runner', 'example', { ...input('console.log("not json")'), expectedRevision: 1 })
    await expect(runPlugin(await service.snapshot('runner', 'example', 2, { allowDraft: true }), 'echo', {})).rejects.toMatchObject({ code: 'PLUGIN_OUTPUT' })
    await service.update('runner', 'example', { ...input('console.log(JSON.stringify({result:"bad",artifacts:[{path:"../escape",content:"bad"}]}))'), expectedRevision: 2 })
    await expect(runPlugin(await service.snapshot('runner', 'example', 3, { allowDraft: true }), 'echo', {})).rejects.toMatchObject({ code: 'PLUGIN_PATH' })
  })

  it('enforces input and stdout budgets before permitting unbounded output', async () => {
    const snapshot = await draft('setInterval(()=>console.log("x".repeat(5000)),1)')
    await expect(runPlugin(snapshot, 'echo', { text: 'oversized' }, { maxInputBytes: 4 })).rejects.toMatchObject({ code: 'PLUGIN_INPUT_LIMIT' })
    await expect(runPlugin(snapshot, 'echo', {}, { maxOutputBytes: 1024, timeoutMs: 10_000 })).rejects.toMatchObject({ code: 'PLUGIN_OUTPUT_LIMIT' })
  }, 20_000)

  it('reports nonzero exits and enforces a separate stderr budget', async () => {
    const snapshot = await draft('console.error("plugin failure");process.exitCode=7')
    await expect(runPlugin(snapshot, 'echo', {})).rejects.toMatchObject({ code: 'PLUGIN_EXIT', message: expect.stringContaining('plugin failure') })
    await service.update('runner', 'example', { ...input('setInterval(()=>console.error("x".repeat(5000)),1)'), expectedRevision: 1 })
    await expect(runPlugin(await service.snapshot('runner', 'example', 2, { allowDraft: true }), 'echo', {}, { maxStderrBytes: 1024 })).rejects.toMatchObject({ code: 'PLUGIN_STDERR_LIMIT' })
  }, 20_000)

  it('terminates on deadline and cancellation and rejects pre-aborted executions', async () => {
    const snapshot = await draft('setInterval(()=>{},1000)')
    await expect(runPlugin(snapshot, 'echo', {}, { timeoutMs: 100 })).rejects.toMatchObject({ code: 'PLUGIN_TIMEOUT' })
    const controller = new AbortController()
    const result = runPlugin(snapshot, 'echo', {}, { signal: controller.signal })
    setTimeout(() => controller.abort(), 100)
    await expect(result).rejects.toMatchObject({ code: 'PLUGIN_CANCELLED' })
    await expect(runPlugin(snapshot, 'echo', {}, { signal: controller.signal })).rejects.toMatchObject({ code: 'PLUGIN_CANCELLED' })
  }, 30_000)

  it('limits live executions per tenant and releases slots after cancellation', async () => {
    const snapshot = await draft('setTimeout(()=>console.log(JSON.stringify("finished")),30000)')
    const controller = new AbortController()
    const runs = Array.from({ length: 4 }, () => runPlugin(snapshot, 'echo', {}, { signal: controller.signal }))
    const results = Promise.allSettled(runs)
    await expect(runPlugin(snapshot, 'echo', {})).rejects.toMatchObject({ code: 'PLUGIN_BUSY' })
    controller.abort()
    expect((await results).every(item => item.status === 'rejected')).toBe(true)
    const fast = await service.update('runner', 'example', { ...input('console.log(JSON.stringify("done"))'), expectedRevision: 1 })
    expect((await runPlugin(await service.snapshot('runner', 'example', fast.revision, { allowDraft: true }), 'echo', {})).result).toBe('done')
  }, 30_000)
})
