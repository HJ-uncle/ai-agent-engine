/** Real HTTP, two-session memory comparison. Production data is read-only.
 * node --import tsx scripts/evals/memory-on-off-eval.ts --dry-run
 * node --import tsx scripts/evals/memory-on-off-eval.ts --model-id <configured id>
 * Output stays under .tmp/. No provider requests are made in --dry-run mode.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
// Node 24 provides SQLite; the repository still ships Node 20 type declarations.
// @ts-expect-error node:sqlite is available in the evaluation runtime.
import { DatabaseSync } from 'node:sqlite'

type Json = Record<string, any>
type Group = 'off' | 'on'
type Stage = 'main' | 'memory_recall' | 'memory_extraction' | 'other_auxiliary'
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const args: Record<string, string> = {}
for (let index = 2; index < process.argv.length; index++) {
  const argument = process.argv[index]
  if (argument.startsWith('--')) args[argument.slice(2)] = process.argv[index + 1]?.startsWith('--') || !process.argv[index + 1] ? 'true' : process.argv[++index]
}
const source = path.resolve(repo, args['source-root'] || 'src')
const temporaryRoot = path.join(repo, '.tmp')
const runRoot = path.resolve(repo, args.output || `.tmp/memory-on-off-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomBytes(3).toString('hex')}`)
if (!runRoot.startsWith(temporaryRoot + path.sep)) throw new Error('Evaluation output must be a new directory under the repository .tmp directory')
if (fs.existsSync(runRoot)) throw new Error('Evaluation output already exists; use a new directory')
const workspace = path.join(runRoot, 'workspace')
const state = path.join(runRoot, 'state')
for (const directory of [workspace, state, path.join(runRoot, 'global')]) fs.mkdirSync(directory, { recursive: true })
const modelId = args['model-id'] || process.env.LLM_PRIMARY_MODEL || 'deepseek-v4.1-flash-1017'
const timeoutMs = Math.min(300_000, Math.max(20_000, Number(args['timeout-ms'] || 180_000)))
const maxAttempts = Math.min(60, Math.max(4, Number(args['max-attempts'] || 24)))
const allowedTools = ['remember', 'recall', 'list_memories', 'forget', 'link_memories', 'load_tools']
const prompts = [
  '这是一次虚构资料的会话测试。代号 MEM_EVAL_742：我的长期偏好是项目周报使用中文、三条项目符号，每条不超过20字；偏好的强调色是薄荷绿。请记住这个偏好，并用一句话简短确认。请按当前真实记忆能力处理，没有长期记忆能力时不要声称已保存长期记忆。这只是文字交流，不创建文件、不联网、不执行命令。',
  '代号 MEM_EVAL_742。请按我的偏好写一份项目周报，内容是需求已确认、开发进行中、下周验收；同时在最后用“强调色：颜色”注明强调色。这只是文字交流，不创建文件、不联网、不执行命令。',
  '更正代号 MEM_EVAL_742 的长期偏好：强调色由薄荷绿改为琥珀橙，周报改为两条项目符号，每条不超过20字。旧颜色和旧条数已经作废。请按当前真实记忆能力处理这项更正，然后立刻应用新偏好写周报，内容是开发完成、周五验收。输出格式仅为两条项目符号，最后单独一行“强调色：琥珀橙”。这只是文字交流，不创建文件、不联网、不执行命令。',
]
const secrets: string[] = []
const scrub = (value: unknown) => secrets.reduce((text, secret) => secret ? text.split(secret).join('[REDACTED]') : text,
  typeof value === 'string' ? value : JSON.stringify(value)).replace(/Bearer\s+[^\s"']+/gi, 'Bearer [REDACTED]')
const nativeConsole = { log: console.log.bind(console), warn: console.warn.bind(console), error: console.error.bind(console) }
const emit = (value: unknown) => nativeConsole.log(scrub(value))
const save = (name: string, value: unknown) => fs.writeFileSync(path.join(runRoot, name), scrub(typeof value === 'string' ? value : JSON.stringify(value, null, 2)), 'utf8')
const runtimeLog = (value: unknown) => fs.appendFileSync(path.join(runRoot, 'runtime.log'), scrub(value) + '\n')
const hash = (value: unknown) => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex')
const imported = (relative: string) => import(pathToFileURL(path.join(source, relative)).href)
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const nativeFetch = globalThis.fetch
let app: any, database: any, memory: any, skills: any, cron: any
let getActiveMemoryExtractionCount: ((context: Json) => number) | undefined
let estimateMemoryTokens = (text: string) => Math.ceil((text.match(/[\u4e00-\u9fa5]/g)?.length || 0) * 1.25 + text.length * 0.25)
let current: Json | undefined
const providerReads = new Set<Promise<void>>()
const previousMain = new Map<string, { systemHash: string; history: string[] }>()
const sessions = { off: `eval-memory-off-${randomUUID()}`, on: `eval-memory-on-${randomUUID()}` }
const evidence: Json = {
  schemaVersion: 1, label: args.label || 'memory-on-off', startedAt: new Date().toISOString(), sourceRoot: source, runRoot,
  model: { modelId }, sessions, prompts, turns: [],
  boundaries: { realHttpChat: true, isolatedProductionData: true, globalMemoryEnabled: false, sessionMemory: { off: false, on: true },
    retainedHistory: 'Each group keeps its own complete three-turn conversation; inputs at each corresponding round are byte-identical.',
    allowedTools, roundOrder: [['off', 'on'], ['on', 'off'], ['off', 'on']],
    timeoutMs, maxPhysicalRequestsPerTurn: maxAttempts,
    limitations: [
      'This is a small observational comparison, not a causal cache benchmark. The two sessions have different histories and memory capabilities/tool schemas.',
      'The provider cache may be shared across sessions and auxiliary requests. Interleaving changes which group can prewarm shared prefixes.',
      'Both groups retain conversation history, so recalling a preference in the OFF group does not prove long-term memory was used.',
      'Wall time and TTFT include recall before the main request. End-to-end time additionally waits for background memory extraction and writes.',
      'Provider usage is physical-request evidence; missing provider counters remain unknown rather than being interpreted as zero.',
      'Memory injection tokens are estimates from the engine estimator, not provider-reported per-section token counts.',
      'Raw wire history includes provider normalization and the transient runtime tail; compare durable JSONL history separately before concluding historical messages changed.',
    ] },
}

async function loadModel() {
  const sourceDb = path.resolve(args['model-db'] || 'C:/Users/wb.xielin02/AppData/Roaming/Aether Code/engine/state/agent.db')
  const secretFile = args['secret-file'] || path.resolve(sourceDb, '../../secrets/engine-secrets.json')
  const encrypted = JSON.parse(fs.readFileSync(secretFile, 'utf8'))
  if (encrypted.encrypted !== true) throw new Error('Expected an OS-protected source encryption key')
  const localState = JSON.parse(fs.readFileSync(path.resolve(sourceDb, '../../../Local State'), 'utf8'))
  const wrapped = Buffer.from(localState.os_crypt.encrypted_key, 'base64')
  if (wrapped.subarray(0, 5).toString() !== 'DPAPI') throw new Error('Unsupported OS-protected source key')
  const osKey = await new Promise<Buffer>((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'Add-Type -AssemblyName System.Security; $encryptedInput=[Console]::In.ReadToEnd(); $plainBytes=[Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($encryptedInput),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($plainBytes)); [Array]::Clear($plainBytes,0,$plainBytes.Length)'],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    const chunks: Buffer[] = []
    child.stdout.on('data', chunk => chunks.push(chunk)); child.stderr.resume()
    const timer = setTimeout(() => { child.kill(); reject(new Error('Private OS decryption timed out')) }, 15_000)
    child.once('error', () => { clearTimeout(timer); reject(new Error('Private OS decryption unavailable')) })
    child.once('exit', code => {
      clearTimeout(timer)
      if (code !== 0) return reject(new Error('Private OS decryption failed'))
      const text = Buffer.concat(chunks), result = Buffer.from(text.toString().trim(), 'base64')
      text.fill(0); chunks.forEach(chunk => chunk.fill(0)); resolve(result)
    })
    child.stdin.end(wrapped.subarray(5).toString('base64'))
  })
  const protectedBytes = Buffer.from(encrypted.encryptionKey, 'base64')
  if (protectedBytes.subarray(0, 3).toString() !== 'v10') { osKey.fill(0); throw new Error('Unsupported protected model-key format') }
  const keyDecipher = createDecipheriv('aes-256-gcm', osKey, protectedBytes.subarray(3, 15))
  keyDecipher.setAuthTag(protectedBytes.subarray(-16))
  const plain = Buffer.concat([keyDecipher.update(protectedBytes.subarray(15, -16)), keyDecipher.final()]); osKey.fill(0)
  const sourceKey = plain.toString('utf8'); plain.fill(0); secrets.push(sourceKey)
  if (!/^[a-f0-9]{64}$/i.test(sourceKey)) throw new Error('Invalid OS-protected model-key format')
  const db = new DatabaseSync(sourceDb, { readOnly: true }); db.exec('PRAGMA query_only=ON')
  try {
    const row = db.prepare("SELECT provider,model_id,api_key,base_url,api_format,capabilities FROM models WHERE tenant_id='default' AND model_id=? AND is_enabled=1 AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT 1").get(modelId) as Json | undefined
    if (!row || typeof row.api_key !== 'string') throw new Error('Configured enabled source model was not found')
    const pieces = row.api_key.split(':')
    if (pieces.length !== 3) throw new Error('Unsupported encrypted model credential')
    const decipher = createDecipheriv('aes-256-gcm', Buffer.from(sourceKey, 'hex'), Buffer.from(pieces[0], 'hex'))
    decipher.setAuthTag(Buffer.from(pieces[1], 'hex'))
    const decoded = Buffer.concat([decipher.update(Buffer.from(pieces[2], 'hex')), decipher.final()])
    const apiKey = decoded.toString('utf8'); decoded.fill(0); secrets.push(apiKey)
    const endpoint = new URL(String(row.base_url))
    if (!['https:', 'http:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.hash) throw new Error('Unsupported configured model endpoint')
    return { provider: String(row.provider), modelId: String(row.model_id), apiKey, baseUrl: endpoint.href,
      apiFormat: String(row.api_format || 'auto'), capabilityOverrides: row.capabilities ? JSON.parse(String(row.capabilities)) : null }
  } finally { db.close() }
}

const textFrom = (value: any): string => typeof value === 'string' ? value : Array.isArray(value)
  ? value.map(part => typeof part === 'string' ? part : part.text || part.content || '').join('\n') : ''
function wireMessages(body: Json): Json[] { return Array.isArray(body.messages) ? body.messages : Array.isArray(body.input) ? body.input : [] }
function stageFrom(body: Json): Stage {
  const text = [textFrom(body.system), textFrom(body.instructions), ...wireMessages(body).map(message => textFrom(message.content))].join('\n')
  // Fixed utility-prompt signatures classify observations only; request bodies stay unchanged.
  if (text.trimStart().startsWith('作为一个记忆检索路由')) return 'memory_recall'
  if (text.trimStart().startsWith('你是一个记忆提取助手')) return 'memory_extraction'
  return body.stream === true || body.tools?.length ? 'main' : 'other_auxiliary'
}
function normalizedUsage(raw: Json[]) {
  const final = Object.assign({}, ...raw)
  const input = typeof final.prompt_tokens === 'number' ? final.prompt_tokens : typeof final.input_tokens === 'number'
    ? final.input_tokens + (final.cache_read_input_tokens || 0) + (final.cache_creation_input_tokens || 0) : undefined
  const hit = final.prompt_cache_hit_tokens ?? final.prompt_tokens_details?.cached_tokens ?? final.cache_read_input_tokens
  const miss = final.prompt_cache_miss_tokens ?? (typeof input === 'number' && typeof hit === 'number' ? Math.max(0, input - hit) : undefined)
  return { inputTokens: input, outputTokens: final.completion_tokens ?? final.output_tokens, cacheHitTokens: hit,
    cacheMissTokens: miss, cacheMissTokensSource: typeof final.prompt_cache_miss_tokens === 'number' ? 'provider' : typeof miss === 'number' ? 'total-input-minus-cache-hit' : 'unknown',
    cacheWriteTokens: final.cache_creation_input_tokens, reasoningTokens: final.completion_tokens_details?.reasoning_tokens,
    usageKnown: typeof input === 'number' && typeof (final.completion_tokens ?? final.output_tokens) === 'number' }
}
function usageEvents(text: string) {
  const fragments = text.trimStart().startsWith('{') ? [text] : text.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.replace(/^data:\s*/, ''))
  return fragments.flatMap(fragment => { try { const value = JSON.parse(fragment), usage = value.usage || value.message?.usage || value.response?.usage; return usage ? [usage] : [] } catch { return [] } })
}
function summary(attempts: Json[]) {
  const totals: Json = { requests: attempts.length, failedRequests: attempts.filter(attempt => attempt.error || attempt.httpStatus >= 400).length,
    unknownUsageRequests: attempts.filter(attempt => !attempt.usage?.usageKnown).length, elapsedMs: 0 }
  for (const field of ['inputTokens', 'outputTokens', 'cacheHitTokens', 'cacheMissTokens', 'cacheWriteTokens', 'reasoningTokens']) {
    const known = attempts.filter(attempt => typeof attempt.usage?.[field] === 'number')
    totals[field] = known.length ? known.reduce((total, attempt) => total + attempt.usage[field], 0) : attempts.length ? null : 0
    totals[field + 'KnownRequests'] = known.length
  }
  totals.elapsedMs = attempts.reduce((total, attempt) => total + (attempt.elapsedMs || 0), 0)
  totals.cacheHitRate = typeof totals.inputTokens === 'number' && totals.inputTokens > 0 && typeof totals.cacheHitTokens === 'number' ? totals.cacheHitTokens / totals.inputTokens : null
  return totals
}

