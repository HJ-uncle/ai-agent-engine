import fs from 'node:fs'
import path from 'node:path'
import { createDecipheriv } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'

// Only reuse credentials on their existing HTTPS origin. Never print key material.
const engineRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const database = new DatabaseSync(path.join(engineRoot, 'data', 'agent.db'), { readOnly: true })
let source
try { source = database.prepare('SELECT provider,model_id,api_key,base_url FROM models WHERE tenant_id=? AND is_enabled=1 AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1').get('default') }
finally { database.close() }
if (!source) throw new Error('No existing default-tenant model')
const url = new URL(source.base_url)
if (url.protocol !== 'https:' || !/\/anthropic\/?$/.test(url.pathname)) throw new Error('This preflight requires the existing configured HTTPS Anthropic gateway')
const env = { ...process.env }
const envFile = path.join(engineRoot, '.env')
if (fs.existsSync(envFile)) for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) { const item = line.trim(); if (!item || item.startsWith('#')) continue; const split = item.indexOf('='); if (split > 0) { const name = item.slice(0, split).trim(); if (!(name in env)) env[name] = item.slice(split + 1).trim().replace(/^["']|["']$/g, '') } }
const fallback = fs.readFileSync(path.join(engineRoot, 'src/utils/encryption.ts'), 'utf8').match(/ENCRYPTION_KEY_HEX\s*=\s*'([0-9a-f]+)'/i)?.[1]
const encryptionKey = env.ENCRYPTION_KEY || fallback
const [iv, tag, encrypted] = source.api_key.split(':')
let apiKey
try { const cipher = createDecipheriv('aes-256-gcm', Buffer.from(encryptionKey, 'hex'), Buffer.from(iv, 'hex')); cipher.setAuthTag(Buffer.from(tag, 'hex')); apiKey = Buffer.concat([cipher.update(Buffer.from(encrypted, 'hex')), cipher.final()]).toString('utf8') }
catch { throw new Error('Existing gateway credential cannot be decrypted; no data changed') }
const targetModel = 'qwen3.8-flash'
const endpoint = new URL(source.base_url.replace(/\/$/, '') + '/v1/messages')
if (endpoint.origin !== url.origin) throw new Error('Cross-origin credential reuse refused')
const result = { at: new Date().toISOString(), model: targetModel, host: url.host, sourceModel: source.model_id, sourceReadOnly: true, phases: [], passed: false }
for (const body of [
  { model: targetModel, max_tokens: 64, messages: [{ role: 'user', content: 'Reply exactly QWEN_READY.' }] },
  { model: targetModel, max_tokens: 1024, messages: [{ role: 'user', content: 'Use the read_probe tool with path README.md. Do not answer in plain text. The task requires one tool call.' }], tools: [{ name: 'read_probe', description: 'Read-only synthetic protocol preflight. No actual file is read.', input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }] },
]) {
  const started = Date.now()
  try {
    const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }, body: JSON.stringify(body), signal: AbortSignal.timeout(90000) })
    const data = await response.json()
    const text = (data.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('')
    const tool = (data.content ?? []).find(part => part.type === 'tool_use' && part.name === 'read_probe' && part.input?.path === 'README.md')
    const passed = response.ok && data.model === targetModel && (body.tools ? Boolean(tool) : text.includes('QWEN_READY'))
    result.phases.push({ kind: body.tools ? 'tool_calling' : 'completion', httpStatus: response.status, returnedModel: data.model, durationMs: Date.now() - started, passed, errorType: data.error?.type, errorMessage: typeof data.error?.message === 'string' ? data.error.message.split(apiKey).join('[redacted]').slice(0, 1000) : undefined, errorBody: !response.ok ? JSON.stringify(data).split(apiKey).join('[redacted]').slice(0, 1000) : undefined })
    if (!passed) break
  } catch (error) { result.phases.push({ kind: body.tools ? 'tool_calling' : 'completion', durationMs: Date.now() - started, passed: false, error: String(error.message).split(apiKey).join('[redacted]') }); break }
}
result.passed = result.phases.length === 2 && result.phases.every(phase => phase.passed)
const evidence = path.join(engineRoot, 'test-projects/longrun-20261009/qwen-gateway-preflight.json')
fs.mkdirSync(path.dirname(evidence), { recursive: true })
if (fs.existsSync(evidence)) fs.copyFileSync(evidence, evidence.replace(/\.json$/, `-${Date.now()}.json`))
fs.writeFileSync(evidence, JSON.stringify(result, null, 2) + '\n')
console.log(JSON.stringify(result))
process.exitCode = result.passed ? 0 : 2
