/**
 * MCP 服务器配置管理器
 * 围绕 mcp.config.json 提供读写 CRUD 操作
 * 数据格式遵循标准 McpServerRecord
 */

import fs from 'node:fs'
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
}

export type CreateMcpServerInput = Omit<McpServerRecord, 'createdAt' | 'updatedAt'>
export type UpdateMcpServerInput = Partial<Omit<McpServerRecord, 'id' | 'createdAt' | 'updatedAt'>>

// ─── 文件结构 ──────────────────────────────────────────────────────────────────
interface MCPConfigFile {
  mcpServers: Record<string, Omit<McpServerRecord, 'id'>>
}

function getConfigPath(): string {
  return path.resolve(process.env.MCP_CONFIG_PATH ?? './mcp.config.json')
}

function readConfig(): MCPConfigFile {
  const configPath = getConfigPath()
  if (!fs.existsSync(configPath)) return { mcpServers: {} }
  try {
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as MCPConfigFile
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
    logger.warn({ err, configPath }, 'Failed to parse mcp.config.json')
    return { mcpServers: {} }
  }
}

function writeConfig(config: MCPConfigFile): void {
  const configPath = getConfigPath()
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8')
  logger.info({ configPath }, 'mcp.config.json updated')
}

function toRecord(id: string, entry: Omit<McpServerRecord, 'id'>): McpServerRecord {
  return { id, ...entry }
}

// ─── CRUD ─────────────────────────────────────────────────────────────────────

export function listServers(): McpServerRecord[] {
  const config = readConfig()
  return Object.entries(config.mcpServers).map(([id, e]) => toRecord(id, e))
}

export function getServer(id: string): McpServerRecord | null {
  const config = readConfig()
  const e = config.mcpServers[id]
  return e ? toRecord(id, e) : null
}

export function createServer(input: CreateMcpServerInput): McpServerRecord {
  const config = readConfig()
  if (config.mcpServers[input.id]) {
    throw new Error(`MCP server "${input.id}" already exists`)
  }
  const now = Math.floor(Date.now() / 1000)
  const { id, ...rest } = input
  const entry: Omit<McpServerRecord, 'id'> = { ...rest, createdAt: now, updatedAt: now }
  config.mcpServers[id] = entry
  writeConfig(config)
  return toRecord(id, entry)
}

export function updateServer(id: string, patch: UpdateMcpServerInput): McpServerRecord | null {
  const config = readConfig()
  if (!config.mcpServers[id]) return null
  config.mcpServers[id] = {
    ...config.mcpServers[id],
    ...patch,
    updatedAt: Math.floor(Date.now() / 1000),
  }
  writeConfig(config)
  return toRecord(id, config.mcpServers[id])
}

export function deleteServer(id: string): boolean {
  const config = readConfig()
  if (!config.mcpServers[id]) return false
  delete config.mcpServers[id]
  writeConfig(config)
  return true
}

export function toggleServer(id: string, enabled: boolean): McpServerRecord | null {
  return updateServer(id, { enabled })
}