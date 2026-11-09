import { applyOSMMultiplier } from '../osm.js'
import type { ToolProfile } from '../../tools/tool-profile.js'
import type { AgentContext } from '../agent-context/types.js'

// Internal invocation scopes only: neither model arguments nor persisted session
// configuration can raise a batch item's output allowance.
const invocationLimits = new WeakMap<AgentContext, number>()

export function boundedToolContext(ctx: AgentContext, limit: number): AgentContext {
  if (!Number.isFinite(limit) || limit < 1) throw new Error('Tool output allowance must be a positive finite number')
  const bounded = { ...ctx }
  invocationLimits.set(bounded, Math.min(getToolOutputLimit(ctx.toolProfile, ctx), Math.floor(limit)))
  return bounded
}

export function getToolOutputMaxChars(): number {
  const configured = parseInt(process.env.TOOL_OUTPUT_MAX_CHARS ?? '', 10)
  // A zero/negative/NaN cap cannot carry even an error receipt; match Code's fallback policy.
  const base = Number.isFinite(configured) && configured > 0 ? configured : 4000
  return applyOSMMultiplier('toolOutputMaxChars', base)
}

export function getCodeToolOutputMaxChars(): number {
  const configured = parseInt(process.env.CODE_TOOL_OUTPUT_MAX_CHARS ?? '', 10)
  if (Number.isFinite(configured) && configured > 0) return configured
  return 64 * 1024
}

/** Shared with structured tools so the next model turn never cuts their JSON in half. */
export function getToolOutputLimit(profile?: ToolProfile, ctx?: AgentContext): number {
  const limit = profile === 'code' ? getCodeToolOutputMaxChars() : getToolOutputMaxChars()
  return Math.min(limit, ctx ? invocationLimits.get(ctx) ?? limit : limit)
}
