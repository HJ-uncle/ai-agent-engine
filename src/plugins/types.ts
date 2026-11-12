export interface PluginToolManifest {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  /** A UTF-8 .mjs file in this immutable revision. */
  entry: string
}

export interface PluginManifest {
  apiVersion: 1
  id: string
  name: string
  version: string
  description: string
  runtime: 'node'
  tools: PluginToolManifest[]
}

export interface PluginRevision { revision: number; hash: string; createdAt: number; publishedAt?: number }
export interface PluginRecord {
  id: string
  name: string
  description: string
  enabled: boolean
  revision: number
  publishedRevision?: number
  manifest: PluginManifest
  files: Record<string, string>
  revisions: PluginRevision[]
  source?: Record<string, unknown>
  createdAt: number
  updatedAt: number
}

export interface PluginSnapshot {
  id: string
  tenantId: string
  manifest: PluginManifest
  files: Record<string, string>
  directory: string
  hash: string
  revision: number
}

export interface CreatePluginInput {
  manifest: PluginManifest
  files: Record<string, string>
  source?: Record<string, unknown>
}
export interface UpdatePluginInput extends CreatePluginInput { expectedRevision: number }
export interface PluginArtifact { path: string; content: string; encoding?: 'utf8' | 'base64' }
export interface PluginRunResult {
  result: unknown
  artifacts: PluginArtifact[]
  stderr: string
  durationMs: number
}
export interface PluginRunOptions {
  signal?: AbortSignal
  cwd?: string
  timeoutMs?: number
  maxInputBytes?: number
  maxOutputBytes?: number
  maxStderrBytes?: number
  /** Service-created snapshots carry a tenant identity only to scope resource limits. */
  tenantId?: string
}

export class PluginError extends Error {
  constructor(public readonly code: string, message: string, public readonly statusCode = 400) {
    super(message)
    this.name = 'PluginError'
  }
}
