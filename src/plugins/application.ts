import { PluginService } from './service.js'
import { validatePluginArguments } from './schema.js'
import { runPlugin } from './runtime.js'
import { getDefaultSecurityMode } from '../security/policy-engine.js'
import { PluginError, type PluginManifest, type PluginRunResult, type PluginSnapshot } from './types.js'

export interface PluginApplicationExample { name: string; tool: string; args: Record<string, unknown> }
export interface PluginApplication {
  id: string
  name: string
  description: string
  revision: number
  hash: string
  manifest: PluginManifest
  examples: PluginApplicationExample[]
  execution: { allowed: boolean; reason?: string }
  uiDocuments?: Record<string, string>
}

function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function invocationPolicy(): { allowed: boolean; reason?: string } {
  // Application execution has no chat session. A guessed/shared session key
  // would let an unrelated chat override the engine default used by this API.
  return getDefaultSecurityMode() === 'safe'
    ? { allowed: false, reason: '安全模式无法约束此扩展的文件、命令或网络副作用，因此当前不可执行。' }
    : { allowed: true }
}

function examples(snapshot: PluginSnapshot): PluginApplicationExample[] {
  const source = snapshot.files['examples/cases.json']
  if (!source || Buffer.byteLength(source) > 256 * 1024) return []
  let parsed: unknown
  try { parsed = JSON.parse(source) } catch { return [] }
  if (!object(parsed) || !Array.isArray(parsed.cases) || parsed.cases.length > 50) return []
  const result: PluginApplicationExample[] = []
  const seen = new Set<string>()
  let bytes = 0
  for (const item of parsed.cases) {
    if (!object(item) || typeof item.tool !== 'string' || !object(item.args) || seen.has(item.tool)) continue
    const tool = snapshot.manifest.tools.find(tool => tool.name === item.tool)
    if (!tool) continue
    try { validatePluginArguments(tool.inputSchema, item.args) } catch { continue }
    const example = { name: typeof item.name === 'string' ? item.name.slice(0, 200) : tool.name, tool: tool.name, args: item.args }
    const size = Buffer.byteLength(JSON.stringify(example))
    if (size > 64 * 1024 || bytes + size > 128 * 1024) continue
    bytes += size; seen.add(tool.name); result.push(example)
  }
  return result
}

/** Only sealed published metadata and explicitly declared HTML documents reach the UI, without host paths or executable Node source. */
export async function getPluginApplication(service: PluginService, tenantId: string, id: string, revision?: number): Promise<PluginApplication> {
  const record = await service.get(tenantId, id)
  const pinned = revision ?? record.publishedRevision
  if (!pinned) throw new PluginError('PLUGIN_UNPUBLISHED', '请先发布并启用插件后再打开使用', 409)
  const snapshot = await service.snapshot(tenantId, id, pinned)
  const documents = Object.fromEntries((snapshot.manifest.contributes?.pages ?? []).flatMap(page => page.kind === 'webview' ? [[page.id, snapshot.files[page.entry]]] : []))
  return { id, name: snapshot.manifest.name, description: snapshot.manifest.description, revision: snapshot.revision,
    hash: snapshot.hash, manifest: snapshot.manifest, examples: examples(snapshot), execution: invocationPolicy(),
    ...(Object.keys(documents).length ? { uiDocuments: documents } : {}) }
}

/** User-operated execution stays pinned; it does not register tools in any agent session or write returned artifacts. */
export async function invokePluginApplication(service: PluginService, tenantId: string, id: string, revision: number,
  tool: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<PluginRunResult & { plugin: { id: string; revision: number; hash: string } }> {
  const policy = invocationPolicy()
  if (!policy.allowed) throw new PluginError('PLUGIN_FORBIDDEN', policy.reason!, 403)
  const snapshot = await service.snapshot(tenantId, id, revision)
  const output = await runPlugin(snapshot, tool, args, { signal, tenantId })
  return { ...output, plugin: { id, revision: snapshot.revision, hash: snapshot.hash } }
}
