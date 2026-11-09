/** Summarize provider receipts across parents and children; never copy prompts or credentials. */
import fs from 'node:fs'
import path from 'node:path'

const campaign = path.resolve(process.argv[2] || '.e2e-tmp/team-token-20261109/results')
const output = path.resolve(process.argv[3] || 'docs/research/team-token-optimization-measurements-2026-11-09.json')
const sum = (values: number[]) => values.reduce((total, value) => total + value, 0)
const cases: Record<string, unknown>[] = []
const startupFailures: Record<string, unknown>[] = []

for (const directory of fs.readdirSync(campaign, { withFileTypes: true }).filter(entry => entry.isDirectory())) {
  const run = path.join(campaign, directory.name)
  const evidencePath = path.join(run, 'evidence.json')
  if (!fs.existsSync(evidencePath)) continue
  const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'))
  if (evidence.fatal) startupFailures.push({ run: directory.name, error: evidence.fatal, cases: evidence.cases?.length ?? 0 })
  for (const file of fs.readdirSync(run).filter(name => /-\d+\.json$/.test(name))) {
    const result = JSON.parse(fs.readFileSync(path.join(run, file), 'utf8'))
    if (!Array.isArray(result.attempts)) continue
    const input = sum(result.attempts.map((attempt: any) => attempt.providerTotalInput ?? 0))
    const tokensOut = sum(result.attempts.map((attempt: any) => attempt.finalProviderUsage?.output_tokens ?? attempt.finalProviderUsage?.completion_tokens ?? 0))
    const unmeteredRequests = result.attempts.filter((attempt: any) => typeof attempt.providerTotalInput !== 'number'
      || typeof (attempt.finalProviderUsage?.output_tokens ?? attempt.finalProviderUsage?.completion_tokens) !== 'number')
      .map((attempt: any) => ({ attempt: attempt.attempt, httpStatus: attempt.httpStatus, streamReadFailed: attempt.streamReadFailed === true, inputReservation: attempt.reservedInputTokens }))
    const uniqueMessages = new Map<string, any>()
    for (const message of [...(result.messages ?? []), ...(result.childMessages ?? [])]) {
      if (message.id) uniqueMessages.set(`${message.childSessionId ?? result.sessionId}/${message.id}`, message)
    }
    const actors = new Map<string, { responses: number; input: number; output: number; total: number }>()
    for (const message of uniqueMessages.values()) {
      if (message.role !== 'assistant' || !message.usage) continue
      const key = message.childSessionId ?? 'parent'
      const actor = actors.get(key) ?? { responses: 0, input: 0, output: 0, total: 0 }
      actor.responses++
      actor.input += message.usage.promptTokens ?? 0
      actor.output += message.usage.completionTokens ?? 0
      actor.total += message.usage.totalTokens ?? 0
      actors.set(key, actor)
    }
    const persistedTotal = sum([...actors.values()].map(actor => actor.total))
    const calls = [...uniqueMessages.values()].flatMap(message => message.toolCalls?.length ? message.toolCalls : message.toolCall ? [message.toolCall] : [])
    const runState = result.status?.data?.run
    cases.push({
      run: directory.name, case: result.case, repeat: result.repeat,
      evidence: path.relative(process.cwd(), path.join(run, file)).replaceAll('\\', '/'),
      passed: result.passed === true, runStatus: runState?.status, error: result.error ?? runState?.error,
      requests: result.attempts.length, input, output: tokensOut, total: input + tokensOut,
      totalIsLowerBound: unmeteredRequests.length > 0, unmeteredRequests,
      providerUsageComplete: result.providerUsageComplete === true,
      evaluationGuardFailures: result.guardFailures ?? [],
      persistedTotal, persistedMatchesProvider: unmeteredRequests.length ? null : persistedTotal === input + tokensOut,
      actors: Object.fromEntries(actors), elapsedMs: result.elapsedMs,
      children: result.postconditions?.subagents ?? [],
      toolCalls: calls.reduce((counts: Record<string, number>, call: any) => {
        counts[call.name] = (counts[call.name] ?? 0) + 1
        return counts
      }, {}),
      checks: Object.fromEntries(Object.entries(result.check ?? {}).filter(([, value]) => typeof value === 'boolean')),
      deliveredFormats: result.check?.formats ?? [],
    })
  }
}
const result = {
  generatedAt: new Date().toISOString(), campaign,
  accounting: 'Final provider input (including cached input) plus output, once per fetch response. All parent/child calls included. Incomplete/aborted receipts make total a KNOWN LOWER BOUND, never an exact bill. Persisted usage is independently deduplicated by session/message ID. These are token counts, not monetary charges.',
  limitations: ['Historical comparisons are not controlled A/B tests.', 'Identical body hashes only detect identical local fetch requests, not semantic duplication or gateway retries.', 'Native Office visual rendering was not tested.'],
  cases, startupFailures,
  totals: { requests: sum(cases.map(item => item.requests as number)), input: sum(cases.map(item => item.input as number)), output: sum(cases.map(item => item.output as number)), total: sum(cases.map(item => item.total as number)), totalIsLowerBound: cases.some(item => item.totalIsLowerBound), unmeteredRequests: sum(cases.map(item => (item.unmeteredRequests as unknown[]).length)) },
}
fs.mkdirSync(path.dirname(output), { recursive: true })
fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n')
console.log(JSON.stringify({ output, cases: cases.map(({ run, case: name, passed, requests, input, output, total, persistedMatchesProvider }) => ({ run, case: name, passed, requests, input, output, total, persistedMatchesProvider })), totals: result.totals, startupFailures }, null, 2))
