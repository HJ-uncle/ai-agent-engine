/** Offline summary only: no provider requests, production DB or artifact writes. */
import fs from 'node:fs'
import path from 'node:path'

const repo = process.cwd()
const campaign = path.resolve(repo, '.e2e-tmp/read-batch-20261109')
const hardened = JSON.parse(fs.readFileSync(path.join(campaign, 'hardened-v1-recheck.json'), 'utf8'))
const firstPassReview = JSON.parse(fs.readFileSync(path.join(campaign, 'v5-firstpass-input-verification-recheck.json'), 'utf8'))
const runs = fs.readdirSync(path.join(campaign, 'live')).sort().map(name => {
  const evidencePath = path.join(campaign, 'live', name, 'evidence.json')
  const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'))
  return {
    label: evidence.label, evidencePath, sourceTreeSha256: evidence.sourceTreeSha256,
    model: evidence.model, thinking: evidence.thinkingRequested,
    startedAt: evidence.startedAt, finishedAt: evidence.finishedAt,
    cases: evidence.cases.map((item: any) => {
      const review = evidence.label === 'batch-v1-low' ? hardened.results.find((r: any) => r.id === item.case) : undefined
      const firstPassRecheck = evidence.label === 'batch-v5-firstpass' && item.case === 'batch_io_firstpass'
        ? firstPassReview.cases.find((r: any) => r.repeat === item.repeat) : undefined
      const check = firstPassRecheck?.recheckedChecks || review?.check || item.check || {}
      const attempts = item.attempts || []
      const output = attempts.reduce((total: number, attempt: any) => total +
        (attempt.finalProviderUsage?.completion_tokens ?? attempt.finalProviderUsage?.output_tokens ?? 0), 0)
      const { batches, ...checks } = check
      return {
        case: item.case, repeat: item.repeat, originalPassed: item.passed,
        acceptanceLevel: item.case.includes('firstpass') ? 'first-pass: no corrective writes' : item.case === 'greeting' ? 'greeting' : 'final outcome; may include repairs',
        passed: firstPassRecheck ? firstPassRecheck.checksPass && item.turnStates.every((s: any) => s.status === 'succeeded') : review ? review.passed : item.passed,
        ...(firstPassRecheck ? { acceptanceRecheck: firstPassReview.reason, changedChecks: firstPassRecheck.changedChecks,
          originalEvidencePreserved: firstPassReview.originalEvidenceUnchanged } : {}),
        runStatus: item.turnStates?.at(-1)?.status, failedChecks: Object.entries(checks).filter(([, v]) => v === false).map(([k]) => k),
        checks, batches, totalProviderRequests: attempts.length,
        requestsWithTools: attempts.filter((a: any) => a.toolCount > 0).length,
        firstWorkInput: item.firstWorkAttempt?.providerTotalInput,
        knownProviderInput: item.knownProviderInput || 0, knownProviderOutput: output,
        knownProviderTotal: (item.knownProviderInput || 0) + output,
        providerUsageComplete: item.providerUsageComplete,
        elapsedMs: item.elapsedMs, totalWallMs: item.totalWallMs,
        answer: item.answer, evidencePath: path.join(path.dirname(evidencePath), `${item.case}-${item.repeat}.json`),
      }
    }),
  }
})
const cases = runs.flatMap(run => run.cases)
const total = (selected: typeof cases) => ({
  scenarios: selected.length, passed: selected.filter(c => c.passed).length,
  providerRequests: selected.reduce((n, c) => n + c.totalProviderRequests, 0),
  knownProviderInput: selected.reduce((n, c) => n + c.knownProviderInput, 0),
  knownProviderOutput: selected.reduce((n, c) => n + c.knownProviderOutput, 0),
  knownProviderTotal: selected.reduce((n, c) => n + c.knownProviderTotal, 0),
  providerUsageComplete: selected.every(c => c.providerUsageComplete),
})
const summary = {
  scope: 'Batch I/O evaluation; Work HTTP route with isolated workspace/state, production model configuration read-only.',
  countPolicy: 'Provider totals include cached input and auxiliary requests, not a currency bill. requestsWithTools counts requests carrying schemas. Retain failed attempts.',
  acceptance: 'Distinct expected targets with successful tool receipts in one response; exact bytes/formulas/facts and final manifest identity. No native Office visual claim.',
  totals: total(cases),
  followUpTotals: total(runs.filter(run => /^batch-v[56]-/.test(run.label)).flatMap(run => run.cases)),
  pagination: JSON.parse(fs.readFileSync(path.join(campaign, 'text-pagination-property-check.json'), 'utf8')),
  runs,
}
const destination = path.resolve(repo, 'docs/research/batch-io-evaluation-2026-11-09.json')
fs.writeFileSync(destination, JSON.stringify(summary, null, 2) + '\n')
console.log(JSON.stringify({ destination, totals: summary.totals,
  runs: runs.map(run => ({ label: run.label, cases: run.cases.map(({ batches, answer, ...item }: any) => item) })) }, null, 2))
