import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkOfficeBundle } from './office-bundle-fixture.js'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const campaign = path.join(repo, '.e2e-tmp/office-incident-20261109/live')
const manualReviews = JSON.parse(fs.readFileSync(path.join(repo, 'docs/research/office-incident-manual-reviews-2026-11-09.json'), 'utf8'))
const results: any[] = []
const setupFailures: any[] = []
for (const name of fs.readdirSync(campaign)) {
  const root = path.join(campaign, name)
  const evidence = JSON.parse(fs.readFileSync(path.join(root, 'evidence.json'), 'utf8'))
  if (evidence.fatal) setupFailures.push({ name, error: evidence.fatal, cases: evidence.cases.length })
  for (const saved of evidence.cases) {
    const filename = path.join(root, `${saved.case}-${saved.repeat}.json`)
    if (!fs.existsSync(filename)) continue
    const value = JSON.parse(fs.readFileSync(filename, 'utf8'))
    // Tightened checks are reapplied offline; keep original raw evidence intact.
    const checks = value.case.startsWith('office_bundle') ? await checkOfficeBundle(value) : value.check
    const usage = value.mainUsage || []
    const total = (key: string) => usage.reduce((sum: number, item: any) => sum + (item[key] || 0), 0)
    const attempts = value.attempts || []
    const hashes = attempts.map((item: any) => item.bodySha256)
    const pending = value.status?.data?.run?.pending || []
    const automatedPassed = !value.error && value.turnStates.length > 0 && value.turnStates.every((state: any) => state.status === 'succeeded')
      && Object.values(checks || {}).filter(item => typeof item === 'boolean').every(Boolean)
    const manualReview = manualReviews.find((review: any) => review.run === name && review.case === value.case)
    results.push({ run: name, case: value.case, repeat: value.repeat, thinkingRequested: evidence.thinkingRequested,
      sourceTreeSha256: evidence.sourceTreeSha256, evidence: path.relative(repo, filename).replaceAll('\\', '/'),
      originalRecordedPassed: value.passed, automatedPassed, manualReview, passed: automatedPassed && manualReview?.passed !== false,
      error: value.error, stopStates: value.turnStates.map((state: any) => state.status),
      pendingTools: pending.map((item: any) => ({ kind: item.kind, tool: item.toolName })),
      elapsedMs: value.elapsedMs, totalWallMs: value.totalWallMs,
      mainResponses: usage.length, mainInput: total('promptTokens'), mainOutput: total('completionTokens'), mainTotal: total('totalTokens'),
      firstInput: usage[0]?.promptTokens, lastInput: usage.at(-1)?.promptTokens,
      providerAttempts: attempts.length, knownProviderInput: value.knownProviderInput,
      knownProviderOutput: attempts.reduce((sum: number, item: any) => sum + (item.finalProviderUsage?.completion_tokens ?? item.finalProviderUsage?.output_tokens ?? 0), 0),
      providerUsageComplete: value.providerUsageComplete,
      sameRequestBodies: hashes.length - new Set(hashes).size,
      duplicateWholeMessagesWithinRequests: attempts.reduce((sum: number, item: any) => sum + (item.messageSha256?.length || 0) - new Set(item.messageSha256 || []).size, 0),
      requestedWireEfforts: [...new Set(attempts.map((item: any) => item.reasoningEffort).filter(Boolean))],
      wireThinking: attempts.map((item: any) => ({ toolCount: item.toolCount, reasoningEffort: item.reasoningEffort,
        thinking: item.thinking, enableThinking: item.enableThinking, httpStatus: item.httpStatus })),
      officePolicyPresentOnAllToolRequests: attempts.filter((item: any) => item.toolCount > 0).every((item: any) => item.officeDraftPolicyPresent && item.officeScopePolicyPresent),
      plan: value.postconditions?.todos?.map((item: any) => ({ title: item.title, status: item.status })),
      check: checks,
    })
  }
}
const summary = {
  generatedAt: new Date().toISOString(), baseline: { mainResponses: 80, mainInput: 5021090, mainOutput: 103092, mainTotal: 5124182, elapsedMs: 883633, requestedThinking: 'low' },
  setupFailures, results,
  campaign: { cases: results.length, providerAttempts: results.reduce((sum, row) => sum + row.providerAttempts, 0),
    knownProviderInput: results.reduce((sum, row) => sum + row.knownProviderInput, 0),
    knownProviderOutput: results.reduce((sum, row) => sum + row.knownProviderOutput, 0),
    usageComplete: results.every(row => row.providerUsageComplete),
  },
  boundaries: ['Source-tree snapshots differ by candidate; failed candidates remain reported.',
    'Original full history is not cloned. Replay seeds only the immediately preceding real user/assistant text, copies project inputs and issues the original topic supplement through the Work route.',
    'Request hashes inspect the local fetch boundary, not retries inside the provider gateway. Whole-message hashes cannot detect all semantic duplication.',
    'Artifact checks cover content, structure, formula caches and lifecycle. No native Office rendering was performed.'],
}
const output = path.join(repo, 'docs/research/office-incident-evaluation-2026-11-09.json')
fs.writeFileSync(output, JSON.stringify(summary, null, 2) + '\n')
console.log(JSON.stringify({ output, campaign: summary.campaign, cases: results.map(({ run, case: id, passed, mainTotal, mainResponses, elapsedMs }) => ({ run, id, passed, mainTotal, mainResponses, elapsedMs })) }))
