import fs from 'node:fs'
import path from 'node:path'
import { createDecipheriv } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'

// Read existing credentials, and use them only on the configured HTTPS origin.
const engineRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const sourceDb = new DatabaseSync(path.join(engineRoot, 'data/agent.db'), { readOnly: true })
let source
try { source = sourceDb.prepare('SELECT provider,model_id,api_key,base_url FROM models WHERE tenant_id=? AND is_enabled=1 AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1').get('default') }
finally { sourceDb.close() }
if (!source) throw new Error('No configured default-tenant model')
const configured = new URL(source.base_url)
if (configured.protocol !== 'https:' || !/\/anthropic\/?$/.test(configured.pathname)) throw new Error('Expected existing HTTPS Anthropic gateway')
const env = { ...process.env }
const envFile = path.join(engineRoot, '.env')
if (fs.existsSync(envFile)) for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
  const item = line.trim(), split = item.indexOf('=')
  if (item && !item.startsWith('#') && split > 0) {
    const name = item.slice(0, split).trim()
    if (!(name in env)) env[name] = item.slice(split + 1).trim().replace(/^["']|["']$/g, '')
  }
}
const fallback = fs.readFileSync(path.join(engineRoot, 'src/utils/encryption.ts'), 'utf8').match(/ENCRYPTION_KEY_HEX\s*=\s*'([0-9a-f]+)'/i)?.[1]
let apiKey
try {
  const [iv, tag, encrypted] = source.api_key.split(':')
  const cipher = createDecipheriv('aes-256-gcm', Buffer.from(env.ENCRYPTION_KEY || fallback, 'hex'), Buffer.from(iv, 'hex'))
  cipher.setAuthTag(Buffer.from(tag, 'hex'))
  apiKey = Buffer.concat([cipher.update(Buffer.from(encrypted, 'hex')), cipher.final()]).toString('utf8')
} catch { throw new Error('Cannot decrypt existing configured credential') }
const endpoint = new URL(source.base_url.replace(/\/$/, '') + '/v1/messages')
if (endpoint.origin !== configured.origin) throw new Error('Cross-origin credential reuse refused')
const stamp = new Date().toISOString().replace(/[-:.]/g, '')
const output = path.join(engineRoot, 'test-projects/longrun-20261009/runs', `continuation-gateway-preflight-${stamp}.json`)
const models = ['MiniMax-M2.5', 'glm-5.3', 'kimi-k2.6']
const cases = await Promise.all(models.map(async model => {
  const result = { model, phases: [], passed: false }
  for (const toolCalling of [false, true]) {
    const body = { model, max_tokens: toolCalling ? 2048 : 128, messages: [{ role: 'user', content: toolCalling
      ? 'Call read_probe with path README.md. One tool call is required. Do not answer in plain text.'
      : 'Reply exactly MODEL_READY.' }], ...(toolCalling ? { tools: [{ name: 'read_probe', description: 'Read-only protocol preflight; no real file is read.', input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }] } : {}) }
    const started = Date.now()
    try {
      const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }, body: JSON.stringify(body), signal: AbortSignal.timeout(90000) })
      const data = await response.json()
      const text = (data.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('')
      const tool = (data.content ?? []).find(part => part.type === 'tool_use' && part.name === 'read_probe' && part.input?.path === 'README.md')
      const passed = response.ok && data.model === model && (toolCalling ? Boolean(tool) : text.includes('MODEL_READY'))
      result.phases.push({ kind: toolCalling ? 'tool_calling' : 'completion', httpStatus: response.status, returnedModel: data.model, durationMs: Date.now() - started, passed,
        errorType: data.error?.type, errorMessage: typeof data.error?.message === 'string' ? data.error.message.split(apiKey).join('[redacted]').slice(0, 1000) : undefined })
      if (!passed) break
    } catch (error) {
      result.phases.push({ kind: toolCalling ? 'tool_calling' : 'completion', durationMs: Date.now() - started, passed: false, error: String(error.message).split(apiKey).join('[redacted]') })
      break
    }
  }
  result.passed = result.phases.length === 2 && result.phases.every(phase => phase.passed)
  return result
}))
const result = { at: new Date().toISOString(), host: configured.host, sourceModel: source.model_id, sourceReadOnly: true, scope: 'Gateway protocol only; actual engine/tool development must pass separately', passed: cases.every(item => item.passed), cases }
fs.mkdirSync(path.dirname(output), { recursive: true })
fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n')
console.log(JSON.stringify({ output, ...result }))
process.exitCode = result.passed ? 0 : 2