function observeLogger(logger: any) {
  // Proxy children instead of replacing inherited log methods: preserve pino's
  // original receiver, child bindings and per-child level selection.
  const createChild = logger.child
  const wrap = (target: any): any => new Proxy(target, { get(object, property) {
    if (property === 'child') return (...values: any[]) => wrap(createChild.apply(object, values))
    if (property === 'info') return (...values: any[]) => {
      const record = values[0]
      if (record && typeof record === 'object' && record.event === 'memory.request') {
        const bindings = object.bindings?.() || {}
        const event = { at: Date.now(), sessionId: bindings.sessionId || current?.sessionId, requestId: bindings.requestId, stage: record.stage,
          type: record.type, requestAttemptId: record.requestAttemptId, outcome: record.outcome, memoryUsage: record.memoryUsage }
        if (current && event.sessionId === current.sessionId) current.memoryEvents.push(event)
        runtimeLog(event)
      }
      return object.info.apply(object, values)
    }
    return Reflect.get(object, property)
  } })
  logger.child = (...values: any[]) => wrap(createChild.apply(logger, values))
  return logger
}

function installProviderObserver(origin: string) {
  globalThis.fetch = async (input: any, init: any) => {
    const endpoint = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    if (endpoint.origin !== origin) {
      if (!['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname)) throw new Error('EVAL_EXTERNAL_NETWORK_BLOCKED')
      return nativeFetch(input, init)
    }
    const turn = current
    if (!turn || turn.attempts.length >= maxAttempts || Date.now() > turn.deadline) {
      if (turn) (turn.guardFailures ||= []).push('EVAL_PHYSICAL_REQUEST_LIMIT')
      return new Response(JSON.stringify({ error: { type: 'invalid_request_error', message: 'EVAL_PHYSICAL_REQUEST_LIMIT' } }), { status: 400, headers: { 'content-type': 'application/json' } })
    }
    const body = JSON.parse(String(init?.body || '{}')), messages = wireMessages(body), stage = stageFrom(body)
    const systems = [...(body.system ? [{ role: 'system', content: body.system }] : []), ...(body.instructions ? [{ role: 'system', content: body.instructions }] : []),
      ...messages.filter(message => ['system', 'developer'].includes(message.role))]
    const systemText = systems.map(message => textFrom(message.content)).join('\n')
    const history = messages.filter(message => !['system', 'developer'].includes(message.role))
    const modelHistory = history.filter(message => !textFrom(message.content).startsWith('[Current runtime context]'))
    const previous = previousMain.get(turn.sessionId)
    const memoryBlock = history.map(message => textFrom(message.content)).join('\n').match(/<memory_references>[\s\S]*?<\/memory_references>/)?.[0] || ''
    const item: Json = { index: turn.attempts.length + 1, stage, startedAt: Date.now(), model: body.model, stream: body.stream === true,
      systemSha256: hash(systems), systemTextSha256: hash(systemText), systemCharacters: systemText.length,
      toolsSha256: hash(body.tools || []), toolNames: (body.tools || []).map((tool: any) => tool.function?.name || tool.name),
      messageCount: messages.length, messageSha256: messages.map(hash), bodySha256: hash(body),
      memoryProjection: { present: !!memoryBlock, estimatedTokens: estimateMemoryTokens(memoryBlock), characters: memoryBlock.length,
        sha256: memoryBlock ? hash(memoryBlock) : null, text: memoryBlock },
      usage: { usageKnown: false } }
    if (stage === 'main') {
      let common = 0
      const hashes = modelHistory.map(hash)
      if (previous) while (common < Math.min(previous.history.length, hashes.length) && previous.history[common] === hashes[common]) common++
      item.rawWirePreviousComparison = previous ? { sameSystem: previous.systemHash === item.systemSha256,
        previousHistoryMessages: previous.history.length, sharedHistoryPrefixMessages: common,
        previousHistoryPreserved: common === previous.history.length } : null
      previousMain.set(turn.sessionId, { systemHash: item.systemSha256, history: hashes })
    }
    turn.attempts.push(item)
    let finish!: () => void
    const capture = new Promise<void>(resolve => { finish = resolve }); providerReads.add(capture)
    const finishRead = () => { providerReads.delete(capture); finish() }
    try {
      const response = await nativeFetch(input, { ...init, signal: AbortSignal.any([...(init?.signal ? [init.signal] : []), AbortSignal.timeout(Math.max(1, turn.deadline - Date.now()))]) })
      item.httpStatus = response.status; item.headersMs = Date.now() - item.startedAt
      void response.clone().text().then(text => { item.usage = normalizedUsage(usageEvents(text)); item.elapsedMs = Date.now() - item.startedAt })
        .catch(() => { item.captureFailed = true }).finally(finishRead)
      return response
    } catch (error) { item.error = scrub(String(error)); item.elapsedMs = Date.now() - item.startedAt; finishRead(); throw error }
  }
}

async function settleBackground(turn: Json) {
  let stable = 0
  while (Date.now() < turn.deadline) {
    const active = getActiveMemoryExtractionCount ? ['session', 'global'].reduce((total, scope) => total + getActiveMemoryExtractionCount!({ tenantId: 'default', scope,
      sessionId: scope === 'session' ? turn.sessionId : '' }), 0) : -1
    if (!providerReads.size && active === 0) stable++
    else stable = 0
    if (stable >= 4) { turn.backgroundSettled = true; turn.endToEndMs = Date.now() - turn.startedAt; return }
    await wait(200)
  }
  throw new Error('EVAL_BACKGROUND_NOT_SETTLED')
}
async function readChat(response: Response, turn: Json) {
  if (!response.headers.get('content-type')?.includes('text/event-stream') || !response.body) throw new Error('Evaluation chat did not return SSE: ' + scrub((await response.text()).slice(0, 2000)))
  const reader = response.body.getReader(), decoder = new TextDecoder()
  let pending = ''
  while (true) {
    const result = await reader.read()
    pending += decoder.decode(result.value, { stream: !result.done })
    let newline: number
    while ((newline = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, newline).trimEnd(); pending = pending.slice(newline + 1)
      if (!line.startsWith('data:')) continue
      const raw = line.slice(5).trimStart()
      if (raw === '[DONE]') { turn.doneReceived = true; continue }
      let event: Json
      try { event = JSON.parse(raw) } catch { continue }
      if (typeof event.content === 'string' && event.content) {
        turn.ttftMs ??= Date.now() - turn.startedAt
        turn.answer += event.content
      }
      if (typeof event.thinking === 'string' && event.thinking) turn.firstReasoningMs ??= Date.now() - turn.startedAt
      if (event.usage) turn.publishedUsage = event.usage
      if (event.run) turn.run = event.run
      if (event.error) (turn.streamErrors ||= []).push(event.error)
      const tool = event.toolStart || event.toolCall
      if (tool) turn.toolEvents.push({ name: tool.name || tool.toolName, id: tool.toolCallId })
    }
    if (result.done) break
  }
  turn.latencyMs = Date.now() - turn.startedAt
}
async function memoriesSnapshot(sessionId: string) {
  const result = await memory.getMemoryDb().execute({ sql: 'SELECT scope,type,summary FROM memory_nodes WHERE tenant_id=? AND (scope=\'global\' OR session_id=?) ORDER BY timestamp,id', args: ['default', sessionId] })
  return { count: result.rows.length, sessionCount: result.rows.filter((row: Json) => row.scope === 'session').length,
    globalCount: result.rows.filter((row: Json) => row.scope === 'global').length,
    summaryEstimatedTokens: result.rows.reduce((total: number, row: Json) => total + estimateMemoryTokens(String(row.summary)), 0),
    // Only synthetic facts introduced by this script exist in the isolated DB.
    nodes: result.rows.map((row: Json) => ({ scope: row.scope, type: row.type, summary: row.summary })) }
}
function durableHistorySnapshot(sessionId: string, round: number) {
  const archive = path.join(state, 'sessions', 'default', sessionId + '.jsonl')
  const messages = fs.existsSync(archive) ? fs.readFileSync(archive, 'utf8').trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line).payload).filter(Boolean) : []
  const userInputs = messages.filter(message => message.role === 'user').map(message => textFrom(message.content))
  return { archive, messages: messages.length, userMessages: userInputs.length,
    inputsExact: userInputs.length === round && userInputs.every((input, index) => input === prompts[index]),
    inputSha256: userInputs.map(hash), transientRuntimePersisted: messages.some(message => textFrom(message.content).includes('[Current runtime context]')) }
}
function checkAnswer(turn: Json) {
  const bullets = turn.answer.split(/\r?\n/).filter((line: string) => /^\s*[-*•]\s+|^\s*\d+[.、)]\s*/.test(line))
  if (turn.round === 1) return { answered: !!turn.answer.trim(), offDidNotClaimDurableSave: turn.group === 'on' || !/(已|已经|成功).{0,8}(保存|存入|记录).{0,8}(长期记忆|记忆库|记忆体)/.test(turn.answer) }
  return turn.round === 2 ? { threeBullets: bullets.length === 3, mintAccent: /强调色[：:]\s*薄荷绿/.test(turn.answer) }
    : { twoBullets: bullets.length === 2, orangeAccent: /强调色[：:]\s*琥珀橙/.test(turn.answer), oldAccentNotApplied: !turn.answer.includes('强调色：薄荷绿'),
      requestedFormatExact: turn.answer.split(/\r?\n/).filter((line: string) => line.trim()).length === 3 }
}

