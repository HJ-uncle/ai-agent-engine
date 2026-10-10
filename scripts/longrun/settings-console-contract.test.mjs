import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import ts from 'typescript'

const source = fs.readFileSync(new URL('../../multi-agent-console/src/web/components/settings/settings-patch.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
const { buildSettingsPatch } = await import('data:text/javascript;base64,' + Buffer.from(compiled).toString('base64'))
const keys = ['MAX_ITERATIONS', 'TOKEN_BUDGET', 'CMD_TIMEOUT_MS', 'COMPRESS_THRESHOLD_RATIO', 'QA_LOG_ENABLED']

test('saving an untouched page never writes displayed defaults or execution ceilings', () => {
  const oldDisplay = { MAX_ITERATIONS: 50, TOKEN_BUDGET: 80000, CMD_TIMEOUT_MS: 5000, COMPRESS_THRESHOLD_RATIO: 0.5, QA_LOG_ENABLED: false }
  assert.deepEqual(buildSettingsPatch(keys, { ...oldDisplay }, oldDisplay), {})
  const unlimited = { MAX_ITERATIONS: null, TOKEN_BUDGET: null, CMD_TIMEOUT_MS: null, COMPRESS_THRESHOLD_RATIO: 0.92 }
  assert.deepEqual(buildSettingsPatch(keys, { ...unlimited }, unlimited), {})
})
test('changing an unrelated switch cannot reintroduce untouched budgets', () => {
  const baseline = { MAX_ITERATIONS: 50, TOKEN_BUDGET: 80000, CMD_TIMEOUT_MS: 5000, COMPRESS_THRESHOLD_RATIO: 0.5, QA_LOG_ENABLED: true }
  assert.deepEqual(buildSettingsPatch(keys, { ...baseline, QA_LOG_ENABLED: false }, baseline), { QA_LOG_ENABLED: false })
})
test('clearing explicit numeric limits sends null and reverting an edit removes it', () => {
  const baseline = { MAX_ITERATIONS: 50, TOKEN_BUDGET: 80000, CMD_TIMEOUT_MS: 5000, COMPRESS_THRESHOLD_RATIO: 0.5 }
  assert.deepEqual(buildSettingsPatch(keys, { ...baseline, MAX_ITERATIONS: null, TOKEN_BUDGET: null, CMD_TIMEOUT_MS: null }, baseline), { MAX_ITERATIONS: null, TOKEN_BUDGET: null, CMD_TIMEOUT_MS: null })
  assert.deepEqual(buildSettingsPatch(keys, { ...baseline, COMPRESS_THRESHOLD_RATIO: 0.92 }, baseline), { COMPRESS_THRESHOLD_RATIO: 0.92 })
  assert.deepEqual(buildSettingsPatch(keys, baseline, baseline), {})
})
test('saved snapshot baselines leave edits made during an in-flight save dirty', () => {
  const before = { MAX_ITERATIONS: null, QA_LOG_ENABLED: false }
  const sent = buildSettingsPatch(keys, { ...before, MAX_ITERATIONS: 100 }, before)
  const confirmed = { ...before, ...sent }
  assert.deepEqual(buildSettingsPatch(keys, { ...confirmed, MAX_ITERATIONS: 200 }, confirmed), { MAX_ITERATIONS: 200 })
})
test('explicit overrides preserve false/zero/null while read-only metadata stays out of PUT', () => {
  assert.deepEqual(buildSettingsPatch([...keys, 'managedKeys', 'runtimeLimits'], { runtimeLimits: { code: {} }, managedKeys: [] }, {}, { MAX_ITERATIONS: null, CMD_TIMEOUT_MS: 0, QA_LOG_ENABLED: false, runtimeLimits: { injected: true } }), { MAX_ITERATIONS: null, CMD_TIMEOUT_MS: 0, QA_LOG_ENABLED: false })
})
