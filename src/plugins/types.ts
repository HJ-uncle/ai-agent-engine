import type { PluginContributions } from './contributions.js'
import type { PluginCapabilityId } from './capabilities.js'
import type { PluginHostContext } from './host-context.js'
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
  contributes?: PluginContributions
  /** Requested capabilities are declarations only; grants are stored separately and default to deny. */
  permissions?: { requested: PluginCapabilityId[] }
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
  /** User grants, always a subset of manifest.permissions.requested. */
  permissionGrants?: PluginCapabilityId[]
  permissionRevision?: number
  /** User-owned Agent tool deny list, independent of plugin-controlled settings and version. */
  agentDisabledTools?: string[]
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
  /** True when stderr is a 64 KiB tail preview; execution itself is not truncated. */
  stderrTruncated?: boolean
  durationMs: number
}
export interface PluginRunOptions {
  signal?: AbortSignal
  cwd?: string
  /** Optional caller policy. Omitted or 0 means no extra plugin-specific ceiling. */
  timeoutMs?: number
  maxInputBytes?: number
  maxOutputBytes?: number
  maxStderrBytes?: number
  /** Optional host policy; omitted or 0 adds no plugin-specific memory ceiling. */
  maxMemoryMb?: number
  /** Service-created snapshots carry a tenant identity only to scope resource limits. */
  tenantId?: string
  /** Host-owned dispatch; child requests cannot choose tenant, plugin, revision or bound session. */
  capability?: (call: { capability: string; method: string; args: Record<string, unknown> }, signal: AbortSignal,
    onEvent?: import('./capability-stream-types.js').PluginStreamListener) => Promise<unknown>
  hostContext?: PluginHostContext & { sessionId?: string | null; workspacePath?: string | null }
}

export class PluginError extends Error {
  constructor(public readonly code: string, message: string, public readonly statusCode = 400) {
    super(message)
    this.name = 'PluginError'
  }
}
