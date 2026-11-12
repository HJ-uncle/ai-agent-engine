import { Ajv, type ValidateFunction } from 'ajv'
import { PluginError } from './types.js'

const validators = new Map<string, ValidateFunction>()
const MAX_CACHE = 32
const schemaChildren = new Set(['items', 'additionalItems', 'additionalProperties', 'contains', 'propertyNames', 'not', 'if', 'then', 'else'])
const schemaMaps = new Set(['properties', 'definitions', '$defs'])
const schemaLists = new Set(['allOf', 'anyOf', 'oneOf'])
const unsupported = new Set(['$ref', '$dynamicRef', '$recursiveRef', '$async', '$data', 'pattern', 'patternProperties', 'format'])
const invalid = (message: string): never => { throw new PluginError('PLUGIN_SCHEMA', message) }

/** Bounded draft-07 subset. No reference resolution, plugin regexes or quadratic uniqueness checks. */
function boundedSchema(root: Record<string, unknown>): string {
  const active = new Set<object>()
  const queue: Array<{ value: unknown; depth: number; exit?: boolean }> = [{ value: root, depth: 0 }]
  let nodes = 0
  while (queue.length) {
    const { value, depth, exit } = queue.pop()!
    if (exit) { active.delete(value as object); continue }
    if (++nodes > 4096 || depth > 24) invalid('插件 inputSchema 超过结构复杂度限制')
    if (typeof value === 'number' && !Number.isFinite(value)) invalid('插件 inputSchema 只能包含 JSON 值')
    if (typeof value === 'undefined' || typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') invalid('插件 inputSchema 只能包含 JSON 值')
    if (value && typeof value === 'object') {
      if (active.has(value)) invalid('插件 inputSchema 不可包含循环对象')
      active.add(value)
      queue.push({ value, depth, exit: true })
      for (const item of Object.values(value)) queue.push({ value: item, depth: depth + 1 })
    }
  }
  let json: string
  try { json = JSON.stringify(root) } catch { return invalid('插件 inputSchema 不是有效 JSON') }
  if (root.type !== 'object' || Buffer.byteLength(json) > 64 * 1024) invalid('工具 inputSchema 必须为有界的 object schema')
  let schemas = 0, branches = 0
  const walk = (schema: unknown, depth: number): void => {
    if (++schemas > 256 || depth > 16) invalid('插件 inputSchema 嵌套或节点过多')
    if (typeof schema === 'boolean') return
    if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return
    for (const [key, value] of Object.entries(schema)) {
      if (unsupported.has(key) || key === 'uniqueItems' && value === true)
        invalid('插件 inputSchema 暂不支持 ' + key + '；请在插件进程中实现该校验')
      if (schemaChildren.has(key)) {
        if (Array.isArray(value) && key === 'items') value.forEach(item => walk(item, depth + 1))
        else if (typeof value === 'boolean' || value && typeof value === 'object') walk(value, depth + 1)
      } else if (schemaMaps.has(key) && value && typeof value === 'object' && !Array.isArray(value)) {
        Object.values(value).forEach(item => walk(item, depth + 1))
      } else if (schemaLists.has(key) && Array.isArray(value)) {
        branches += value.length
        if (value.length > 8 || branches > 32) invalid('插件 inputSchema 组合分支过多')
        value.forEach(item => walk(item, depth + 1))
      } else if (key === 'dependencies' && value && typeof value === 'object' && !Array.isArray(value)) {
        Object.values(value).filter(item => !Array.isArray(item)).forEach(item => walk(item, depth + 1))
      } else if (key === 'enum' && Array.isArray(value) && value.length > 64) invalid('插件 inputSchema 枚举值过多')
    }
  }
  walk(root, 0)
  return json
}

export function compilePluginSchema(schema: Record<string, unknown>): ValidateFunction {
  const json = boundedSchema(schema)
  const existing = validators.get(json)
  if (existing) {
    validators.delete(json); validators.set(json, existing)
    return existing
  }
  try {
    // A fresh compiler cannot retain unbounded schema IDs. Only the bounded LRU holds validators.
    const ajv = new Ajv({ strict: true, strictTypes: false, strictTuples: false, strictRequired: false,
      ownProperties: true, allErrors: false, coerceTypes: false, useDefaults: false, removeAdditional: false,
      loopEnum: 16, loopRequired: 16, addUsedSchema: false })
    const validate = ajv.compile(JSON.parse(json))
    validators.set(json, validate)
    if (validators.size > MAX_CACHE) validators.delete(validators.keys().next().value!)
    return validate
  } catch (error) {
    if (error instanceof PluginError) throw error
    return invalid('插件 inputSchema 无效：' + (error instanceof Error ? error.message : String(error)).slice(0, 500))
  }
}

export function validatePluginArguments(schema: Record<string, unknown>, args: unknown): void {
  const validate = compilePluginSchema(schema)
  if (!validate(args)) {
    const error = validate.errors?.[0]
    throw new PluginError('PLUGIN_ARGUMENTS', '插件参数不符合 inputSchema：' + (error ? (error.instancePath || '/') + ' ' + error.message : '参数无效'))
  }
}
