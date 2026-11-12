import { describe, expect, it } from 'vitest'
import { compilePluginSchema, validatePluginArguments } from '../schema.js'
import { PluginService } from '../service.js'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

describe('bounded plugin input schemas', () => {
  it('validates nested draft-07 properties, required fields, arrays, bounds and branches without mutation', () => {
    const schema = { type: 'object', properties: {
      label: { type: 'string', minLength: 2, maxLength: 8 },
      values: { type: 'array', items: { type: 'integer', minimum: 0 }, minItems: 1, maxItems: 3 },
      mode: { enum: ['fast', 'careful'], default: 'fast' },
      choice: { anyOf: [{ type: 'string' }, { type: 'integer' }] },
    }, required: ['label', 'values'], additionalProperties: false }
    const value = { label: '苹果', values: [0, 3], choice: 7 }
    expect(() => validatePluginArguments(schema, value)).not.toThrow()
    expect(value).not.toHaveProperty('mode')
    for (const invalid of [
      { label: 'x', values: [1] }, { label: 'hello', values: ['1'] }, { label: 'hello', values: [-1] },
      { label: 'hello', values: [] }, { label: 'hello', values: [1, 2, 3, 4] },
      { values: [1] }, { label: 'hello', values: [1], extra: true }, { label: 'hello', values: [1], mode: 'unknown' },
    ]) expect(() => validatePluginArguments(schema, invalid)).toThrow(expect.objectContaining({ code: 'PLUGIN_ARGUMENTS' }))
  })

  it.each([
    { type: 'object', properties: { value: { type: 'nonsense' } } },
    { type: 'object', required: 'value' },
    { type: 'object', properties: { value: { minimum: 'zero' } } },
    { type: 'object', unknownKeyword: true },
    { type: 'object', properties: { value: { $ref: 'https://example.invalid/schema' } } },
    { type: 'object', properties: { value: { $ref: '#/definitions/value' } }, definitions: { value: { type: 'string' } } },
    { type: 'object', patternProperties: { '^(a+)+$': { type: 'string' } } },
    { type: 'object', properties: { value: { type: 'string', pattern: '^(a+)+$' } } },
    { type: 'object', properties: { value: { type: 'string', format: 'email' } } },
    { type: 'object', properties: { value: { type: 'array', uniqueItems: true } } },
    { type: 'object', $async: true },
  ])('rejects malformed, unresolved or potentially expensive schemas before execution: %j', schema => {
    expect(() => compilePluginSchema(schema)).toThrow(expect.objectContaining({ code: 'PLUGIN_SCHEMA' }))
  })

  it('bounds schema size, depth and compiler branches, catches cycles, and permits harmless shared objects', () => {
    const recursive: Record<string, unknown> = { type: 'object' }; recursive.properties = { self: recursive }
    expect(() => compilePluginSchema(recursive)).toThrow(expect.objectContaining({ code: 'PLUGIN_SCHEMA' }))
    let nested: Record<string, unknown> = { type: 'string' }
    for (let index = 0; index < 30; index++) nested = { type: 'object', properties: { nested } }
    expect(() => compilePluginSchema(nested)).toThrow()
    expect(() => compilePluginSchema({ type: 'object', description: 'x'.repeat(65 * 1024) })).toThrow()
    expect(() => compilePluginSchema({ type: 'object', anyOf: Array.from({ length: 9 }, () => ({ type: 'object' })) })).toThrow()
    const common = { type: 'string' }
    expect(() => compilePluginSchema({ type: 'object', properties: { a: common, b: common } })).not.toThrow()
  })

  it('treats schema-like data as user property names or enum values and only accepts own argument properties', () => {
    const schema = { type: 'object', properties: {
      pattern: { type: 'string' }, format: { type: 'string' },
      payload: { enum: [{ pattern: 'safe literal', $ref: 'also a literal' }] },
    }, required: ['pattern'], additionalProperties: false }
    expect(() => validatePluginArguments(schema, { pattern: 'ok', payload: { pattern: 'safe literal', $ref: 'also a literal' } })).not.toThrow()
    expect(() => validatePluginArguments(schema, Object.create({ pattern: 'inherited' }))).toThrow()
  })

  it('rejects invalid schema creation without committing a plugin directory', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-schema-'))
    try {
      const service = new PluginService(path.join(root, 'plugins'))
      await expect(service.create('tenant', { manifest: { apiVersion: 1, id: 'invalid-schema', name: 'Invalid schema',
        description: 'must never commit', version: '1', runtime: 'node', tools: [
          { name: 'run', description: 'test', inputSchema: { type: 'object', required: 'bad' }, entry: 'main.mjs' },
        ] }, files: { 'main.mjs': 'throw new Error("must not execute")' } })).rejects.toMatchObject({ code: 'PLUGIN_SCHEMA' })
      expect(await service.list('tenant')).toEqual([])
    } finally {
      if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('plugin-schema-')) throw new Error('Unsafe schema test cleanup')
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
    }
  })
})
