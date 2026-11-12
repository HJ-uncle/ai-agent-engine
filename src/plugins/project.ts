import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { strToU8, zipSync } from 'fflate'
import { validatePluginInput, validatePluginPath } from './service.js'
import { runPlugin } from './runtime.js'
import { getPluginTemplate } from './templates.js'
import { pluginProjectPackage } from './project-runner.js'
import { PluginError, type CreatePluginInput, type PluginManifest, type PluginSnapshot } from './types.js'

const MAX_BYTES = 8 * 1024 * 1024
const utf8 = new TextDecoder('utf-8', { fatal: true })

function noLinks(filename: string): void {
  const absolute = path.resolve(filename), root = path.parse(absolute).root
  let current = root
  for (const part of path.relative(root, absolute).split(path.sep).filter(Boolean)) {
    current = path.join(current, part)
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new PluginError('PLUGIN_LINK', '插件工程路径不能包含符号链接或目录联接')
  }
}

/** Read an explicit local project without loading modules or running install scripts. */
export function readPluginProject(directory: string): CreatePluginInput {
  const root = path.resolve(directory)
  noLinks(root)
  const files: Record<string, string> = Object.create(null)
  let bytes = 0, count = 0
  const visit = (folder: string, prefix: string): void => {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      if (entry.name === '.git') continue
      const relative = prefix + entry.name
      validatePluginPath(relative)
      const filename = path.join(folder, entry.name), stat = fs.lstatSync(filename)
      if (stat.isSymbolicLink()) throw new PluginError('PLUGIN_LINK', '插件工程不接受符号链接或目录联接')
      if (++count > 300) throw new PluginError('PLUGIN_LIMIT', '插件工程文件或目录过多')
      if (stat.isDirectory()) { visit(filename, relative + '/'); continue }
      if (!stat.isFile() || stat.size > 1024 * 1024 || (bytes += stat.size) > MAX_BYTES) throw new PluginError('PLUGIN_LIMIT', '插件工程超过大小限制或含非常规文件')
      const data = fs.readFileSync(filename)
      if (data.byteLength !== stat.size) throw new PluginError('PLUGIN_CONFLICT', '读取期间工程文件发生变化，请重试')
      files[relative] = utf8.decode(data)
    }
  }
  visit(root, '')
  if (!files['aether-plugin.json']) throw new PluginError('PLUGIN_MANIFEST', '工程根目录缺少 aether-plugin.json')
  let manifest: PluginManifest
  try { manifest = JSON.parse(files['aether-plugin.json']) as PluginManifest }
  catch { throw new PluginError('PLUGIN_MANIFEST', 'aether-plugin.json 不是有效 JSON') }
  return validatePluginInput({ manifest, files })
}

/** The manifest passed to the service is authoritative; exported projects have one root manifest. */
export function pluginProjectFiles(input: CreatePluginInput): Record<string, string> {
  const validated = validatePluginInput({ manifest: input.manifest, files: { ...input.files, 'aether-plugin.json': JSON.stringify(input.manifest, null, 2) + '\n' } })
  return validated.files
}

export function createPluginProject(directory: string, templateId: string, id?: string): CreatePluginInput {
  const root = path.resolve(directory)
  noLinks(root)
  if (fs.existsSync(root)) throw new PluginError('PLUGIN_EXISTS', '目标目录已存在；创建工程不会覆盖现有文件', 409)
  const template = getPluginTemplate(templateId)
  const input = { manifest: { ...template.manifest, ...(id ? { id } : {}) }, files: template.files }
  const files = pluginProjectFiles({ ...input, files: { ...input.files, 'package.json': pluginProjectPackage(input.manifest) } })
  fs.mkdirSync(root, { recursive: true })
  for (const [relative, content] of Object.entries(files)) {
    const filename = path.join(root, relative)
    fs.mkdirSync(path.dirname(filename), { recursive: true })
    fs.writeFileSync(filename, content, { flag: 'wx' })
  }
  return { manifest: input.manifest, files }
}

/** Deterministic, platform-neutral UTF-8 project ZIP. No tenant state, credentials or revisions. */
export function packPluginProject(input: CreatePluginInput): Uint8Array {
  const files = pluginProjectFiles(input)
  return zipSync(Object.fromEntries(Object.keys(files).sort().map(name => [name, [strToU8(files[name]), { mtime: new Date(1980, 0, 1), level: 6 }]])))
}

export function exportPluginArchive(snapshot: PluginSnapshot): { fileName: string; base64: string; sha256: string; revision: number } {
  // Native import does not install dependencies. Never label a package missing
  // its installed runtime modules as a portable, runnable native archive.
  if (fs.existsSync(path.join(snapshot.directory, 'node_modules'))) throw new PluginError('PLUGIN_EXPORT_DEPENDENCIES', '此插件带有适配器安装的依赖，请使用原 GitHub 来源重新导入；当前原生 ZIP 导出仅支持自包含插件')
  const archive = Buffer.from(packPluginProject(snapshot))
  return { fileName: `${snapshot.id}-r${snapshot.revision}.zip`, base64: archive.toString('base64'), sha256: createHash('sha256').update(archive).digest('hex'), revision: snapshot.revision }
}

export interface PluginProjectCase { name: string; tool: string; args: Record<string, unknown>; expected: unknown; artifacts?: unknown }
function isObject(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === 'object' && !Array.isArray(value)) }
export function pluginProjectCases(input: CreatePluginInput): PluginProjectCase[] {
  const text = input.files['examples/cases.json']
  if (!text) throw new PluginError('PLUGIN_TEST_CASES', '工程缺少 examples/cases.json，无法验证业务结果')
  let value: unknown
  try { value = JSON.parse(text) } catch { throw new PluginError('PLUGIN_TEST_CASES', 'examples/cases.json 不是有效 JSON') }
  if (!isObject(value) || !Array.isArray(value.cases) || !value.cases.length || value.cases.length > 50) throw new PluginError('PLUGIN_TEST_CASES', 'examples/cases.json 需要 1–50 个 cases')
  return value.cases.map(item => {
    if (!isObject(item) || typeof item.name !== 'string' || !item.name.trim() || typeof item.tool !== 'string' || !input.manifest.tools.some(tool => tool.name === item.tool) || !isObject(item.args) || !Object.hasOwn(item, 'expected')) throw new PluginError('PLUGIN_TEST_CASES', '每个用例需要 name、有效 tool、args 和 expected')
    return item as unknown as PluginProjectCase
  })
}

/** Execute explicit local examples and assert business results, not just exit status. */
export async function testPluginProject(directory: string): Promise<Array<{ name: string; durationMs: number }>> {
  const input = readPluginProject(directory), cases = pluginProjectCases(input)
  const snapshot: PluginSnapshot = { ...input, id: input.manifest.id, tenantId: 'local-project', directory: path.resolve(directory), hash: 'local-project', revision: 1 }
  const passed: Array<{ name: string; durationMs: number }> = []
  for (const example of cases) {
    const output = await runPlugin(snapshot, example.tool, example.args)
    if (!isDeepStrictEqual(output.result, example.expected)) throw new PluginError('PLUGIN_ASSERTION', `用例「${example.name}」结果不符：expected=${JSON.stringify(example.expected).slice(0, 2000)} actual=${JSON.stringify(output.result).slice(0, 2000)}`)
    if (Object.hasOwn(example, 'artifacts') && !isDeepStrictEqual(output.artifacts, example.artifacts)) throw new PluginError('PLUGIN_ASSERTION', `用例「${example.name}」产物内容不符`)
    passed.push({ name: example.name, durationMs: output.durationMs })
  }
  return passed
}
