/** Isolated route/storage probes. Uses new fixture data only; never calls a model. */
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import Fastify from 'fastify'

const root = process.cwd()
fs.mkdirSync(path.join(root, '.e2e-tmp'), { recursive: true })
const fixture = fs.mkdtempSync(path.join(root, '.e2e-tmp', 'consumer-data-audit-'))
Object.assign(process.env, {
  DATA_DIR: path.join(fixture, 'agent.db'),
  ENCRYPTION_KEY: '2'.repeat(64), AUTH_ENABLED: 'false', LOG_LEVEL: 'silent'
})
const { initDb, closeDb } = await import('../../src/storage/sqlite/db.js')
const { ModelsStore } = await import('../../src/storage/sqlite/models.js')
const { ChangeStore } = await import('../../src/storage/changes/index.js')
const { modelsRoutes } = await import('../../src/api/http/routes/models.js')
const { changeRoutes } = await import('../../src/api/http/routes/changes.js')
await initDb()
const app = Fastify()
await app.register(modelsRoutes)
await app.register(changeRoutes, { prefix: '/api/v1' })
await app.ready()
const models = new ModelsStore()
const changes = new ChangeStore()
const evidence: Record<string, unknown> = {
  capturedAt: new Date().toISOString(), fixture,
  scope: 'Actual route handlers and SQLite stores with synthetic data. No Electron UI or authentication integration in this probe. Revert ordering is deliberately controlled; this demonstrates order sensitivity, not the frequency of a concurrent race.'
}
try {
  const initialCapabilities = {
    vision: true, thinking: false, contextWindow: 123456,
    toolCalling: true, parallelTools: true, streamUsage: true
  }
  const model = await models.createModel({
    tenantId: 'default', provider: 'openai', modelId: 'audit-synthetic-model',
    apiKey: 'synthetic-local-fixture-only', baseUrl: 'https://example.invalid/v1',
    isEnabled: true, displayName: 'Before', capabilities: initialCapabilities
  })
  // ModelFormDialog builds only vision/thinking on save, even for a display-name edit.
  const payload = { displayName: 'After', capabilities: { vision: true, thinking: false } }
  const response = await app.inject({ method: 'PUT', url: `/api/v1/models/${model.id}`, payload })
  const after = await models.getModelById(model.id, 'default')
  assert.equal(response.statusCode, 200)
  assert.equal(after?.capabilities?.contextWindow, undefined)
  assert.equal(after?.capabilities?.parallelTools, undefined)
  evidence.modelCapabilityReplacement = {
    before: initialCapabilities, submitted: payload, after: after?.capabilities,
    outcome: 'Unrepresented capability overrides were removed; later GET may infer defaults but cannot recover the original overrides.'
  }

  async function revertOrder(name: string, order: 'oldest-first' | 'newest-first') {
    const file = path.join(fixture, `${name}.txt`)
    const first = await changes.record('default', {
      sessionId: name, path: file, kind: 'write', oldContent: 'A', newContent: 'B'
    })
    const second = await changes.record('default', {
      sessionId: name, path: file, kind: 'write', oldContent: 'B', newContent: 'C'
    })
    fs.writeFileSync(file, 'C')
    const ids = order === 'oldest-first' ? [first.id, second.id] : [second.id, first.id]
    for (const id of ids) {
      const res = await app.inject({ method: 'POST', url: `/api/v1/changes/${id}/revert`, payload: {} })
      assert.equal(res.json().code, 200)
    }
    return { order, initial: 'A', currentBeforeRevert: 'C', after: fs.readFileSync(file, 'utf8') }
  }
  const oldestFirst = await revertOrder('oldest-first', 'oldest-first')
  const newestFirst = await revertOrder('newest-first', 'newest-first')
  assert.equal(oldestFirst.after, 'B')
  assert.equal(newestFirst.after, 'A')
  evidence.revertArrivalOrder = [oldestFirst, newestFirst]

  const editedFile = path.join(fixture, 'user-edited.txt')
  const change = await changes.record('default', {
    sessionId: 'manual-edit', path: editedFile, kind: 'write', oldContent: 'A', newContent: 'B'
  })
  fs.writeFileSync(editedFile, 'USER EDIT AFTER AGENT')
  const editResponse = await app.inject({ method: 'POST', url: `/api/v1/changes/${change.id}/revert`, payload: {} })
  assert.equal(fs.readFileSync(editedFile, 'utf8'), 'A')
  evidence.revertAfterUserEdit = {
    currentBeforeRevert: 'USER EDIT AFTER AGENT', after: fs.readFileSync(editedFile, 'utf8'),
    businessCode: editResponse.json().code, conflictReported: false
  }

  for (let index = 0; index < 201; index++) {
    await changes.record('default', {
      sessionId: 'pagination', path: path.join(fixture, `unwritten-${index}.txt`),
      kind: 'write', oldContent: 'before', newContent: 'after'
    })
  }
  const listResponse = await app.inject({ method: 'GET', url: '/api/v1/changes?sessionId=pagination&status=pending' })
  assert.equal(listResponse.json().data.length, 200)
  evidence.changeListLimit = { stored: 201, returned: listResponse.json().data.length }
  fs.writeFileSync(path.join(root, 'docs/research/aether-code-data-contract-probe.json'), JSON.stringify(evidence, null, 2))
  console.log(JSON.stringify(evidence, null, 2))
} finally {
  await app.close()
  closeDb()
}
