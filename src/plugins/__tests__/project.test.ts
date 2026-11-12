import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readPluginZip, PluginImporter } from '../importer.js'
import { PluginService } from '../service.js'
import { createPluginProject, exportPluginArchive, packPluginProject, pluginProjectFiles, readPluginProject, testPluginProject } from '../project.js'
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
