import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readPluginZip, PluginImporter } from '../importer.js'
import { PluginService } from '../service.js'
import { createPluginProject, exportPluginArchive, packPluginProject, pluginProjectFiles, readPluginProject, testPluginProject, writePluginProject } from '../project.js'
import { getPluginTemplate, listPluginTemplates } from '../templates.js'
import { runPlugin } from '../runtime.js'

const parent = path.resolve('.e2e-tmp/plugin-project')
let root: string
beforeEach(() => { fs.mkdirSync(parent, { recursive: true }); root = fs.mkdtempSync(path.join(parent, 'fixture-')) })
afterEach(() => {
  if (path.dirname(root) !== parent || !path.basename(root).startsWith('fixture-')) throw new Error('Unsafe plugin project cleanup')
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

describe('portable plugin projects', () => {
  it('round-trips a real project above 100 files, 1 MiB per file and 8 MiB total without dropping source', async () => {
    const input = getPluginTemplate('json-tool')
    input.files['resources/large.txt'] = '大文件资料\n'.repeat(180000)
    for (let index = 0; index < 140; index++) input.files[`resources/chapter-${index}.txt`] = `chapter ${index}\n` + 'content\n'.repeat(10000)
    expect(Object.keys(input.files).length).toBeGreaterThan(100)
    expect(Buffer.byteLength(input.files['resources/large.txt'])).toBeGreaterThan(1024 * 1024)
    expect(Object.values(input.files).reduce((sum, content) => sum + Buffer.byteLength(content), 0)).toBeGreaterThan(8 * 1024 * 1024)
    const directory = path.join(root, 'large-project'), authored = writePluginProject(directory, input)
    expect(readPluginProject(directory).files).toEqual(authored.files)
    const service = new PluginService(path.join(root, 'large-storage')), importer = new PluginImporter(service)
    const local = await importer.previewImport('large-test', { type: 'local', path: directory })
    await importer.installImport('large-test', local.jobId)
    await service.publish('large-test', input.manifest.id, 1)
    const snapshot = await service.snapshot('large-test', input.manifest.id, 1)
    const archive = exportPluginArchive(snapshot), restoredFiles = readPluginZip(Buffer.from(archive.base64, 'base64'))
    expect(Object.keys(restoredFiles).sort()).toEqual(Object.keys(authored.files).sort())
    for (const [name, content] of Object.entries(authored.files)) expect(Buffer.from(restoredFiles[name]).toString('utf8')).toBe(content)
    const restoredService = new PluginService(path.join(root, 'restored-storage')), restoredImporter = new PluginImporter(restoredService)
    const imported = await restoredImporter.previewImport('large-test', { type: 'zip', base64: archive.base64 })
    await restoredImporter.installImport('large-test', imported.jobId)
    await restoredService.publish('large-test', input.manifest.id, 1)
    const restored = await restoredService.snapshot('large-test', input.manifest.id, 1)
    expect(exportPluginArchive(restored).sha256).toBe(archive.sha256)
    expect((await runPlugin(restored, 'normalize_text', { text: '  works   after import ' })).result).toEqual({ text: 'works after import', characters: 18 })
  }, 20000)
  it.each(listPluginTemplates().map(template => template.id))('%s scaffolds, asserts business examples, exports, imports and runs again', async templateId => {
    const directory = path.join(root, 'project'), input = createPluginProject(directory, templateId)
    expect(readPluginProject(directory)).toEqual(input)
    const verified = await testPluginProject(directory)
    expect(verified.length).toBeGreaterThan(0)
    const archive = packPluginProject(input)
    expect(archive).toEqual(packPluginProject(input))
    const archiveFiles = readPluginZip(archive)
    expect(Object.keys(archiveFiles).sort()).toEqual(Object.keys(input.files).sort())
    expect(JSON.parse(new TextDecoder().decode(archiveFiles['aether-plugin.json']))).toEqual(input.manifest)
    const service = new PluginService(path.join(root, 'storage')), importer = new PluginImporter(service)
    const job = await importer.previewImport('project-test', { type: 'zip', base64: Buffer.from(archive).toString('base64') })
    await importer.installImport('project-test', job.jobId)
    await service.publish('project-test', input.manifest.id, 1)
    const snapshot = await service.snapshot('project-test', input.manifest.id, 1)
    const examples = JSON.parse(input.files['examples/cases.json']).cases
    for (const example of examples) expect((await runPlugin(snapshot, example.tool, example.args)).result).toEqual(example.expected)
    const exported = exportPluginArchive(snapshot)
    expect(exported.base64).toBe(Buffer.from(archive).toString('base64'))
    expect(exported.fileName).toBe(`${input.manifest.id}-r1.zip`)
    expect(exported.sha256).toMatch(/^[a-f0-9]{64}$/)
  })

  it('does not overwrite an existing project and syncs the sole distributable manifest', () => {
    const directory = path.join(root, 'existing')
    createPluginProject(directory, 'json-tool', 'my-new-tool')
    expect(() => createPluginProject(directory, 'json-tool')).toThrow('目标目录已存在')
    expect(readPluginProject(directory).manifest.id).toBe('my-new-tool')
    expect(JSON.parse(readPluginProject(directory).files['package.json']).name).toBe('my-new-tool')
    const template = getPluginTemplate('json-tool')
    const manifest = { ...template.manifest, name: 'Changed name' }
    const files = pluginProjectFiles({ manifest, files: template.files })
    expect(JSON.parse(files['aether-plugin.json']).name).toBe('Changed name')
    expect(JSON.parse(template.files['aether-plugin.json']).name).not.toBe('Changed name')
  })

  it('rejects paths, binary input and packages missing their adapter dependencies', async () => {
    const directory = path.join(root, 'project')
    const input = createPluginProject(directory, 'json-tool')
    fs.writeFileSync(path.join(directory, 'binary.txt'), Buffer.from([0xff, 0xfe]))
    expect(() => readPluginProject(directory)).toThrow()
    expect(() => packPluginProject({ ...input, files: { ...input.files, '../escape.mjs': '' } })).toThrow()
    const service = new PluginService(path.join(root, 'storage'))
    await service.create('project-test', input)
    const snapshot = await service.snapshot('project-test', input.manifest.id, 1, { allowDraft: true })
    fs.mkdirSync(path.join(snapshot.directory, 'node_modules'))
    expect(() => exportPluginArchive(snapshot)).toThrow('依赖')
  })

  it('treats exit zero without the expected business result as failed acceptance', async () => {
    const directory = path.join(root, 'project')
    createPluginProject(directory, 'json-tool')
    const filename = path.join(directory, 'examples/cases.json'), examples = JSON.parse(fs.readFileSync(filename, 'utf8'))
    examples.cases[0].expected = { impossible: 'business failure must not count as success' }
    fs.writeFileSync(filename, JSON.stringify(examples))
    await expect(testPluginProject(directory)).rejects.toMatchObject({ code: 'PLUGIN_ASSERTION' })
  })
})