function markdown() {
  const lines = ['# 记忆开关三轮真实会话对照', '', `模型：${evidence.model.modelId}；开始：${evidence.startedAt}`, '',
    '| 组 | 轮次 | 主请求 | 召回请求 | 提取请求 | TTFT ms | 回答 ms | 含后台 ms | 主输入 | 缓存命中 | 主输出 | 记忆条数 | 注入估算 token |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|']
  for (const turn of evidence.turns) lines.push(`| ${turn.group.toUpperCase()} | ${turn.round} | ${turn.main?.requests ?? '?'} | ${turn.auxiliary?.recall?.requests ?? '?'} | ${turn.auxiliary?.extraction?.requests ?? '?'} | ${turn.ttftMs ?? '?'} | ${turn.latencyMs ?? '?'} | ${turn.endToEndMs ?? '?'} | ${turn.main?.inputTokens ?? '?'} | ${turn.main?.cacheHitTokens ?? '?'} | ${turn.main?.outputTokens ?? '?'} | ${turn.memoryAfter?.count ?? '?'} | ${turn.maxMemoryProjectionEstimatedTokens ?? '?'} |`)
  lines.push('', '系统提示稳定性：' + JSON.stringify(evidence.systemStability || {}), '', '统计限制：')
  for (const limitation of evidence.boundaries.limitations) lines.push('- ' + limitation)
  for (const turn of evidence.turns) lines.push('', `## ${turn.group.toUpperCase()} 第 ${turn.round} 轮`, '', `状态：${turn.run?.status || turn.error || 'unknown'}；内容校验：${JSON.stringify(turn.answerChecks || {})}`, '', turn.answer || '（无回答）')
  if (evidence.fatal) lines.push('', '执行错误：' + evidence.fatal)
  return lines.join('\n') + '\n'
}
function writeEvidence() { save('evidence.json', evidence); save('report.md', markdown()) }

