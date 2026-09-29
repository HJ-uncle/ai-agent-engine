import type { ModelCapabilities } from './index.js'

/** Omitted = preserve; null = inherit; false = explicitly disable. */
export type CapabilityOverridePatch = {
  [Key in keyof ModelCapabilities]?: ModelCapabilities[Key] | null
}

const booleanKeys = new Set([
  'vision', 'video', 'audio', 'thinking', 'toolCalling', 'jsonMode', 'search',
  'caching', 'parallelTools', 'streamUsage', 'prefix',
])

export function parseCapabilityOverridePatch(value: unknown): CapabilityOverridePatch | null | undefined {
  if (value === undefined || value === null) return value
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('capabilityOverrides must be an object or null')
  for (const [key, item] of Object.entries(value)) {
    if (!booleanKeys.has(key) && key !== 'contextWindow') throw new Error(`Unknown capability override: ${key}`)
    if (item === undefined || item === null) continue
    if (key === 'contextWindow') {
      if (typeof item !== 'number' || !Number.isSafeInteger(item) || item <= 0) {
        throw new Error('contextWindow must be a positive integer or null')
      }
    } else if (typeof item !== 'boolean') throw new Error(`${key} must be boolean or null`)
  }
  return value as CapabilityOverridePatch
}

/** The old write field has the same patch semantics; it cannot be mixed with the explicit field. */
export function capabilityPatchFromInput(input: {
  capabilities?: unknown
  capabilityOverrides?: unknown
}): CapabilityOverridePatch | null | undefined {
  if (input.capabilities !== undefined && input.capabilityOverrides !== undefined) {
    throw new Error('Use capabilityOverrides or capabilities, not both')
  }
  return parseCapabilityOverridePatch(
    input.capabilityOverrides !== undefined ? input.capabilityOverrides : input.capabilities,
  )
}

export function mergeCapabilityOverrides(
  existing: ModelCapabilities | null | undefined,
  patch: CapabilityOverridePatch | null | undefined,
): ModelCapabilities | null {
  if (patch === undefined) return existing ?? null
  if (patch === null) return null
  const next = { ...existing }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    if (value === null) delete next[key as keyof ModelCapabilities]
    else Object.assign(next, { [key]: value })
  }
  return next
}
