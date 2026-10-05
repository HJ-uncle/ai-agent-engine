/**
 * MCP 服务器配置管理器
 * 围绕 mcp.config.json 提供读写 CRUD 操作
 * 数据格式遵循标准 McpServerRecord
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { logger } from '../../observability/index.js'

// ─── 标准 MCP Server 数据格式 ─────────────────────────────────────────────────
export interface McpServerRecord {
  id: string
  name: string
  description: string
  enabled: boolean
  transportType: 'stdio' | 'sse' | 'http' | 'streamableHttp'
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
  /** Optional per-server tool allow list. Names here are MCP definition names. */
  disabledTools?: string[]
  isBuiltIn: boolean
  githubUrl?: string
  registryId?: string
  createdAt: number
  updatedAt: number
  /** 来源层级（listServers 标注）：project（.aether/mcp.json）| global（~/.aether/mcp.json） */
  scope?: 'project' | 'global'
}

export type CreateMcpServerInput = Omit<McpServerRecord, 'createdAt' | 'updatedAt'>
export type UpdateMcpServerInput = Partial<Omit<McpServerRecord, 'id' | 'createdAt' | 'updatedAt'>>

// ─── 文件结构 ──────────────────────────────────────────────────────────────────
interface MCPConfigFile {
  mcpServers: Record<string, Omit<McpServerRecord, 'id'>>
}

/**
 * MCP 配置文件路径解析。
 *
 * 优先级：
 *   1. MCP_CONFIG_PATH 环境变量（显式指定）
 *   2. <cwd>/.aether/mcp.json（新约定位置，与 aether.json/skills 同目录）
 *   3. <cwd>/mcp.config.json（旧位置，兼容回退）
 *
 * 读写同源：读哪个文件就写哪个文件，避免配置分裂。
 * 首次创建（两处都不存在）时写入 .aether/mcp.json（自动建目录）。
 *
 * 全局层：~/.aether/mcp.json（AETHER_GLOBAL_DIR 可覆盖）在读取时合并，
 * 同名 server 项目级覆盖全局级；写操作默认落项目级文件，显式 global 才修改共享配置。
 */
function resolveConfigPath(projectRoot?: string): string {
  if (process.env.MCP_CONFIG_PATH) {
    return path.resolve(process.env.MCP_CONFIG_PATH)
  }
  const newPath = path.resolve(projectRoot ?? process.cwd(), '.aether', 'mcp.json')
  if (fs.existsSync(newPath)) return newPath
  const legacyPath = path.resolve(projectRoot ?? process.cwd(), 'mcp.config.json')
  if (fs.existsSync(legacyPath)) return legacyPath
  return newPath
}

/** 用户级（全局）MCP 配置路径 */
function resolveGlobalConfigPath(): string {
  const globalDir = process.env.AETHER_GLOBAL_DIR
    ? path.resolve(process.env.AETHER_GLOBAL_DIR)
    : path.join(os.homedir(), '.aether')
  return path.join(globalDir, 'mcp.json')
}

/** 读全局层配置（不存在或解析失败返回空表） */
function readGlobalConfig(): MCPConfigFile {
  const p = resolveGlobalConfigPath()
  if (!fs.existsSync(p)) return { mcpServers: {} }
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf-8')) as MCPConfigFile
    return { mcpServers: raw.mcpServers ?? {} }
  } catch (err) {
    logger.warn({ err, path: p }, 'mcp-config: failed to parse global mcp.json, ignored')
    return { mcpServers: {} }
  }
}

function getConfigPath(projectRoot?: string): string {
  return resolveConfigPath(projectRoot)
}

