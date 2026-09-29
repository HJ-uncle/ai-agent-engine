import { getDb } from './db.js'
import { v4 as uuidv4 } from 'uuid'
import { encrypt, decrypt } from '../../utils/encryption.js'
import type { Row } from '@libsql/client'
import type { ModelCapabilities } from '../../core/model-capabilities/index.js'
import { capabilityPatchFromInput, type CapabilityOverridePatch } from '../../core/model-capabilities/overrides.js'

export type ModelUpdate = Omit<Partial<ModelConfig>, 'capabilities'> & {
  capabilities?: CapabilityOverridePatch | null
  capabilityOverrides?: CapabilityOverridePatch | null
}

export interface ModelConfig {
  id: string
  tenantId: string
  provider: string
  modelId: string
  apiKey: string
  baseUrl: string
  displayName?: string
  isEnabled: boolean
  version?: string
  /** 模型能力 override（JSON 持久化） */
  capabilities?: ModelCapabilities | null
  createdAt: number
  updatedAt: number
}

export interface ModelWhitelist {
  id: number
  provider: string
  modelId: string
  thinkingMode: boolean
  thinkingConfig: any
  responseThinkingField: string | null
}

function mapModelRow(row: Row): ModelConfig {
  let apiKey = ''
  try {
    apiKey = decrypt(row['api_key'] as string)
  } catch {
    // Decryption failed - likely due to ENCRYPTION_KEY change.
    // Return empty string; user must re-enter the API key.
    apiKey = ''
  }

  let capabilities: ModelCapabilities | null = null
  const capsRaw = row['capabilities']
  if (capsRaw && typeof capsRaw === 'string') {
    try {
      capabilities = JSON.parse(capsRaw) as ModelCapabilities
    } catch {
      capabilities = null
    }
  }

  return {
    id: row['id'] as string,
    tenantId: row['tenant_id'] as string,
    provider: row['provider'] as string,
    modelId: row['model_id'] as string,
    apiKey,
    baseUrl: row['base_url'] as string,
    displayName: row['display_name'] as string | undefined,
    isEnabled: Boolean(row['is_enabled']),
    version: row['version'] as string | undefined,
    capabilities,
    createdAt: row['created_at'] as number,
    updatedAt: row['updated_at'] as number
  }
}

export class ModelsStore {
  async getWhitelists(): Promise<ModelWhitelist[]> {
    const db = getDb()
    const result = await db.execute('SELECT * FROM model_whitelists')
    return result.rows.map(row => ({
      id: row['id'] as number,
      provider: row['provider'] as string,
      modelId: row['model_id'] as string,
      thinkingMode: Boolean(row['thinking_mode']),
      thinkingConfig: row['thinking_config'] ? JSON.parse(row['thinking_config'] as string) : null,
      responseThinkingField: row['response_thinking_field'] as string | null
    }))
  }

  async getModels(tenantId: string): Promise<ModelConfig[]> {
    const db = getDb()
    const result = await db.execute({
      sql: 'SELECT * FROM models WHERE tenant_id = ? AND deleted_at IS NULL ORDER BY created_at DESC',
      args: [tenantId]
    })
    return result.rows.map(mapModelRow)
  }

  async getModelById(id: string, tenantId: string): Promise<ModelConfig | null> {
    const db = getDb()
    const result = await db.execute({
      sql: 'SELECT * FROM models WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL',
      args: [id, tenantId]
    })
    if (result.rows.length === 0) return null
    return mapModelRow(result.rows[0])
  }

  async createModel(data: Omit<ModelConfig, 'id' | 'createdAt' | 'updatedAt'>): Promise<ModelConfig> {
    const db = getDb()
    const id = uuidv4()
    const encryptedKey = encrypt(data.apiKey)

    await db.execute({
      sql: `INSERT INTO models (id, tenant_id, provider, model_id, api_key, base_url, display_name, is_enabled, version, capabilities)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        id, data.tenantId, data.provider, data.modelId, encryptedKey, data.baseUrl,
        data.displayName || null, data.isEnabled ? 1 : 0, data.version || null,
        data.capabilities ? JSON.stringify(data.capabilities) : null,
      ]
    })

    return this.getModelById(id, data.tenantId) as Promise<ModelConfig>
  }

  async updateModel(id: string, tenantId: string, data: ModelUpdate): Promise<ModelConfig | null> {
    const db = getDb()
    const capabilityPatch = capabilityPatchFromInput(data)

    const updates: string[] = []
    const args: any[] = []

    if (data.apiKey) {
      updates.push('api_key = ?')
      args.push(encrypt(data.apiKey))
    }
    if (data.baseUrl) {
      updates.push('base_url = ?')
      args.push(data.baseUrl)
    }
    if (data.displayName !== undefined) {
      updates.push('display_name = ?')
      args.push(data.displayName)
    }
    if (data.isEnabled !== undefined) {
      updates.push('is_enabled = ?')
      args.push(data.isEnabled ? 1 : 0)
    }
    if (data.version !== undefined) {
      updates.push('version = ?')
      args.push(data.version)
    }
    if (capabilityPatch !== undefined) {
      if (capabilityPatch === null) {
        updates.push('capabilities = NULL')
      } else {
        // SQLite merge-patch changes only supplied keys atomically, preserving concurrent edits.
        // JSON null removes one override; JSON false remains an explicit disabled capability.
        updates.push("capabilities = json_patch(COALESCE(capabilities, '{}'), ?)")
        args.push(JSON.stringify(capabilityPatch))
      }
    }

    if (updates.length === 0) return this.getModelById(id, tenantId)

    updates.push('updated_at = (unixepoch())')
    args.push(id, tenantId)

    await db.execute({
      sql: `UPDATE models SET ${updates.join(', ')} WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL`,
      args
    })

    return this.getModelById(id, tenantId)
  }

  async deleteModel(id: string, tenantId: string): Promise<void> {
    const db = getDb()
    await db.execute({
      sql: 'UPDATE models SET deleted_at = (unixepoch()) WHERE id = ? AND tenant_id = ?',
      args: [id, tenantId]
    })
  }
}
