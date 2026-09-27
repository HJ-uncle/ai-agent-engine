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
 * 同名 server 项目级覆盖全局级；写操作永远只落项目级文件，避免多项目写穿透。
 */
function resolveConfigPath(): string {
  if (process.env.MCP_CONFIG_PATH) {
    return path.resolve(process.env.MCP_CONFIG_PATH)
  }
  const newPath = path.resolve(process.cwd(), '.aether', 'mcp.json')
  if (fs.existsSync(newPath)) return newPath
  const legacyPath = path.resolve(process.cwd(), 'mcp.config.json')
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

function getConfigPath(): string {
  return resolveConfigPath()
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
function readConfig(): MCPConfigFile {
  const globalCfg = readOneConfig(resolveGlobalConfigPath())
  const projectCfg = readOneConfig(getConfigPath())
  if (Object.keys(globalCfg.mcpServers).length === 0) return projectCfg
  // MCP_CONFIG_PATH 显式指定时为单文件模式，不合并全局层
  if (process.env.MCP_CONFIG_PATH) return projectCfg
  return {
    mcpServers: { ...globalCfg.mcpServers, ...projectCfg.mcpServers },
  }
}

function writeConfig(config: MCPConfigFile): void {
  const configPath = getConfigPath()
  // 新约定位置在 .aether/ 子目录下，写入前确保目录存在
  fs.mkdirSync(path.dirname(configPath), { recursive: true })
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8')
  logger.info({ configPath }, 'MCP config file updated')
}

/** 写全局层配置文件（scope='global' 的创建/删除走这里） */
function writeGlobalConfig(config: MCPConfigFile): void {
  const p = resolveGlobalConfigPath()
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, JSON.stringify(config, null, 2), 'utf-8')
  logger.info({ path: p }, 'MCP global config file updated')
}

function toRecord(id: string, entry: Omit<McpServerRecord, 'id'>): McpServerRecord {
  return { id, ...entry }
}

// ─── CRUD ─────────────────────────────────────────────────────────────────────
// 写操作基于「项目层单文件视图」，绝不把全局层内容写回项目文件（防写穿透）。
// 覆盖语义：项目层 create/update 同名 id 即覆盖全局层定义（git config local 语义）。

/** 写操作基底：仅项目层文件内容 */
function projectLayerConfig(): MCPConfigFile {
  return readOneConfig(getConfigPath())
}

export function listServers(): McpServerRecord[] {
  const config = readConfig()
  // 标注来源层级：项目文件里有的 key → project，其余来自全局层 → global
  const projectKeys = new Set(Object.keys(projectLayerConfig().mcpServers))
  return Object.entries(config.mcpServers).map(([id, e]) =>
    toRecord(id, { ...e, scope: projectKeys.has(id) ? 'project' : 'global' }),
  )
}

export function getServer(id: string): McpServerRecord | null {
  const config = readConfig()
  const e = config.mcpServers[id]
  return e ? toRecord(id, e) : null
}

export function createServer(input: CreateMcpServerInput & { scope?: 'project' | 'global' }): McpServerRecord {
  const { scope = 'project', ...rest } = input
  const target = scope === 'global' ? readOneConfig(resolveGlobalConfigPath()) : projectLayerConfig()
  if (target.mcpServers[input.id]) {
    throw new Error(`MCP server "${input.id}" already exists`)
  }
  const now = Math.floor(Date.now() / 1000)
  const { id, ...entry } = rest
  const full: Omit<McpServerRecord, 'id'> = { ...entry, createdAt: now, updatedAt: now }
  target.mcpServers[id] = full
  if (scope === 'global') writeGlobalConfig(target)
  else writeConfig(target)
  return toRecord(id, { ...full, scope })
}

export function updateServer(id: string, patch: UpdateMcpServerInput): McpServerRecord | null {
  const config = projectLayerConfig()
  if (!config.mcpServers[id]) {
    // 项目层无此 server：若全局层有，则提升全局定义为项目级覆盖后再改；
    // 两层都没有才返回 null
    const globalEntry = readGlobalConfig().mcpServers[id]
    if (!globalEntry) return null
    logger.info({ id }, 'mcp-config: promoting global server to project-level override')
    config.mcpServers[id] = globalEntry
  }
  config.mcpServers[id] = {
    ...config.mcpServers[id],
    ...patch,
    updatedAt: Math.floor(Date.now() / 1000),
  }
  writeConfig(config)
  return toRecord(id, config.mcpServers[id])
}

export function deleteServer(id: string, scope: 'project' | 'global' = 'project'): boolean {
  if (scope === 'global') {
    const config = readOneConfig(resolveGlobalConfigPath())
    if (!config.mcpServers[id]) return false
    delete config.mcpServers[id]
    writeGlobalConfig(config)
    return true
  }
  const config = projectLayerConfig()
  if (!config.mcpServers[id]) return false
  delete config.mcpServers[id]
  writeConfig(config)
  return true
}

export function toggleServer(id: string, enabled: boolean): McpServerRecord | null {
  return updateServer(id, { enabled })
}