/** 单文件读取 + 旧格式兼容 */
function readOneConfig(configPath: string): MCPConfigFile {
  if (!fs.existsSync(configPath)) return { mcpServers: {} }
  try {
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as MCPConfigFile
    raw.mcpServers = raw.mcpServers ?? {}
    // 兼容旧格式：自动补全缺失字段
    for (const [id, entry] of Object.entries(raw.mcpServers)) {
      const e = entry as Record<string, unknown>
      // transport → transportType
      if (!e['transportType'] && e['transport']) {
        e['transportType'] = e['transport']
        delete e['transport']
      }
      // disabled → enabled
      if (e['enabled'] === undefined && e['disabled'] !== undefined) {
        e['enabled'] = !e['disabled']
        delete e['disabled']
      }
      // 补充必填字段默认值
      if (!e['name'])        e['name']        = id
      if (!e['description']) e['description'] = ''
      if (e['enabled'] === undefined) e['enabled'] = true
      if (!e['transportType']) e['transportType'] = 'http'
      if (e['isBuiltIn'] === undefined) e['isBuiltIn'] = false
      if (!e['createdAt']) e['createdAt'] = Math.floor(Date.now() / 1000)
      if (!e['updatedAt']) e['updatedAt'] = Math.floor(Date.now() / 1000)
    }
    return raw
  } catch (err) {
    logger.warn({ err, configPath }, 'Failed to parse mcp config file')
    return { mcpServers: {} }
  }
}

/** 读取（双层合并）：全局层 ~/.aether/mcp.json + 项目级，同名项目级覆盖 */
function readConfig(projectRoot?: string): MCPConfigFile {
  const globalCfg = readOneConfig(resolveGlobalConfigPath())
  const projectCfg = readOneConfig(getConfigPath(projectRoot))
  if (Object.keys(globalCfg.mcpServers).length === 0) return projectCfg
  // MCP_CONFIG_PATH 显式指定时为单文件模式，不合并全局层
  if (process.env.MCP_CONFIG_PATH) return projectCfg
  return {
    mcpServers: { ...globalCfg.mcpServers, ...projectCfg.mcpServers },
  }
}

function writeConfigAt(config: MCPConfigFile, configPath = getConfigPath()): void {
  // 新约定位置在 .aether/ 子目录下，写入前确保目录存在
  fs.mkdirSync(path.dirname(configPath), { recursive: true })
  const tmp = `${configPath}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2), 'utf-8')
  fs.renameSync(tmp, configPath)
  logger.info({ configPath }, 'MCP config file updated')
}

/** 写全局层配置文件（scope='global' 的创建/删除走这里） */
function writeGlobalConfig(config: MCPConfigFile): void {
  const p = resolveGlobalConfigPath()
  fs.mkdirSync(path.dirname(p), { recursive: true })
  const tmp = `${p}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2), 'utf-8')
  fs.renameSync(tmp, p)
  logger.info({ path: p }, 'MCP global config file updated')
}

/**
 * Validate and atomically merge one complete MCP JSON document into a layer.
 * Import is intentionally separate from CRUD: paste/import must never leave a
 * half-written configuration when one of several servers is malformed. An
 * imported id replaces the same id in that layer; unrelated servers remain
 * available so importing one server does not silently delete the rest.
 * Unknown keys are retained for forward compatibility, but the runtime only
 * consumes the documented transport/connection fields.
 */
