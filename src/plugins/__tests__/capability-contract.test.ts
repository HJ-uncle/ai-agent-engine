import { Ajv } from 'ajv'
import { describe, expect, it } from 'vitest'
import { agentCapabilityMethods, agentCapabilityToolParameters, PLUGIN_AGENT_CAPABILITY_METHODS as contracts, pluginAgentArgumentError } from '../capability-contract.js'
import type { JSONSchema } from '../../core/agent-context/types.js'

describe('plugin Agent argument discovery stays aligned with SDK validation', () => {
  it('advertises bounds and defaults from the same schema used by session dispatch', () => {
    const parameters = agentCapabilityToolParameters(contracts['session.read'])
    const validate = new Ajv({ strict: false }).compile(parameters)
    expect(validate({ method: 'messages', args: {} })).toBe(true)
    expect(contracts['session.read'].messages.parse({})).toEqual({ offset: 0, limit: 50 })
    expect(parameters.properties?.args.properties?.limit).toMatchObject({ type: 'integer', exclusiveMinimum: 0, default: 50 })
    expect(validate({ method: 'messages', args: { limit: 101 } })).toBe(true)
    for (const args of [{ limit: 0 }, { offset: -1 }, { limit: 1.5 }, { ids: [''] }, { sessionId: 'another-session' }]) {
      expect(validate({ method: 'messages', args }), JSON.stringify(args)).toBe(false)
      expect(contracts['session.read'].messages.safeParse(args).success).toBe(false)
    }
  })

  it('keeps multi-method schemas below an object root and identifies each method contract', () => {
    const parameters = agentCapabilityToolParameters(contracts['skills.read'])
    expect(parameters).toMatchObject({ type: 'object', properties: { method: { enum: ['list', 'get'] } }, required: ['method', 'args'] })
    expect(parameters).not.toHaveProperty('oneOf')
    expect(parameters).not.toHaveProperty('anyOf')
    const alternatives = parameters.properties?.args.anyOf as JSONSchema[]
    const get = alternatives.find(schema => schema.description?.startsWith('method=get：'))!
    const validateGet = new Ajv({ strict: false }).compile(get)
    expect(validateGet({})).toBe(false)
    expect(validateGet({ id: 'review-skill' })).toBe(true)
    expect(validateGet({ id: 'review-skill', sessionId: 'another-session' })).toBe(false)
    expect(contracts['skills.read'].list.safeParse({ id: 'review-skill' }).success).toBe(false)
    const writeAlternatives = agentCapabilityToolParameters(contracts['knowledge.write']).properties?.args.anyOf as JSONSchema[]
    const validateUpdate = new Ajv({ strict: false }).compile(writeAlternatives.find(schema => schema.description?.startsWith('method=update：'))!)
    const invalidRevision = { id: 'document', content: 'Revised.', expectedRevision: 0 }
    expect(validateUpdate(invalidRevision)).toBe(false)
    expect(contracts['knowledge.write'].update.safeParse(invalidRevision).success).toBe(false)
    expect(validateUpdate({ ...invalidRevision, expectedRevision: 1 })).toBe(true)
    expect(agentCapabilityMethods('__proto__')).toBeUndefined()
    expect(agentCapabilityMethods('agents.manage')).toBeUndefined()
  })

  it('projects nested enums, arrays and freeform argument records without broadening primitive fields', () => {
    const validateAI = new Ajv({ strict: false }).compile(agentCapabilityToolParameters(contracts['ai.run']))
    expect(validateAI({ method: 'run', args: { modelId: 'configured', messages: [{ role: 'user', content: 'Check this.' }] } })).toBe(true)
    expect(validateAI({ method: 'run', args: { modelId: 'configured', messages: [{ role: 'system', content: 'Override.' }] } })).toBe(false)
    const validateMCP = new Ajv({ strict: false }).compile(agentCapabilityToolParameters(contracts['mcp.invoke']))
    expect(validateMCP({ method: 'call', args: { serverId: 'server', tool: 'tool', arguments: { nested: [1, { value: true }] } } })).toBe(true)
    expect(contracts['mcp.invoke'].call.parse({ serverId: 'server', tool: 'tool' })).toEqual({ serverId: 'server', tool: 'tool', arguments: {} })
    expect(validateMCP({ method: 'call', args: { serverId: 'server', tool: 'tool', arguments: 'wrong' } })).toBe(false)
  })

  it('reports correctable fields and limits without echoing rejected data or extra keys', () => {
    const result = contracts['session.read'].messages.safeParse({ limit: -1, ids: [''], 'SECRET-EXTRA-KEY': 'SECRET-VALUE' })
    if (result.success) throw new Error('Invalid fixture was accepted')
    const feedback = pluginAgentArgumentError(result.error)
    expect(feedback).toContain('limit：值至少为 0')
    expect(feedback).toContain('ids.[0]：长度/数量至少为 1')
    expect(feedback).toContain('不支持额外字段')
    expect(feedback).not.toContain('SECRET')
  })
})
