import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentContext } from '../../agent-context/types.js'
import { boundedToolContext, getToolOutputLimit } from '../tool-output-limit.js'

afterEach(() => vi.unstubAllEnvs())

describe('per-invocation batch output allowance', () => {
  it('isolates concurrent siblings and clamps descendants without mutating the parent', () => {
    vi.stubEnv('OSM_MODE', 'off')
    vi.stubEnv('TOOL_OUTPUT_MAX_CHARS', '4000')
    const ctx = { toolProfile: 'general', signal: new AbortController().signal } as AgentContext
    const first = boundedToolContext(ctx, 1000), second = boundedToolContext(ctx, 2000)
    expect(getToolOutputLimit(ctx.toolProfile, ctx)).toBe(4000)
    expect(getToolOutputLimit(first.toolProfile, first)).toBe(1000)
    expect(getToolOutputLimit(second.toolProfile, second)).toBe(2000)
    expect(getToolOutputLimit(first.toolProfile, boundedToolContext(first, 9000))).toBe(1000)
    expect(first.signal).toBe(ctx.signal)
    expect(Object.keys(first)).toEqual(Object.keys(ctx))
    expect(JSON.stringify(first)).toBe(JSON.stringify(ctx))
  })

  it.each([0, -1, NaN, Infinity])('rejects invalid scope allowance %s', limit => {
    expect(() => boundedToolContext({} as AgentContext, limit)).toThrow()
  })
})