async function main() {
  if (args['dry-run'] === 'true') { evidence.dryRun = true; save('plan.json', evidence); emit({ phase: 'dry-run', runRoot, turns: 6, realModelCalls: 0 }); return }
  evidence.sourceFileHashes = Object.fromEntries(['api/http/routes/chat.ts', 'middleware/memory/extractor.ts', 'middleware/memory/usage.ts',
    'core/chat-system-prompt.ts', 'core/memory-request-context.ts', 'core/agent-loop/react.ts'].map(relative => [relative,
    hash(fs.readFileSync(path.join(source, relative), 'utf8'))]))
  evidence.evalScriptSha256 = hash(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8'))
  const model = await loadModel()
  evidence.model = { provider: model.provider, modelId: model.modelId, apiFormat: model.apiFormat, endpointHost: new URL(model.baseUrl).hostname }
  // Set isolation before importing any engine module with singleton/path state.
  for (const key of Object.keys(process.env)) if (/API_?KEY|TOKEN|SECRET|ENCRYPTION_KEY|LLM_|MCP_|SKILLS_ROOT|AETHER_GLOBAL_DIR|DATA_DIR|AUTH_ENABLED|WORKSPACE_ROOT|EMBEDDING_|MEMORY_DB_PATH/.test(key)) delete process.env[key]
  const instanceToken = randomBytes(24).toString('hex'), engineKey = randomBytes(32).toString('hex'); secrets.push(instanceToken, engineKey)
  Object.assign(process.env, { NODE_ENV: 'production', LOG_LEVEL: 'silent', AUTH_ENABLED: 'false', AETHER_INSTANCE_TOKEN: instanceToken, ENCRYPTION_KEY: engineKey,
    DATA_DIR: path.join(state, 'agent.db'), KNOWLEDGE_DATA_DIR: path.join(state, 'knowledge.db'), AETHER_GLOBAL_DIR: path.join(runRoot, 'global'),
    WORKSPACE_ROOT: workspace, HISTORY_BACKEND: 'jsonl', MCP_CONFIG_PATH: path.join(runRoot, 'no-mcp.json'), QA_LOG_ENABLED: 'false',
    LLM_PRIMARY_MODEL: model.modelId, LLM_PROVIDER: model.provider, LLM_FALLBACK_MODEL: '', DEFAULT_SECURITY_MODE: 'standard', DISABLE_TELEMETRY: 'true', ENABLE_LONG_TERM_MEMORY: 'true' })
  process.chdir(workspace)
  console.log = (...values) => runtimeLog(values.map(String).join(' ')); console.warn = console.log; console.error = console.log
  observeLogger((await imported('observability/logger.ts')).logger)
  installProviderObserver(new URL(model.baseUrl).origin)
  database = await imported('storage/sqlite/db.ts'); await database.initDb()
  memory = await imported('storage/memory/index.ts'); await memory.initMemoryDb(memory.MEMORY_SCHEMA)
  getActiveMemoryExtractionCount = (await imported('storage/memory/extraction-coordinator.ts')).getActiveMemoryExtractionCount
  const estimate = (await imported('core/agent-loop/finalization.ts')).estimateRequestInput
  estimateMemoryTokens = text => text ? estimate([], undefined, [], text) : 0
  const { ModelsStore } = await imported('storage/sqlite/models.ts')
  await new ModelsStore().createModel({ tenantId: 'default', provider: model.provider, modelId: model.modelId, baseUrl: model.baseUrl,
    apiKey: model.apiKey, apiFormat: model.apiFormat, isEnabled: true, capabilities: model.capabilityOverrides })
  await memory.setMemoryPreferences('default', { globalEnabled: false, sessionDefaultEnabled: false })
  await memory.setSessionMemoryEnabled('default', sessions.off, false)
  await memory.setSessionMemoryEnabled('default', sessions.on, true)
  evidence.resolvedPolicies = { off: await memory.getSessionMemorySettings('default', sessions.off), on: await memory.getSessionMemorySettings('default', sessions.on) }
  skills = (await imported('skills/index.ts')).skillsRegistry; skills.start()
  app = await (await imported('api/http/index.ts')).buildServer({ listenHost: '127.0.0.1', desktopOwned: true })
  cron = (await imported('scheduler/cron-scheduler.ts')).cronScheduler; await cron.stop()
  await app.listen({ host: '127.0.0.1', port: 0 })
  const base = `http://127.0.0.1:${app.server.address().port}`
  const headers = { 'content-type': 'application/json', 'x-aether-instance-token': instanceToken, 'x-aether-tool-profile': 'general', 'x-aether-run-lifetime': 'attached' }
  emit({ phase: 'ready', runRoot, model: evidence.model })
  for (let round = 1; round <= 3; round++) for (const group of evidence.boundaries.roundOrder[round - 1] as Group[]) {
    const turn: Json = { group, round, sessionId: sessions[group], input: prompts[round - 1], inputSha256: hash(prompts[round - 1]),
      startedAt: Date.now(), deadline: Date.now() + timeoutMs, attempts: [], memoryEvents: [], toolEvents: [], answer: '', backgroundSettled: false }
    current = turn; evidence.turns.push(turn); turn.memoryBefore = await memoriesSnapshot(turn.sessionId)
    emit({ phase: 'turn-start', group, round })
    try {
      const response = await nativeFetch(base + '/api/v1/chat', { method: 'POST', headers, body: JSON.stringify({ sessionId: turn.sessionId,
        message: turn.input, model: model.modelId, workspacePaths: [workspace], thinkingMode: false, allowedTools,
        skills: [], mcpServers: [], knowledgeBases: [] }), signal: AbortSignal.timeout(timeoutMs) })
      turn.httpStatus = response.status; await readChat(response, turn); await settleBackground(turn)
      const status = await nativeFetch(base + '/api/v1/chat/status?sessionId=' + encodeURIComponent(turn.sessionId), { headers }).then(response => response.json()) as Json
      turn.run = status.data?.run || turn.run
      turn.memoryAfter = await memoriesSnapshot(turn.sessionId)
      turn.durableHistory = durableHistorySnapshot(turn.sessionId, round)
      turn.answerChecks = checkAnswer(turn)
    } catch (error) {
      turn.error = scrub(String(error))
      await nativeFetch(base + '/api/v1/chat/cancel', { method: 'POST', headers, body: JSON.stringify({ sessionId: turn.sessionId }) }).catch(() => {})
      await settleBackground(turn).catch(() => {})
    }
    turn.main = summary(turn.attempts.filter((attempt: Json) => attempt.stage === 'main'))
    turn.auxiliary = { recall: summary(turn.attempts.filter((attempt: Json) => attempt.stage === 'memory_recall')),
      extraction: summary(turn.attempts.filter((attempt: Json) => attempt.stage === 'memory_extraction')),
      other: summary(turn.attempts.filter((attempt: Json) => attempt.stage === 'other_auxiliary')) }
    turn.memoryUsageHook = turn.memoryEvents.at(-1)?.memoryUsage || null
    turn.hookPhysicalRequestCountsMatch = turn.group === 'off' ? turn.memoryEvents.length === 0 : turn.memoryUsageHook
      ? turn.memoryUsageHook.recall.requests === turn.auxiliary.recall.requests && turn.memoryUsageHook.extraction.requests === turn.auxiliary.extraction.requests : false
    turn.hookUsageMatchesWire = turn.group === 'off' ? turn.memoryEvents.length === 0 : !!turn.memoryUsageHook && (['recall', 'extraction'] as const).every(stage => {
      const observed = turn.memoryUsageHook[stage], wire = turn.auxiliary[stage]
      return observed.requests === wire.requests && observed.promptTokens === wire.inputTokens && observed.completionTokens === wire.outputTokens
        && observed.cacheHitTokens === wire.cacheHitTokens && observed.cacheMissTokens === wire.cacheMissTokens
    })
    turn.maxMemoryProjectionEstimatedTokens = Math.max(0, ...turn.attempts.filter((attempt: Json) => attempt.stage === 'main').map((attempt: Json) => attempt.memoryProjection.estimatedTokens))
    turn.totalPhysicalRequests = turn.attempts.length
    writeEvidence(); save(`${group}-${round}.json`, turn)
    emit({ phase: 'turn-finished', group, round, status: turn.run?.status, latencyMs: turn.latencyMs, ttftMs: turn.ttftMs,
      requests: turn.totalPhysicalRequests, memoryNodes: turn.memoryAfter?.count, error: turn.error })
    if (turn.error || turn.run?.status !== 'succeeded' || !turn.backgroundSettled || turn.guardFailures?.length) throw new Error('Evaluation turn failed; later paired rounds were not executed')
  }
  evidence.systemStability = Object.fromEntries((['off', 'on'] as Group[]).map(group => {
    const hashes = evidence.turns.filter((turn: Json) => turn.group === group).flatMap((turn: Json) => turn.attempts.filter((attempt: Json) => attempt.stage === 'main').map((attempt: Json) => attempt.systemSha256))
    return [group, { mainRequests: hashes.length, uniqueSystemHashes: [...new Set(hashes)], stableAcrossAllMainRequests: hashes.length > 0 && new Set(hashes).size === 1 }]
  }))
  evidence.inputPairsIdentical = prompts.map((_prompt, index) => { const turns = evidence.turns.filter((turn: Json) => turn.round === index + 1); return turns.length === 2 && turns[0].inputSha256 === turns[1].inputSha256 })
  evidence.completed = evidence.turns.length === 6 && evidence.turns.every((turn: Json) => turn.run?.status === 'succeeded' && turn.backgroundSettled)
  evidence.validation = { durableHistoryInputsExact: evidence.turns.every((turn: Json) => turn.durableHistory?.inputsExact === true),
    transientRuntimePersisted: evidence.turns.some((turn: Json) => turn.durableHistory?.transientRuntimePersisted === true),
    hookPhysicalRequestCountsMatch: evidence.turns.every((turn: Json) => turn.hookPhysicalRequestCountsMatch === true),
    hookUsageMatchesWire: evidence.turns.every((turn: Json) => turn.hookUsageMatchesWire === true),
    thirdRoundStrictFormat: evidence.turns.filter((turn: Json) => turn.round === 3).map((turn: Json) => ({ group: turn.group, passed: turn.answerChecks.requestedFormatExact })) }
  evidence.groupTotals = Object.fromEntries((['off', 'on'] as Group[]).map(group => {
    const attempts = evidence.turns.filter((turn: Json) => turn.group === group).flatMap((turn: Json) => turn.attempts)
    return [group, { all: summary(attempts), main: summary(attempts.filter((attempt: Json) => attempt.stage === 'main')),
      recall: summary(attempts.filter((attempt: Json) => attempt.stage === 'memory_recall')),
      extraction: summary(attempts.filter((attempt: Json) => attempt.stage === 'memory_extraction')) }]
  }))
}

try { await main() }
catch (error) { evidence.fatal = scrub(String(error)); emit({ phase: 'fatal', error: evidence.fatal }) }
finally {
  evidence.finishedAt = new Date().toISOString(); writeEvidence()
  globalThis.fetch = nativeFetch
  try { await app?.close(); skills?.stop(); await memory?.closeMemoryDb(); await database?.closeDb() } catch (error) { evidence.cleanupError = scrub(String(error)); writeEvidence() }
  console.log = nativeConsole.log; console.warn = nativeConsole.warn; console.error = nativeConsole.error
  emit({ phase: 'finished', runRoot, completed: !!evidence.completed, dryRun: !!evidence.dryRun, fatal: evidence.fatal })
  process.exit(evidence.fatal ? 1 : 0)
}