export function importConfigDocument(
  document: unknown,
  scope: 'project' | 'global' = 'project',
  projectRoot?: string,
): McpServerRecord[] {
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    throw new Error('MCP 配置必须是 JSON 对象')
  }
  const root = document as Record<string, unknown>
  const rawServers = root.mcpServers
  if (!rawServers || typeof rawServers !== 'object' || Array.isArray(rawServers)) {
    throw new Error('MCP 配置必须包含 mcpServers 对象')
  }
  const entries = Object.entries(rawServers as Record<string, unknown>)
  const existingConfig = scope === 'global' ? readOneConfig(resolveGlobalConfigPath()) : projectLayerConfig(projectRoot)
  const normalized: Record<string, Omit<McpServerRecord, 'id'>> = { ...existingConfig.mcpServers }
  const now = Math.floor(Date.now() / 1000)
  for (const [id, raw] of entries) {
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(id)) throw new Error(`服务器 id 无效：${id}`)
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`服务器 ${id} 必须是对象`)
    const source = raw as Record<string, unknown>
    const transportType = (source.transportType ?? source.type ?? source.transport) as unknown
    if (!['stdio', 'sse', 'http', 'streamableHttp'].includes(String(transportType))) {
      throw new Error(`服务器 ${id} 的 transport/type 不受支持`)
    }
    const name = typeof source.name === 'string' ? source.name : id
    const description = typeof source.description === 'string' ? source.description : ''
    if (transportType === 'stdio') {
      if (typeof source.command !== 'string' || !source.command.trim()) throw new Error(`服务器 ${id} 缺少 command`)
      if (source.args !== undefined && (!Array.isArray(source.args) || source.args.some(item => typeof item !== 'string'))) throw new Error(`服务器 ${id} 的 args 必须是字符串数组`)
      if (source.env !== undefined && (!source.env || typeof source.env !== 'object' || Array.isArray(source.env) || Object.values(source.env as object).some(item => typeof item !== 'string'))) throw new Error(`服务器 ${id} 的 env 必须是字符串对象`)
    } else {
      if (typeof source.url !== 'string' || !/^https?:\/\//i.test(source.url)) throw new Error(`服务器 ${id} 缺少有效 url`)
      if (source.headers !== undefined && (!source.headers || typeof source.headers !== 'object' || Array.isArray(source.headers) || Object.values(source.headers as object).some(item => typeof item !== 'string'))) throw new Error(`服务器 ${id} 的 headers 必须是字符串对象`)
    }
    if (source.disabledTools !== undefined && (!Array.isArray(source.disabledTools) || source.disabledTools.some(item => typeof item !== 'string'))) throw new Error(`服务器 ${id} 的 disabledTools 必须是字符串数组`)
    const existing = existingConfig.mcpServers[id]
    const { transport: _transport, type: _type, ...rest } = source
    normalized[id] = {
      ...rest as Omit<McpServerRecord, 'id'>,
      name,
      description,
      enabled: source.enabled !== false,
      transportType: String(transportType) as McpServerRecord['transportType'],
      isBuiltIn: source.isBuiltIn === true,
      createdAt: typeof source.createdAt === 'number' ? source.createdAt : (existing?.createdAt ?? now),
      updatedAt: now,
    }
  }
  const target: MCPConfigFile = { mcpServers: normalized }
  if (scope === 'global') writeGlobalConfig(target)
  else writeConfigAt(target, getConfigPath(projectRoot))
  return Object.entries(normalized).map(([id, entry]) => toRecord(id, { ...entry, scope }))
}

/** Return the editable JSON shape, preserving standard names used by MCP clients. */
export function exportConfigDocument(projectRoot?: string, scope?: 'project' | 'global'): { mcpServers: Record<string, unknown> } {
  const config = scope === 'global' ? readOneConfig(resolveGlobalConfigPath()) : scope === 'project' ? projectLayerConfig(projectRoot) : readConfig(projectRoot)
  const mcpServers = Object.fromEntries(Object.entries(config.mcpServers).map(([id, entry]) => {
    const { id: _id, createdAt: _createdAt, updatedAt: _updatedAt, isBuiltIn: _isBuiltIn, scope: _scope, transportType, ...editable } = { id, ...entry } as McpServerRecord
    return [id, { ...editable, type: transportType }]
  }))
  return { mcpServers }
}

function toRecord(id: string, entry: Omit<McpServerRecord, 'id'>): McpServerRecord {
  return { id, ...entry }
}

// ─── CRUD ─────────────────────────────────────────────────────────────────────
// 写操作基于「项目层单文件视图」，绝不把全局层内容写回项目文件（防写穿透）。
// 覆盖语义：项目层 create/update 同名 id 即覆盖全局层定义（git config local 语义）。

/** 写操作基底：仅项目层文件内容 */
function projectLayerConfig(projectRoot?: string): MCPConfigFile {
  return readOneConfig(getConfigPath(projectRoot))
}

export function listServers(projectRoot?: string, scope?: 'project' | 'global'): McpServerRecord[] {
  // An explicit layer query is management-oriented: expose the raw layer so a
  // project override does not hide the global definition from an administrator.
  if (scope === 'global') {
    return Object.entries(readOneConfig(resolveGlobalConfigPath()).mcpServers)
      .map(([id, e]) => toRecord(id, { ...e, scope: 'global' }))
  }
  if (scope === 'project') {
    return Object.entries(projectLayerConfig(projectRoot).mcpServers)
      .map(([id, e]) => toRecord(id, { ...e, scope: 'project' }))
  }
  const config = readConfig(projectRoot)
  // 标注来源层级：项目文件里有的 key → project，其余来自全局层 → global
  const projectKeys = new Set(Object.keys(projectLayerConfig(projectRoot).mcpServers))
  return Object.entries(config.mcpServers)
    .map(([id, e]) => toRecord(id, { ...e, scope: projectKeys.has(id) ? 'project' : 'global' }))
}

