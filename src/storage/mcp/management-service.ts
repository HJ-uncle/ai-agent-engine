import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { AuthContext } from '../../auth/types.js'
import { throwIfAborted } from '../../core/utils/abort.js'
import { MAX_OPERATION_TIMEOUT_MS } from '../../core/utils/operation-timeout.js'
import { canonicalFilePathSync, hashFileContent, withFileLocks } from '../../shared/file-version.js'
import { workspaceManager } from '../../workspace/index.js'
import { extensionPolicy } from '../../security/tool-policy.js'
import { HTTPMCPClient } from '../../tools/mcp/client.js'
import type { MCPClient, MCPServerConfig } from '../../tools/mcp/types.js'
import { resolveConfigPath, resolveConfigReadPath, resolveGlobalConfigPath, type McpServerRecord } from './mcp-config.js'

export class McpManagementError extends Error {
  constructor(public readonly code: number, message: string) { super(message); this.name = 'McpManagementError' }
}
export function publicMcpError(error: unknown, signal?: AbortSignal): Error {
  if (signal?.aborted) return new DOMException('MCP 管理操作已取消', 'AbortError')
  if (error instanceof McpManagementError) return error
  if (error instanceof z.ZodError) return new McpManagementError(40001, 'MCP 参数无效；请按工具定义提交，凭据请在设置页配置')
  return new McpManagementError(50000, 'MCP 配置操作失败；请检查文件权限和配置格式')
}
export function assertMcpManagementAccess(tenantId: string, principal?: Readonly<AuthContext>): void {
  if (tenantId !== 'default' || !principal || principal.tenantId !== tenantId)
    throw new McpManagementError(40300, 'MCP 是本机共享配置，仅默认租户的可信管理身份可操作')
  if (process.env.AUTH_ENABLED === 'false' && principal.method === 'none') return
  if (principal.method !== 'none' && principal.roles?.some(role => role === 'admin' || role === 'mcp-manager')) return
  throw new McpManagementError(40300, 'MCP 管理需要 admin 或 mcp-manager 权限')
}
export interface McpManagementContext {
  tenantId: string; sessionId: string; projectRoot: string; principal?: Readonly<AuthContext>; signal?: AbortSignal
}
export const mcpScopeSchema = z.enum(['project', 'global'])
const idSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,119}$/).refine(id => !['constructor', 'prototype', '__proto__'].includes(id))
const text = (max: number) => z.string().max(max).regex(/^[^\0]*$/)
const fields = {
  name: text(200).min(1), description: text(2000),
  transportType: z.enum(['stdio', 'sse', 'http', 'streamableHttp']), command: text(4096).min(1),
  args: z.array(text(4096)).max(100), url: text(8192).url().refine(value => ['http:', 'https:'].includes(new URL(value).protocol)),
  timeoutMs: z.number().int().min(0).max(MAX_OPERATION_TIMEOUT_MS).nullable(),
  disabledTools: z.array(text(200).min(1)).max(500),
}
const editFields = z.object(fields).partial().strict().refine(value => Object.keys(value).length > 0)
const keyFields = { id: idSchema, scope: mcpScopeSchema, expectedRevision: z.string().regex(/^sha256:[a-f0-9]{64}$/) }
export const mcpMutationSchemas = {
  create: z.object({ id: idSchema, scope: mcpScopeSchema.default('project'), ...fields,
    name: fields.name.optional(), description: fields.description.optional(), command: fields.command.optional(),
    args: fields.args.optional(), url: fields.url.optional(), timeoutMs: fields.timeoutMs.optional(), disabledTools: fields.disabledTools.optional(),
  }).strict(),
  update: z.object({ ...keyFields, changes: editFields }).strict(),
  set_enabled: z.object({ ...keyFields, enabled: z.boolean() }).strict(),
  delete: z.object(keyFields).strict(), test: z.object(keyFields).strict(),
}
export type McpManagementAction = keyof typeof mcpMutationSchemas
type Scope = z.infer<typeof mcpScopeSchema>
type Config = Record<string, unknown> & { mcpServers: Record<string, Record<string, unknown>> }
interface Snapshot { scope: Scope; anchor: string; source: string; target: string; sourceHash: string; targetHash: string; revision: string; config: Config }
export interface McpServerView {
  id: string; scope: Scope; name: string; description: string; enabled: boolean; transportType: string; revision: string
  connection: { command?: string; argumentCount?: number; endpoint?: string; hasQuery?: boolean; hasCredentials?: boolean; envKeys: string[]; headerKeys: string[] }
  timeoutMs?: number; disabledTools: string[]; isBuiltIn: boolean
}
export interface PreparedMcpMutation {
  version: 1; tenantId: string; action: McpManagementAction; id: string; scope: Scope; projectRoot: string
  source: string; target: string; revision: string; argsHash: string; before?: McpServerView; after?: McpServerView
}
const MAX_CONFIG = 2 * 1024 * 1024, MAX_SERVERS = 1000
const same = (a: string, b: string) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep))
}
function noLinks(anchor: string, candidate: string): string {
  const absolute = path.resolve(candidate)
  if (!inside(anchor, absolute)) throw new McpManagementError(40300, 'MCP 配置超出可信目录')
  let cursor = anchor
  for (const part of ['', ...path.relative(anchor, absolute).split(path.sep).filter(Boolean)]) {
    if (part) cursor = path.join(cursor, part)
    try { if (fs.lstatSync(cursor).isSymbolicLink()) throw new McpManagementError(40300, 'MCP 配置不能经过符号链接或目录联接') }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
  return canonicalFilePathSync(absolute)
}
function configuredPath(file: string): string { return noLinks(path.parse(path.resolve(file)).root, path.resolve(file)) }
function read(file: string): Buffer | null {
  try {
    const stat = fs.lstatSync(file)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_CONFIG) throw new McpManagementError(40001, 'MCP 配置必须是大小不超过 2 MiB 的普通文件')
    const fd = fs.openSync(file, 'r')
    try {
      const buffer = Buffer.alloc(MAX_CONFIG + 1)
      let size = 0
      while (size < buffer.length) { const count = fs.readSync(fd, buffer, size, buffer.length - size, size); if (!count) break; size += count }
      if (size > MAX_CONFIG) throw new McpManagementError(40001, 'MCP 配置超过 2 MiB')
      return buffer.subarray(0, size)
    } finally { fs.closeSync(fd) }
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
}
function parse(bytes: Buffer | null): Config {
  if (!bytes) return { mcpServers: {} }
  let raw: unknown
  try { raw = JSON.parse(bytes.toString('utf8')) } catch { throw new McpManagementError(40001, 'MCP 配置 JSON 无效；拒绝覆盖现有内容') }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new McpManagementError(40001, 'MCP 配置必须是 JSON 对象')
  const config = raw as Config
  if (config.mcpServers === undefined) config.mcpServers = {}
  if (!config.mcpServers || typeof config.mcpServers !== 'object' || Array.isArray(config.mcpServers) || Object.keys(config.mcpServers).length > MAX_SERVERS)
    throw new McpManagementError(40001, 'MCP 配置必须包含有效的 mcpServers 对象，且服务器数量不超过 1000')
  for (const entry of Object.values(config.mcpServers)) if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new McpManagementError(40001, 'MCP 服务器配置不是对象')
  return config
}
function normalized(id: string, raw: Record<string, unknown>): McpServerRecord {
  return { ...raw, id, name: typeof raw.name === 'string' ? raw.name : id, description: typeof raw.description === 'string' ? raw.description : '',
    transportType: raw.transportType ?? raw.transport ?? raw.type ?? 'http', enabled: raw.enabled === undefined ? raw.disabled !== true : raw.enabled === true,
    isBuiltIn: raw.isBuiltIn === true, createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : 0, updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : 0 } as McpServerRecord
}
function sensitive(entry: McpServerRecord): string[] {
  const values = [...Object.values(entry.env ?? {}), ...Object.values(entry.headers ?? {}), ...(entry.args ?? [])].filter(value => typeof value === 'string' && value.length > 0)
  for (const value of [...values]) {
    if (/^Bearer\s+/i.test(value)) values.push(value.replace(/^Bearer\s+/i, ''))
    const equal = value.indexOf('=')
    if (equal >= 0 && equal < value.length - 1) values.push(value.slice(equal + 1))
  }
  if (typeof entry.url === 'string') {
    values.push(entry.url)
    try { const url = new URL(entry.url); values.push(url.username, url.password, ...url.searchParams.values(), ...url.pathname.split('/').filter(Boolean)) } catch { /* malformed URLs remain hidden */ }
  }
  return [...new Set(values.filter(Boolean))].sort((a, b) => b.length - a.length)
}
function redact(value: string, secrets: readonly string[], limit = 2000): string {
  let output = value
  for (const secret of secrets) output = output.split(secret).join('[redacted]')
  return output.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').replace(/\b(?:sk-|sk_|ghp_|github_pat_)[A-Za-z0-9_-]+/g, '[redacted]').slice(0, limit)
}
function view(entry: McpServerRecord, snapshot: Snapshot): McpServerView {
  const secrets = sensitive(entry)
  let endpoint: string | undefined, hasQuery = false, hasCredentials = false
  if (entry.url) try { const url = new URL(entry.url); endpoint = `${url.protocol}//${url.host}/[redacted]`; hasQuery = !!url.search; hasCredentials = !!(url.username || url.password) } catch { endpoint = '[invalid or redacted URL]' }
  return { id: entry.id, scope: snapshot.scope, name: redact(entry.name, secrets, 200), description: redact(entry.description, secrets), enabled: entry.enabled,
    transportType: ['stdio', 'sse', 'http', 'streamableHttp'].includes(entry.transportType) ? entry.transportType : 'invalid', revision: snapshot.revision, connection: {
      ...(entry.command ? { command: redact(path.basename(entry.command), secrets, 200) } : {}),
      ...(Array.isArray(entry.args) ? { argumentCount: entry.args.length } : {}),
      ...(endpoint ? { endpoint: redact(endpoint, secrets, 300), hasQuery, hasCredentials } : {}),
      envKeys: Object.keys(entry.env ?? {}).slice(0, 100).map(key => redact(key, secrets, 100)),
      headerKeys: Object.keys(entry.headers ?? {}).slice(0, 100).map(key => redact(key, secrets, 100)),
    }, ...(typeof entry.timeoutMs === 'number' && Number.isInteger(entry.timeoutMs) && entry.timeoutMs >= 0 && entry.timeoutMs <= MAX_OPERATION_TIMEOUT_MS ? { timeoutMs: entry.timeoutMs } : {}),
    disabledTools: (entry.disabledTools ?? []).slice(0, 500).map(name => redact(name, secrets, 200)), isBuiltIn: entry.isBuiltIn }
}
function validateConnection(entry: McpServerRecord): void {
  if (!['stdio', 'sse', 'http', 'streamableHttp'].includes(entry.transportType)) throw new McpManagementError(40001, 'MCP 传输类型无效')
  if (entry.transportType === 'stdio') {
    if (typeof entry.command !== 'string' || !entry.command.trim() || entry.command.includes('\0')) throw new McpManagementError(40001, 'stdio 服务器需要有效 command')
    if (entry.args !== undefined && (!Array.isArray(entry.args) || entry.args.some(arg => typeof arg !== 'string' || arg.includes('\0')))) throw new McpManagementError(40001, 'stdio args 必须为字符串数组')
  } else {
    try { if (!entry.url || !['http:', 'https:'].includes(new URL(entry.url).protocol)) throw new Error() }
    catch { throw new McpManagementError(40001, 'HTTP/SSE 服务器需要有效 HTTP 或 HTTPS URL') }
  }
  for (const map of [entry.env, entry.headers]) if (map !== undefined && (!map || typeof map !== 'object' || Array.isArray(map) || Object.values(map).some(value => typeof value !== 'string')))
    throw new McpManagementError(40001, 'MCP env/headers 配置必须为字符串对象')
  if (entry.timeoutMs !== undefined && (typeof entry.timeoutMs !== 'number' || !Number.isInteger(entry.timeoutMs) || entry.timeoutMs < 0 || entry.timeoutMs > MAX_OPERATION_TIMEOUT_MS)) throw new McpManagementError(40001, 'MCP timeoutMs 无效')
}
function changed(entry: McpServerRecord, patch: Record<string, unknown>): McpServerRecord {
  const result = { ...entry, ...patch, updatedAt: Math.floor(Date.now() / 1000) } as McpServerRecord
  if ((patch.transportType !== undefined && patch.transportType !== entry.transportType) ||
    (patch.url !== undefined && patch.url !== entry.url) ||
    (patch.args !== undefined && JSON.stringify(patch.args) !== JSON.stringify(entry.args))) {
    // A credential copied into display metadata must not become public when
    // its original transport fields are removed and no longer mask it.
    const previousSecrets = sensitive(entry)
    result.name = redact(result.name, previousSecrets, 200)
    result.description = redact(result.description, previousSecrets)
    if (result.disabledTools) result.disabledTools = result.disabledTools.map(name => redact(name, previousSecrets, 200))
  }
  if (patch.timeoutMs === null) delete result.timeoutMs
  if (result.transportType === 'stdio') { delete result.url; delete result.headers }
  else { delete result.command; delete result.args; delete result.env }
  validateConnection(result)
  return result
}

export class McpManagementService {
  constructor(private readonly clientFactory: (config: MCPServerConfig, ctx: McpManagementContext) => Pick<MCPClient, 'toTools' | 'disconnect'> =
    (config, ctx) => new HTTPMCPClient(config, { tenantId: ctx.tenantId, sessionId: ctx.sessionId })) {}
  private project(context: McpManagementContext): string {
    assertMcpManagementAccess(context.tenantId, context.principal); throwIfAborted(context.signal)
    return canonicalFilePathSync(workspaceManager.resolveProjectDirectory(context.tenantId, context.projectRoot))
  }
  private snapshot(context: McpManagementContext, scope: Scope): Snapshot {
    const project = this.project(context)
    const configured = scope === 'global' || Boolean(process.env.MCP_CONFIG_PATH)
    const target = configured ? configuredPath(scope === 'global' ? resolveGlobalConfigPath() : resolveConfigPath(project)) : noLinks(project, resolveConfigPath(project))
    const source = scope === 'global' ? target : configured ? target : noLinks(project, resolveConfigReadPath(project))
    const anchor = configured ? path.dirname(target) : project
    const bytes = read(source), sourceHash = hashFileContent(bytes), targetHash = source === target ? sourceHash : hashFileContent(read(target))
    return { scope, anchor, source, target, sourceHash, targetHash,
      revision: hashFileContent(JSON.stringify([source, sourceHash, target, targetHash])), config: parse(bytes) }
  }
  list(context: McpManagementContext, scope?: Scope): McpServerView[] {
    return (scope ? [scope] : ['project', 'global'] as const).flatMap(selected => {
      const snapshot = this.snapshot(context, selected)
      return Object.entries(snapshot.config.mcpServers).map(([id, entry]) => view(normalized(id, entry), snapshot))
    })
  }
  get(context: McpManagementContext, id: string, scope: Scope): McpServerView {
    const snapshot = this.snapshot(context, scope)
    if (!Object.hasOwn(snapshot.config.mcpServers, id)) throw new McpManagementError(40400, '当前作用域不存在该 MCP 服务器')
    return view(normalized(id, snapshot.config.mcpServers[id]), snapshot)
  }
  prepare(context: McpManagementContext, action: McpManagementAction, raw: unknown): PreparedMcpMutation {
    const input = mcpMutationSchemas[action].parse(raw), projectRoot = this.project(context), snapshot = this.snapshot(context, input.scope)
    const exists = Object.hasOwn(snapshot.config.mcpServers, input.id)
    if (action === 'create' ? exists : !exists) throw new McpManagementError(action === 'create' ? 40900 : 40400, action === 'create' ? '当前作用域已存在该 MCP 服务器' : '当前作用域不存在该 MCP 服务器')
    if ('expectedRevision' in input && input.expectedRevision !== snapshot.revision) throw new McpManagementError(40900, 'MCP 配置已变化，请重新读取后确认')
    const current = exists ? normalized(input.id, snapshot.config.mcpServers[input.id]) : undefined
    let after: McpServerRecord | undefined
    if (action === 'create') {
      const { id, scope: _, ...configuration } = mcpMutationSchemas.create.parse(raw)
      after = changed({ id, name: id, description: '', enabled: false, isBuiltIn: false, createdAt: Math.floor(Date.now() / 1000), updatedAt: 0 } as McpServerRecord, configuration)
    } else if (action === 'update') after = changed(current!, mcpMutationSchemas.update.parse(raw).changes)
    else if (action === 'set_enabled') after = changed(current!, { enabled: mcpMutationSchemas.set_enabled.parse(raw).enabled })
    else if (action === 'test') {
      const denied = extensionPolicy(context)
      if (denied) throw new McpManagementError(40300, '安全模式禁止启动 MCP 扩展；请调整会话安全模式后再申请测试')
      validateConnection(current!)
    }
    return { version: 1, tenantId: context.tenantId, action, id: input.id, scope: input.scope, projectRoot,
      source: snapshot.source, target: snapshot.target, revision: snapshot.revision, argsHash: hashFileContent(JSON.stringify(raw)),
      ...(current ? { before: view(current, snapshot) } : {}), ...(after ? { after: view(after, snapshot) } : {}) }
  }
  async apply(context: McpManagementContext, operation: PreparedMcpMutation, raw: unknown): Promise<Record<string, unknown>> {
    const project = this.project(context)
    if (operation.version !== 1 || operation.tenantId !== context.tenantId || !same(project, operation.projectRoot) || operation.argsHash !== hashFileContent(JSON.stringify(raw)))
      throw new McpManagementError(40300, 'MCP 确认记录不属于当前调用或工作区')
    const initial = this.snapshot(context, operation.scope)
    if (initial.source !== operation.source || initial.target !== operation.target) throw new McpManagementError(40900, 'MCP 配置路径已变化，请重新确认')
    return withFileLocks([initial.source, initial.target], async () => {
      const checked = this.prepare(context, operation.action, raw)
      if (checked.revision !== operation.revision || checked.source !== operation.source || checked.target !== operation.target) throw new McpManagementError(40900, 'MCP 配置在等待确认期间已变化')
      throwIfAborted(context.signal)
      const snapshot = this.snapshot(context, operation.scope), input = mcpMutationSchemas[operation.action].parse(raw)
      if (input.id !== operation.id || input.scope !== operation.scope) throw new McpManagementError(40300, 'MCP 确认目标不匹配')
      const entry = operation.action === 'create' ? undefined : normalized(operation.id, snapshot.config.mcpServers[operation.id])
      if (operation.action === 'test') return this.test(context, entry!)
      if (operation.action === 'delete') delete snapshot.config.mcpServers[operation.id]
      else {
        let replacement: McpServerRecord
        if (operation.action === 'create') {
          const { id, scope: _, ...configuration } = mcpMutationSchemas.create.parse(raw)
          replacement = changed({ id, name: id, description: '', enabled: false, isBuiltIn: false, createdAt: Math.floor(Date.now() / 1000), updatedAt: 0 } as McpServerRecord, configuration)
        } else replacement = changed(entry!, 'changes' in input ? input.changes as Record<string, unknown> : { enabled: 'enabled' in input && input.enabled })
        const { id: _, scope: _scope, ...stored } = replacement
        snapshot.config.mcpServers[operation.id] = stored
      }
      const content = JSON.stringify(snapshot.config, null, 2) + '\n'
      if (Object.keys(snapshot.config.mcpServers).length > MAX_SERVERS) throw new McpManagementError(40001, 'MCP 服务器数量超过 1000')
      if (Buffer.byteLength(content) > MAX_CONFIG) throw new McpManagementError(40001, '保存后的 MCP 配置超过 2 MiB')
      throwIfAborted(context.signal)
      noLinks(snapshot.anchor, snapshot.target)
      fs.mkdirSync(path.dirname(snapshot.target), { recursive: true })
      const temporary = noLinks(snapshot.anchor, path.join(path.dirname(snapshot.target), `.mcp-write-${randomUUID()}.tmp`))
      try {
        const fd = fs.openSync(temporary, 'wx', 0o600)
        try { fs.writeFileSync(fd, content); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
        throwIfAborted(context.signal)
        if (this.snapshot(context, operation.scope).revision !== operation.revision) throw new McpManagementError(40900, 'MCP 配置在保存前已变化')
        fs.renameSync(temporary, snapshot.target)
      } finally { fs.rmSync(temporary, { force: true }) }
      return { resourceChange: { kind: 'mcp', action: operation.action, id: operation.id, scope: operation.scope },
        ...(operation.action === 'delete' ? {} : { server: this.get(context, operation.id, operation.scope) }) }
    })
  }
  private async test(context: McpManagementContext, entry: McpServerRecord): Promise<Record<string, unknown>> {
    const denied = extensionPolicy(context)
    if (denied) throw new McpManagementError(40300, '安全模式禁止启动 MCP 扩展')
    throwIfAborted(context.signal)
    // Testing never changes the saved deadline or invokes a business tool.
    const deadline = AbortSignal.timeout(15_000), signal = context.signal ? AbortSignal.any([context.signal, deadline]) : deadline
    const client = this.clientFactory({ id: entry.id, name: entry.name, transportType: entry.transportType, command: entry.command, args: entry.args,
      env: entry.env, url: entry.url, headers: entry.headers, timeoutMs: Math.min(entry.timeoutMs || 15_000, 15_000) }, context)
    try {
      const tools = await client.toTools(signal)
      throwIfAborted(context.signal)
      const secrets = sensitive(entry)
      return { success: true, serverId: entry.id, toolCount: tools.length, tools: tools.slice(0, 50).map(tool => ({ name: redact(tool.name, secrets, 128) })), truncated: tools.length > 50 }
    } catch (error) {
      if (context.signal?.aborted) throw new DOMException('MCP 连接测试已取消', 'AbortError')
      throw new McpManagementError(50000, deadline.aborted ? 'MCP 连接测试超时（15 秒）' : 'MCP 连接测试失败；请在设置页检查命令、网络地址和凭据')
    } finally {
      try { await client.disconnect() } catch { /* Never expose remote diagnostics or credentials during cleanup. */ }
    }
  }
}
