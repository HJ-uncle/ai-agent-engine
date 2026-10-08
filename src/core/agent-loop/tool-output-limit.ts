import { applyOSMMultiplier } from '../osm.js'
import type { ToolProfile } from '../../tools/tool-profile.js'

export function getToolOutputMaxChars(): number {
  const base = parseInt(process.env.TOOL_OUTPUT_MAX_CHARS ?? '4000', 10)
  return applyOSMMultiplier('toolOutputMaxChars', base)
}

export function getCodeToolOutputMaxChars(): number {
  const configured = parseInt(process.env.CODE_TOOL_OUTPUT_MAX_CHARS ?? '', 10)
  if (Number.isFinite(configured) && configured > 0) return configured
  return 64 * 1024
}

/** Shared with structured tools so the next model turn never cuts their JSON in half. */
export function getToolOutputLimit(profile?: ToolProfile): number {
  return profile === 'code' ? getCodeToolOutputMaxChars() : getToolOutputMaxChars()
}
