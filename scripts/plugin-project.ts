import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createPluginProject, packPluginProject, pluginProjectCases, readPluginProject, testPluginProject } from '../src/plugins/project.js'
import { listPluginTemplates } from '../src/plugins/templates.js'

const [command, directory, argument, id] = process.argv.slice(2)
const usage = 'plugin-project templates | init <new-directory> <template-id> [plugin-id] | check <directory> | test <directory> | pack <directory> <new-zip-path>'
try {
  let result: unknown
  if (command === 'templates') result = { templates: listPluginTemplates() }
  else if (!directory) throw new Error(usage)
  else if (command === 'init') {
    const project = createPluginProject(directory, argument ?? 'json-tool', id)
    result = { directory: path.resolve(directory), id: project.manifest.id, files: Object.keys(project.files) }
  } else if (command === 'check') {
    const project = readPluginProject(directory)
    const cases = project.files['examples/cases.json'] ? pluginProjectCases(project).length : 0
    result = { valid: true, executed: false, id: project.manifest.id, tools: project.manifest.tools.map(tool => tool.name), files: Object.keys(project.files).length, cases }
  } else if (command === 'test') result = { executed: true, passed: await testPluginProject(directory) }
  else if (command === 'pack') {
    if (!argument) throw new Error(usage)
    const archive = packPluginProject(readPluginProject(directory)), target = path.resolve(argument)
    const relative = path.relative(path.resolve(directory), target)
    if (relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep))) throw new Error('ZIP 必须写到工程目录之外，避免将旧归档打入工程')
    fs.writeFileSync(target, archive, { flag: 'wx' })
    result = { file: target, bytes: archive.byteLength, sha256: createHash('sha256').update(archive).digest('hex'), executed: false }
  } else throw new Error(usage)
  console.log(JSON.stringify(result, null, 2))
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
