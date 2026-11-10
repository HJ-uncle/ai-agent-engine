/** Fresh, bounded real-model Work generation probe. No existing E2E is run.
 * node --import tsx scripts/evals/ppt-composition-eval.ts --build-id sha256:<id>
 * Uses a real isolated HTTP /chat server from dist; no connected desktop renderer.
 * Provider credentials are read-only from the selected desktop DB and stay in memory.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const options = Object.fromEntries(process.argv.slice(2).flatMap((value, index, values) => value.startsWith('--') ? [[value.slice(2), values[index + 1]]] : []))
const dist = path.resolve(repo, options.dist || 'dist')
const input = path.resolve(options.input || 'D:/dev/aether-code/.e2e-tmp/ppt-composition-20261110/workspace')
const campaign = path.join(repo, '.e2e-tmp/ppt-composition-20261110')
const runRoot = path.join(campaign, `live-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomBytes(3).toString('hex')}`)
const workspace = path.join(runRoot, 'workspace')
const sessionId = `ppt-composition-${randomUUID()}`
const timeoutMs = Math.min(480_000, Math.max(10_000, Number(options['timeout-ms'] || 300_000)))
const maxCreateAttempts = Math.min(4, Math.max(1, Number(options['max-create-attempts'] || 2)))
if (!Number.isFinite(timeoutMs) || !Number.isInteger(maxCreateAttempts)) throw new Error('Invalid evaluation limits')
const deadline = Date.now() + timeoutMs
const nativeFetch = globalThis.fetch
const secrets: string[] = []
const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex')
const scrub = (value: unknown) => secrets.reduce((text, secret) => secret ? text.split(secret).join('[REDACTED]') : text,
  typeof value === 'string' ? value : JSON.stringify(value)).replace(/Bearer\s+[^\s"']+/gi, 'Bearer [REDACTED]')
const emit = (value: unknown) => process.stdout.write(scrub(value) + '\n')
const save = (name: string, value: unknown) => fs.writeFileSync(path.join(runRoot, name), scrub(JSON.stringify(value, null, 2)) + '\n')
// Dependencies can log outside console.*; redact at the process output boundary.
for (const output of [process.stdout, process.stderr]) {
  const write = output.write.bind(output)
  output.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => Reflect.apply(write, output,
    [scrub(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')), ...rest])) as typeof output.write
}
const built = (relative: string) => import(pathToFileURL(path.join(dist, relative)).href)
const providerReads: Promise<void>[] = []
const evidence: Record<string, unknown> = {
  schemaVersion: 1, startedAt: new Date().toISOString(), sessionId, runRoot, workspace,
  boundaries: ['Real configured DeepSeek model, actual general Work HTTP route, production skill/prompt/schema from the named build.',
    'Isolated databases and copied README/screenshots only; no production conversations or deliverables are modified.',
    'No connected Work desktop client. This run tests autonomous generation and structure; real-file visual review is performed separately.',
    'At most 18 provider requests; create-attempt and deadline limits are recorded below. No predetermined layouts or coordinates.'],
  limits: { timeoutMs, maxCreateAttempts, maxProviderRequests: 18 },
}
let app: Awaited<ReturnType<typeof import('../../src/api/http/index.js').buildServer>> | undefined
let database: typeof import('../../src/storage/sqlite/db.js') | undefined
let memory: typeof import('../../src/storage/memory/index.js') | undefined
let skills: typeof import('../../src/skills/index.js').skillsRegistry | undefined
let base = ''
let headers: Record<string, string> = {}
let creates = 0

function captureTranscript() {
  const archive = path.join(runRoot, 'state/sessions/default', sessionId + '.jsonl')
  if (!fs.existsSync(archive)) return []
  const messages = fs.readFileSync(archive, 'utf8').trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line).payload)
  save('transcript.json', messages.map(message => ({ role: message.role, content: message.content, toolCall: message.toolCall,
    toolCallId: message.toolCallId, toolName: message.toolName, usage: message.usage, metadata: message.metadata })))
  const attempts = messages.filter(message => message.toolCall?.name === 'office_document' && message.toolCall.args?.operation === 'create')
  save('model-creation-attempts.json', attempts.map(message => ({ callId: message.toolCall.id, args: message.toolCall.args,
    result: messages.find(result => result.toolName === 'office_document' && result.toolCallId === message.toolCall.id)?.content })))
  const guide = messages.find(message => message.toolName === 'get_skill' && typeof message.content === 'string'
    && message.content.includes('不增加固定模板'))
  evidence.designGuideLoaded = !!guide
  evidence.createAttempts = creates
  return messages
}

function verifyNoSecretFiles(directory: string): void {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name)
    if (entry.isDirectory()) verifyNoSecretFiles(file)
    else if (entry.isFile()) {
      const bytes = fs.readFileSync(file)
      if (secrets.some(secret => secret.length >= 16 && bytes.includes(Buffer.from(secret))))
        throw new Error('Private credential persistence was detected in the isolated evaluation output')
    }
  }
}

function imagePartCount(value: unknown): number {
  if (Array.isArray(value)) return value.reduce((sum, child) => sum + imagePartCount(child), 0)
  if (!value || typeof value !== 'object') return 0
  const part = value as Record<string, unknown>
  // Do not count image-shaped elements inside generated PPT tool arguments.
  const count = part.type === 'image_url' && !!part.image_url || part.type === 'image' && !!part.source ? 1 : 0
  return count + Object.entries(part).filter(([key]) => !['tools', 'input', 'arguments'].includes(key))
    .reduce((sum, [, child]) => sum + imagePartCount(child), 0)
}

async function readModel() {
  const dbFile = 'C:/Users/wb.xielin02/AppData/Roaming/Aether Code/engine/state/agent.db'
  const profile = path.resolve(dbFile, '../../..')
  const encrypted = JSON.parse(fs.readFileSync(path.join(profile, 'engine/secrets/engine-secrets.json'), 'utf8'))
  const localState = JSON.parse(fs.readFileSync(path.join(profile, 'Local State'), 'utf8'))
  if (encrypted.encrypted !== true) throw new Error('Expected an OS-protected model encryption key')
  const wrapped = Buffer.from(localState.os_crypt.encrypted_key, 'base64')
  if (wrapped.subarray(0, 5).toString() !== 'DPAPI') throw new Error('Unsupported OS key format')
  const osKey = await new Promise<Buffer>((resolve, reject) => {
    const helper = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'Add-Type -AssemblyName System.Security; $encryptedInput=[Console]::In.ReadToEnd(); $plainBytes=[Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($encryptedInput),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($plainBytes)); [Array]::Clear($plainBytes,0,$plainBytes.Length)'],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    const chunks: Buffer[] = []
    helper.stdout.on('data', bytes => chunks.push(bytes)); helper.stderr.resume()
    const timer = setTimeout(() => { helper.kill(); reject(new Error('Private OS decryption timed out')) }, 15_000)
    helper.once('error', () => { clearTimeout(timer); reject(new Error('Private OS decryption unavailable')) })
    helper.once('exit', code => {
      clearTimeout(timer)
      if (code !== 0) return reject(new Error('Private OS decryption failed'))
      const text = Buffer.concat(chunks), result = Buffer.from(text.toString().trim(), 'base64')
      text.fill(0); chunks.forEach(chunk => chunk.fill(0)); resolve(result)
    })
    helper.stdin.end(wrapped.subarray(5).toString('base64'))
  })
  const protectedBytes = Buffer.from(encrypted.encryptionKey, 'base64')
  if (protectedBytes.subarray(0, 3).toString() !== 'v10') throw new Error('Unsupported protected model-key format')
  const decipher = createDecipheriv('aes-256-gcm', osKey, protectedBytes.subarray(3, 15))
  decipher.setAuthTag(protectedBytes.subarray(-16))
  const plain = Buffer.concat([decipher.update(protectedBytes.subarray(15, -16)), decipher.final()]); osKey.fill(0)
  const sourceKey = plain.toString('utf8'); plain.fill(0); secrets.push(sourceKey)
  const { readConfiguredModel } = await import(pathToFileURL('D:/dev/aether-code/scripts/gomoku-model-seed.mjs').href)
  const model = readConfiguredModel({ database: dbFile, modelId: 'deepseek-v4.1-flash-1017', encryptionKey: sourceKey })
  secrets.push(model.apiKey)
  const db = new DatabaseSync(dbFile, { readOnly: true }); db.exec('PRAGMA query_only=ON')
  try {
    const row = db.prepare("SELECT api_format FROM models WHERE tenant_id='default' AND model_id=? AND is_enabled=1 AND deleted_at IS NULL").get(model.modelId)
    if (row?.api_format && row.api_format !== 'auto') throw new Error('This probe expects the selected real model automatic protocol')
  } finally { db.close() }
  return model
}

async function main() {
  if (!/^sha256:[a-f0-9]{64}$/.test(options['build-id'] || '')) throw new Error('A reviewed engine build ID is required')
  fs.mkdirSync(workspace, { recursive: true })
  fs.mkdirSync(path.join(runRoot, 'state')); fs.mkdirSync(path.join(runRoot, 'global'))
  fs.copyFileSync(path.join(input, 'README.md'), path.join(workspace, 'README.md'), fs.constants.COPYFILE_EXCL)
  fs.cpSync(path.join(input, 'assets'), path.join(workspace, 'assets'), { recursive: true, errorOnExist: true, force: false })
  if (options['reuse-draft']) {
    const sourceDraft = path.resolve(options['reuse-draft'])
    fs.copyFileSync(sourceDraft, path.join(workspace, 'draft.md'), fs.constants.COPYFILE_EXCL)
    evidence.reusedDraft = { source: sourceDraft, sha256: sha(fs.readFileSync(sourceDraft)),
      boundary: 'Unchanged model-authored narrative draft from the first failed run; no prior PPT layouts, coordinates or corrected arguments are seeded.' }
  }
  evidence.inputFiles = ['README.md', ...(options['reuse-draft'] ? ['draft.md'] : []), ...fs.readdirSync(path.join(workspace, 'assets')).map(name => 'assets/' + name)]
    .map(name => ({ name, sha256: sha(fs.readFileSync(path.join(workspace, name))) }))
  evidence.buildId = options['build-id']; evidence.engineEntryHash = sha(fs.readFileSync(path.join(dist, 'main.js')))
  const model = await readModel()
  evidence.model = { provider: model.provider, modelId: model.modelId, capabilities: model.capabilityOverrides }
  for (const key of Object.keys(process.env)) if (/API_?KEY|TOKEN|SECRET|ENCRYPTION_KEY|LLM_|MCP_|SKILLS_ROOT|AETHER_GLOBAL_DIR|DATA_DIR|AUTH_ENABLED|WORKSPACE_ROOT/.test(key)) delete process.env[key]
  const instanceToken = randomBytes(24).toString('hex'), engineKey = randomBytes(32).toString('hex'); secrets.push(instanceToken, engineKey)
  // No source or provider secret is inserted into the isolated database or request body.
  Object.assign(process.env, {
    NODE_ENV: 'production', LOG_LEVEL: 'silent', AUTH_ENABLED: 'false', AETHER_INSTANCE_TOKEN: instanceToken, ENCRYPTION_KEY: engineKey,
    DATA_DIR: path.join(runRoot, 'state/agent.db'), KNOWLEDGE_DATA_DIR: path.join(runRoot, 'state/knowledge.db'),
    AETHER_GLOBAL_DIR: path.join(runRoot, 'global'), WORKSPACE_ROOT: workspace, HISTORY_BACKEND: 'jsonl',
    MCP_CONFIG_PATH: path.join(runRoot, 'no-mcp.json'), QA_LOG_ENABLED: 'false', DISABLE_TELEMETRY: 'true', ENABLE_LONG_TERM_MEMORY: 'false',
    LLM_PRIMARY_MODEL: model.modelId, LLM_PROVIDER: model.provider, LLM_FALLBACK_MODEL: '', DEFAULT_SECURITY_MODE: 'standard',
    OPENAI_API_KEY: model.apiKey, DEEPSEEK_API_KEY: model.apiKey, ANTHROPIC_API_KEY: model.apiKey,
    OPENAI_BASE_URL: model.baseUrl, DEEPSEEK_BASE_URL: model.baseUrl, ANTHROPIC_BASE_URL: model.baseUrl,
  })
  process.chdir(workspace)
  const providerOrigin = new URL(model.baseUrl).origin
  const attempts: Record<string, unknown>[] = []
  evidence.providerAttempts = attempts
  globalThis.fetch = async (inputRequest, init) => {
    const url = new URL(typeof inputRequest === 'string' ? inputRequest : inputRequest instanceof URL ? inputRequest.href : inputRequest.url)
    if (url.origin !== providerOrigin) {
      if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('Evaluation external network denied')
      return nativeFetch(inputRequest, init)
    }
    if (attempts.length >= 18 || Date.now() >= deadline) return new Response(JSON.stringify({ error: { type: 'invalid_request_error', message: 'Evaluation request budget reached' } }), { status: 400 })
    const body = JSON.parse(String(init?.body || '{}'))
    const systemText = JSON.stringify(body.system || body.messages?.filter((message: { role: string }) => message.role === 'system') || '')
    const item: Record<string, unknown> = {
      startedAt: new Date().toISOString(), bodyHash: sha(String(init?.body || '')),
      officePromptPresent: systemText.includes('逐页与全篇检查视觉表达'),
      toolNames: (body.tools || []).map((tool: { name?: string; function?: { name?: string } }) => tool.function?.name || tool.name),
      inputImages: imagePartCount(body.messages || []),
    }
    const officeTool = (body.tools || []).find((tool: { name?: string; function?: { name?: string } }) => (tool.function?.name || tool.name) === 'office_document')
    if (officeTool && !fs.existsSync(path.join(runRoot, 'actual-office-tool-schema.json'))) save('actual-office-tool-schema.json', officeTool)
    attempts.push(item); emit({ phase: 'provider-request', count: attempts.length, inputImages: item.inputImages })
    const response = await nativeFetch(inputRequest, { ...init, signal: AbortSignal.any([...(init?.signal ? [init.signal] : []), AbortSignal.timeout(Math.max(1, deadline - Date.now()))]) })
    item.httpStatus = response.status
    const read = response.clone().text().then(text => {
      const chunks = text.trim().startsWith('{') ? [text] : text.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.replace(/^data:\s*/, ''))
      const usage: Record<string, unknown> = {}
      for (const chunk of chunks) try { const value = JSON.parse(chunk); Object.assign(usage, value.usage || value.message?.usage || {}); if (value.error) item.providerError = scrub(value.error) } catch { /* SSE terminator. */ }
      item.usage = usage
    }).catch(() => { item.streamReadFailed = true })
    providerReads.push(read)
    return response
  }
  database = await built('storage/sqlite/db.js'); await database!.initDb()
  memory = await built('storage/memory/index.js'); await memory!.initMemoryDb(memory!.MEMORY_SCHEMA)
  const office = await built('tools/office/index.js')
  const execute = office.officeDocumentTool.execute.bind(office.officeDocumentTool)
  office.officeDocumentTool.execute = async (args: Record<string, unknown>, ctx: unknown) => {
    if (args.operation === 'create' && String(args.path).endsWith('.pptx')) {
      creates++
      if (creates > maxCreateAttempts) throw new Error('Evaluation PPT creation-attempt budget reached')
    }
    const result = await execute(args, ctx)
    if (args.operation === 'create' && result.success && String(args.path).endsWith('.pptx')) {
      const actual = path.resolve(workspace, String(args.path))
      emit({ phase: 'ppt-created', path: actual, bytes: fs.statSync(actual).size, sha256: sha(fs.readFileSync(actual)) })
    }
    return result
  }
  skills = (await built('skills/index.js')).skillsRegistry; skills!.start()
  app = await (await built('api/http/index.js')).buildServer({ listenHost: '127.0.0.1', desktopOwned: true })
  await (await built('scheduler/cron-scheduler.js')).cronScheduler.stop()
  await app!.listen({ host: '127.0.0.1', port: 0 })
  const address = app!.server.address()
  if (!address || typeof address === 'string') throw new Error('Expected an isolated TCP listener')
  base = `http://127.0.0.1:${address.port}`
  headers = { 'content-type': 'application/json', 'x-aether-instance-token': instanceToken, 'x-aether-tool-profile': 'general', 'x-aether-run-lifetime': 'attached' }
  const prompt = '请根据当前目录 README.md 和 assets/ 中提供的真实产品截图，为 web-2048 制作 4 页中文项目概览 PPT，面向首次了解项目的产品评审，讲清用途、玩法、产品体验和已知限制。页面构图由你按内容决定，事实只使用这些资料，不编造统计数据、作者或日期。截图里的棋盘是演示状态，不是业务统计。保存为 2048-项目概览.pptx。无需扫描源码、运行项目测试或启动服务器。当前没有连接桌面预览客户端，生成后核对结构和内容，并如实说明逐页视觉验收将另外完成。'
  save('task.json', { prompt, workspace, sessionId, thinkingMode: 'low', clientConnected: false })
  emit({ phase: 'chat-start', runRoot, workspace, model: model.modelId })
  const response = await nativeFetch(base + '/api/v1/chat', { method: 'POST', headers, body: JSON.stringify({
    sessionId, message: prompt, model: model.modelId, modelProvider: model.provider,
    workspacePaths: [workspace], memoryScope: 'off', thinkingMode: 'low', capabilities: model.capabilityOverrides,
    allowedTools: ['read_file', 'write_file', 'list_files', 'glob', 'create_dir', 'get_skill', 'load_tools', 'office_document', 'office_inspect', 'plan_update', 'deliver_files'],
  }), signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())) })
  evidence.chatHttpStatus = response.status
  const stream = await response.text(); evidence.chatStreamHash = sha(stream)
  if (!response.ok || !response.headers.get('content-type')?.includes('text/event-stream')) throw new Error('Actual chat route did not return a successful SSE response')
  await Promise.allSettled(providerReads)
  evidence.status = await nativeFetch(base + '/api/v1/chat/status?sessionId=' + encodeURIComponent(sessionId), { headers }).then(result => result.json())
  const messages = captureTranscript()
  const creation = messages.filter(message => message.toolCall?.name === 'office_document' && message.toolCall.args?.operation === 'create' && String(message.toolCall.args.path).endsWith('.pptx')).at(-1)?.toolCall.args
  if (creation) {
    save('model-presentation-input.json', creation)
    evidence.slides = creation.presentation.slides.map((slide: { title: string; layout?: string; image?: unknown; elements?: Array<{ type: string }> }) => ({ title: slide.title, layout: slide.layout || 'auto', hasImage: !!slide.image || !!slide.elements?.some(element => element.type === 'image') }))
  }
  const ppt = path.join(workspace, '2048-项目概览.pptx')
  evidence.candidateExists = fs.existsSync(ppt)
  if (fs.existsSync(ppt)) evidence.candidate = { path: ppt, bytes: fs.statSync(ppt).size, sha256: sha(fs.readFileSync(ppt)) }
  const db = database!.getDb()
  evidence.noPersistedModelKeys = Number((await db.execute('SELECT COUNT(*) AS n FROM models')).rows[0].n) === 0
  evidence.createAttempts = creates
  evidence.visualReview = 'Pending: no connected desktop client in generation probe; actual Work preview reviewed separately.'
  evidence.generationPassed = fs.existsSync(ppt) && creation?.presentation?.slides?.length === 4 && evidence.designGuideLoaded === true
  save('evidence.json', evidence)
  emit({ phase: 'generation-finished', candidate: evidence.candidate, slides: evidence.slides, status: evidence.status, createAttempts: creates, runRoot })
  if (!evidence.generationPassed) throw new Error('The model did not produce a four-page candidate using the reviewed design guide')
}

try { await main() }
catch (error) {
  evidence.error = scrub(error instanceof Error ? error.message : String(error))
  if (base) await nativeFetch(base + '/api/v1/chat/cancel', { method: 'POST', headers, body: JSON.stringify({ sessionId }) }).catch(() => {})
  captureTranscript()
  evidence.generationPassed = false
  emit({ phase: 'failed', error: evidence.error, runRoot })
} finally {
  await Promise.allSettled(providerReads)
  globalThis.fetch = nativeFetch
  try { await app?.close(); skills?.stop(); await memory?.closeMemoryDb(); await database?.closeDb() } catch { /* Evidence retains the outcome. */ }
  try { if (fs.existsSync(runRoot)) { verifyNoSecretFiles(runRoot); evidence.noPersistedSecrets = true } }
  catch (error) { evidence.error = error instanceof Error ? error.message : String(error); evidence.noPersistedSecrets = false }
  evidence.finishedAt = new Date().toISOString()
  if (fs.existsSync(runRoot)) save('evidence.json', evidence)
  emit({ phase: 'closed', runRoot, error: evidence.error })
  process.exit(evidence.error ? 1 : 0)
}