export function getServer(id: string, projectRoot?: string, scope?: 'project' | 'global'): McpServerRecord | null {
  const config = scope === 'global' ? readOneConfig(resolveGlobalConfigPath()) : readConfig(projectRoot)
  const e = config.mcpServers[id]
  const effectiveScope = scope ?? (projectLayerConfig(projectRoot).mcpServers[id] ? 'project' : 'global')
  return e ? toRecord(id, { ...e, scope: effectiveScope }) : null
}

/** A transport switch must not retain credentials from the previous transport. */
function transportFields(entry: Omit<McpServerRecord, 'id'>): Omit<McpServerRecord, 'id'> {
  const result = { ...entry }
  delete result.scope
  if (result.transportType === 'stdio') {
    delete result.url
    delete result.headers
  } else {
    delete result.command
    delete result.args
    delete result.env
  }
  return result
}

export function createServer(input: CreateMcpServerInput & { scope?: 'project' | 'global' }, projectRoot?: string): McpServerRecord {
  const { scope = 'project', ...rest } = input
  const target = scope === 'global' ? readOneConfig(resolveGlobalConfigPath()) : projectLayerConfig(projectRoot)
  if (target.mcpServers[input.id]) {
    throw new Error(`MCP server "${input.id}" already exists`)
  }
  const now = Math.floor(Date.now() / 1000)
  const { id, ...entry } = rest
  const full = transportFields({ ...entry, createdAt: now, updatedAt: now })
  target.mcpServers[id] = full
  if (scope === 'global') writeGlobalConfig(target)
  else writeConfigAt(target, getConfigPath(projectRoot))
  return toRecord(id, { ...full, scope })
}

export function updateServer(
  id: string,
  patch: UpdateMcpServerInput,
  projectRoot?: string,
  scope: 'project' | 'global' = 'project',
): McpServerRecord | null {
  // The effective list merges global and project layers. A caller that edits a
  // global entry must explicitly select global; otherwise an edit would
  // silently create a project override and leave the shared definition stale.
  const config = scope === 'global'
    ? readOneConfig(resolveGlobalConfigPath())
    : projectLayerConfig(projectRoot)
  if (!config.mcpServers[id]) {
    if (scope === 'global') return null
    // Project edits preserve the existing overlay semantics: if only a global
    // definition exists, promote it into this project's config before patching.
    const globalEntry = readGlobalConfig().mcpServers[id]
    if (!globalEntry) return null
    logger.info({ id }, 'mcp-config: promoting global server to project-level override')
    config.mcpServers[id] = globalEntry
  }
  config.mcpServers[id] = transportFields({
    ...config.mcpServers[id],
    ...patch,
    updatedAt: Math.floor(Date.now() / 1000),
  })
  if (scope === 'global') writeGlobalConfig(config)
  else writeConfigAt(config, getConfigPath(projectRoot))
  return toRecord(id, { ...config.mcpServers[id], scope })
}

export function deleteServer(id: string, scope: 'project' | 'global' = 'project', projectRoot?: string): boolean {
  if (scope === 'global') {
    const config = readOneConfig(resolveGlobalConfigPath())
    if (!config.mcpServers[id]) return false
    delete config.mcpServers[id]
    writeGlobalConfig(config)
    return true
  }
  const config = projectLayerConfig(projectRoot)
  if (!config.mcpServers[id]) return false
  delete config.mcpServers[id]
  writeConfigAt(config, getConfigPath(projectRoot))
  return true
}

export function toggleServer(id: string, enabled: boolean, projectRoot?: string, scope: 'project' | 'global' = 'project'): McpServerRecord | null {
  return updateServer(id, { enabled }, projectRoot, scope)
}
