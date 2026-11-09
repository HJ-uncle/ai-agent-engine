/** Summarize sanitized real-provider evidence; never reads model credentials. */
import fs from 'node:fs'
import path from 'node:path'

const campaign = path.resolve(process.argv[2] || '.e2e-tmp/prompt-compression-20261106/results')
const output = path.resolve(process.argv[3] || '.e2e-tmp/prompt-compression-20261106/measurement-summary.json')

function inputOf(attempt) {
  if (typeof attempt?.providerTotalInput === 'number') return attempt.providerTotalInput
  const usage = attempt?.usage?.at(-1)
  if (!usage) return undefined
  if (typeof usage.prompt_tokens === 'number') return usage.prompt_tokens
  if (typeof usage.input_tokens !== 'number') return undefined
  return usage.input_tokens + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0)
}
function outputOf(attempt) {
  const usage = attempt?.finalProviderUsage || attempt?.usage?.at(-1)
  return usage?.completion_tokens ?? usage?.output_tokens
}

const rows = []
for (const directory of fs.readdirSync(campaign, { withFileTypes: true })) {
  if (!directory.isDirectory()) continue
  const file = path.join(campaign, directory.name, 'evidence.json')
  if (!fs.existsSync(file)) continue
  const run = JSON.parse(fs.readFileSync(file, 'utf8'))
  for (const test of run.cases || []) {
    const reviewFile = path.join(campaign, directory.name, `${test.case}-${test.repeat}-review.json`)
    const review = fs.existsSync(reviewFile) ? JSON.parse(fs.readFileSync(reviewFile, 'utf8')) : undefined
    const attempts = test.attempts || []
    const first = test.firstWorkAttempt || attempts.find(attempt => attempt.toolCount > 0)
    const persisted = (test.mainUsage || test.messages?.filter(message => message.role === 'assistant' && message.usage).map(message => message.usage) || [])[0]
    const inputs = attempts.map(inputOf)
    const checks = Object.entries(review?.correctedCheck || test.check || {}).filter(([, value]) => typeof value === 'boolean')
    const status = test.status?.data?.run?.status
    rows.push({
      label: run.label, case: test.case, repeat: test.repeat,
      sourceRoot: run.sourceRoot, startedAt: run.startedAt,
      evidence: path.relative(process.cwd(), file).replaceAll('\\', '/'),
      firstInput: inputOf(first) ?? persisted?.currentPromptTokens ?? persisted?.promptTokens,
      firstToolCount: first?.toolCount,
      knownAllProviderInput: inputs.some(value => value !== undefined) ? inputs.reduce((sum, value) => sum + (value || 0), 0) : undefined,
      knownAllProviderOutput: attempts.reduce((sum, attempt) => sum + (outputOf(attempt) || 0), 0),
      attempts: attempts.length, unmeteredAttempts: inputs.filter(value => value === undefined).length,
      elapsedMs: test.elapsedMs, status,
      passed: review?.correctedPassed ?? test.passed ?? (status === 'succeeded' && checks.length > 0 && checks.every(([, value]) => value)),
      review: review ? { reason: review.reason, evidence: path.relative(process.cwd(), reviewFile).replaceAll('\\', '/') } : undefined,
      diagnosticOnly: run.diagnosticOnly || !!run.wireVariant && run.wireVariant !== 'unchanged',
      failedChecks: checks.filter(([, value]) => !value).map(([key]) => key),
      toolNames: test.toolNames || [...new Set((test.messages || []).flatMap(message => [message.toolName, message.toolCall?.name,
        ...(message.toolCalls || []).map(call => call.name)]).filter(Boolean))],
      error: test.error || test.status?.data?.run?.error || run.fatal,
    })
  }
}
rows.sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)) || a.case.localeCompare(b.case) || a.repeat - b.repeat)
const summary = { generatedAt: new Date().toISOString(), counting: 'Provider total input includes cached reads/writes. SSE usage snapshots are not summed. Known totals omit unmetered attempts; diagnostic variants are not functional candidates.', rows }
fs.mkdirSync(path.dirname(output), { recursive: true })
fs.writeFileSync(output, JSON.stringify(summary, null, 2) + '\n')
const number = value => typeof value === 'number' ? value.toLocaleString('en-US') : '—'
const markdown = ['| 版本 | 场景 | 次数 | 结果 | 首轮输入（含缓存） | 首轮工具数 | 已知总输入 | 调用数 | 耗时/秒 |',
  '|---|---|---:|---|---:|---:|---:|---:|---:|',
  ...rows.map(row => `| ${row.label} | ${row.case} | ${row.repeat} | ${row.passed ? '通过' : '未通过'} | ${number(row.firstInput)} | ${number(row.firstToolCount)} | ${number(row.knownAllProviderInput)}${row.unmeteredAttempts ? '†' : ''} | ${row.attempts} | ${row.elapsedMs ? (row.elapsedMs / 1000).toFixed(2) : '—'} |`),
  '', '† 存在无用量回执的调用，已知总输入不是完整消费。辅助标题等调用纳入总输入；诊断性删描述不计功能成功。', ''].join('\n')
fs.writeFileSync(output.replace(/\.json$/, '.md'), markdown)
console.log(JSON.stringify({ output, cases: rows.length, labels: [...new Set(rows.map(row => row.label))] }))
