import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PluginService } from '../service.js'
import { createSelectedPluginTools, pluginCatalogue, pluginToolDefinitions, pluginToolkitId } from '../catalogue.js'
import type { CreatePluginInput } from '../types.js'

const parent = path.resolve('.e2e-tmp/plugin-catalogue-loading')
let root: string, service: PluginService
const input = (): CreatePluginInput => ({ manifest: { apiVersion: 1, id: 'loading', name: 'Published name', description: 'Published description', version: '1.0.0', runtime: 'node',
  tools: [{ name: 'echo', description: 'Published tool', inputSchema: { type: 'object', properties: { text: { type: 'string' } } }, entry: 'main.mjs' }] },
  files: { 'main.mjs': 'console.log(JSON.stringify({result:"published"}))' } })
beforeEach(async () => {
  fs.mkdirSync(parent, { recursive: true }); root = fs.mkdtempSync(path.join(parent, 'fixture-'))
  service = new PluginService(path.join(root, 'plugins'))
  await service.create('tenant', input()); await service.publish('tenant', 'loading', 1)
})
afterEach(() => {
  vi.restoreAllMocks()
  if (path.dirname(root) !== parent || !path.basename(root).startsWith('fixture-')) throw new Error('Unsafe fixture cleanup')
  fs.rmSync(root, { recursive: true, force: true })
  if (fs.readdirSync(parent).length === 0) fs.rmdirSync(parent)
})

describe('plugin discovery metadata', () => {
  it('does not read revision snapshots or executable trees for current published catalogue and schemas', async () => {
    const read = vi.spyOn(fs, 'readFileSync')
    expect((await pluginCatalogue('tenant', [], service))[0]).toMatchObject({ name: 'Published name', available: true, selectionId: pluginToolkitId('loading', 1) })
    expect((await pluginToolDefinitions('tenant', undefined, service))[0]).toMatchObject({ name: 'plugin_loading_echo', parameters: input().manifest.tools[0].inputSchema })
    expect(read.mock.calls.every(([file]) => path.basename(String(file)) === 'record.json')).toBe(true)
  })
  it('keeps published names, schemas and selection revisions while a different draft exists, including disabled plugins', async () => {
    const draft = input(); draft.manifest.name = 'Unpublished name'; draft.manifest.tools[0].name = 'draft_tool'
    await service.update('tenant', 'loading', { ...draft, expectedRevision: 1 })
    const read = vi.spyOn(fs, 'readFileSync')
    expect((await pluginCatalogue('tenant', [], service))[0]).toMatchObject({ name: 'Published name', toolNames: ['plugin_loading_echo'], selectionId: pluginToolkitId('loading', 1) })
    expect((await pluginToolDefinitions('tenant', undefined, service))[0].name).toBe('plugin_loading_echo')
    expect(read.mock.calls.some(([file]) => String(file).includes(path.sep + 'files' + path.sep))).toBe(false)
    await service.setEnabled('tenant', 'loading', false)
    expect((await pluginCatalogue('tenant', [], service))[0]).toMatchObject({ available: false, reason: '插件已停用' })
    expect((await pluginToolDefinitions('tenant', undefined, service))).toHaveLength(1)
    expect((await pluginCatalogue('tenant', [['other']], service))[0].available).toBe(false)
  })
  it('still refuses modified executable bytes at selection, snapshot and publication', async () => {
    const snapshot = await service.snapshot('tenant', 'loading', 1)
    fs.writeFileSync(path.join(snapshot.directory, 'main.mjs'), 'console.log("tampered")')
    // Discovery is descriptive; only the verified execution path can grant runnable tools.
    expect((await pluginCatalogue('tenant', [], service))[0].name).toBe('Published name')
    await expect(createSelectedPluginTools('tenant', [pluginToolkitId('loading', 1)], [], service)).rejects.toMatchObject({ code: 'PLUGIN_TAMPERED' })
    await expect(service.snapshot('tenant', 'loading', 1)).rejects.toMatchObject({ code: 'PLUGIN_TAMPERED' })
    await expect(service.publish('tenant', 'loading', 1)).rejects.toMatchObject({ code: 'PLUGIN_TAMPERED' })
  })
  it('rejects a missing publication relationship and changed archived published metadata', async () => {
    await service.update('tenant', 'loading', { ...input(), expectedRevision: 1 })
    const snapshot = await service.snapshot('tenant', 'loading', 1)
    const snapshotFile = path.join(path.dirname(snapshot.directory), 'snapshot.json')
    const saved = JSON.parse(fs.readFileSync(snapshotFile, 'utf8'))
    saved.manifest.name = 'Replaced metadata'; fs.writeFileSync(snapshotFile, JSON.stringify(saved))
    await expect(service.listPublishedMetadata('tenant')).rejects.toMatchObject({ code: 'PLUGIN_TAMPERED' })
    const recordFile = path.join(path.dirname(path.dirname(path.dirname(snapshot.directory))), 'record.json')
    const record = JSON.parse(fs.readFileSync(recordFile, 'utf8'))
    record.publishedRevision = 2; fs.writeFileSync(recordFile, JSON.stringify(record))
    await expect(service.listPublishedMetadata('tenant')).rejects.toMatchObject({ code: 'PLUGIN_REVISION' })
  })
})
