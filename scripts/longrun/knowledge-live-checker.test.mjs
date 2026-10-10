/** Independent assertions read only retained HTTP and genuine fixture bytes. */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
import test from 'node:test'

const directory = process.env.AETHER_KNOWLEDGE_PROOF_DIR
if (!directory) throw new Error('AETHER_KNOWLEDGE_PROOF_DIR must select retained actual evidence')
const read = file => JSON.parse(fs.readFileSync(path.join(directory, file), 'utf8'))
const context = read('exercise.json'), manifest = read('fixtures/manifest.json')
const rows = fs.readFileSync(path.join(directory, 'http.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
const byId = new Map(rows.map(row => [row.requestId, row]))
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const normalized = value => String(value).replace(/\s+/gu, '').toUpperCase()
const row = requestId => {
  assert.equal(typeof requestId, 'string', 'Actual request id is required')
  const evidence = byId.get(requestId)
  assert.ok(evidence, 'Exact original HTTP response must exist')
  assert.equal(evidence.base, context.base)
  assert.equal(evidence.buildId, context.buildId)
  assert.equal(evidence.httpStatus, 200, 'HTTP alone is not business success')
  assert.ok(Date.parse(evidence.startedAt) >= Date.parse(context.frozenAt))
  assert.ok(Date.parse(evidence.finishedAt) >= Date.parse(evidence.startedAt))
  return evidence.response
}
const success = requestId => { const response = row(requestId); assert.equal(response.code, 200, response.message); return response.data }
const absent = requestId => { assert.equal(row(requestId).code, 40400, 'Deleted resource must return the actual business 404') }
const hasDocument = (requestId, id, phrase) => {
  const results = success(requestId)
  assert.ok(Array.isArray(results))
  assert.ok(results.some(result => result.documentId === id && normalized(result.content).includes(normalized(phrase))), 'Search must return the exact document with its actual expected extracted text')
}
const noDocument = (requestId, id) => { const results = success(requestId); assert.ok(Array.isArray(results)); assert.ok(results.every(result => result.documentId !== id), 'Removed/stale document must have no remaining search hit') }

function formatBytes(fixture) {
  const bytes = fs.readFileSync(path.join(directory, 'fixtures', fixture.file)), h = bytes.subarray(0, 16).toString('hex'), ext = fixture.extension
  assert.equal(bytes.length, fixture.byteLength)
  assert.equal(hash(bytes), fixture.sha256)
  assert.equal(h, fixture.magic)
  const expected = { '.doc': 'd0cf11e0a1b11ae1', '.xls': 'd0cf11e0a1b11ae1', '.docx': '504b0304', '.xlsx': '504b0304', '.pdf': '255044462d', '.png': '89504e470d0a1a0a', '.jpg': 'ffd8ff', '.jpeg': 'ffd8ff', '.bmp': '424d' }[ext]
  if (expected) assert.ok(h.startsWith(expected), 'The actual payload must be the claimed binary format')
  else if (ext === '.gif') assert.ok(h.startsWith('474946383761') || h.startsWith('474946383961'))
  else if (ext === '.webp') { assert.equal(bytes.subarray(0, 4).toString(), 'RIFF'); assert.equal(bytes.subarray(8, 12).toString(), 'WEBP') }
  else if (ext === '.tiff') assert.ok(h.startsWith('49492a00') || h.startsWith('4d4d002a'))
  else { assert.ok(!bytes.includes(0)); assert.ok(bytes.toString('utf8').includes(fixture.expectedText), 'Text fixture syntax must contain the independent oracle') }
  if (ext === '.doc') {
    assert.equal(fixture.source.commit, 'd971d9f69056245ae129bd2ce31436d518293854')
    assert.ok(fs.readFileSync(path.join(directory, 'fixtures/word-extractor-MIT-LICENSE.txt'), 'utf8').includes('The MIT License'))
    assert.ok(fs.readFileSync(path.join(directory, 'fixtures/word-extractor-test05.snapshot.txt'), 'utf8').includes('This is a simple file created with Word 97-SR2.'))
  }
}

function extraction(fixture, operations) {
  formatBytes(fixture)
  assert.ok(operations, 'Fixture must have a recorded real multipart upload')
  const uploaded = success(operations.upload)
  assert.equal(uploaded.filename, fixture.file)
  assert.equal(uploaded.knowledgeBaseId, context.bases.primary)
  assert.equal(uploaded.contentExact, true)
  assert.ok(uploaded.chunkCount > 0)
  assert.ok(normalized(uploaded.content).includes(normalized(fixture.expectedText)), 'Actual extractor output must preserve independent fixture text')
  if (fixture.additionalText) assert.ok(normalized(uploaded.content).includes(normalized(fixture.additionalText)), 'All advertised sheets / languages must be extracted')
  const detail = success(operations.read)
  assert.equal(detail.id, uploaded.id)
  assert.equal(detail.content, uploaded.content)
  assert.equal(detail.contentExact, true)
  if (['.html', '.htm'].includes(fixture.extension)) assert.ok(!detail.content.includes('SCRIPT_MUST_NOT_BE_INDEXED'), 'HTML scripts must be removed')
  hasDocument(operations.search, uploaded.id, fixture.expectedText)
  noDocument(operations.otherBaseSearch, uploaded.id)
  return uploaded
}

if (process.env.AETHER_KNOWLEDGE_CHECK_SCOPE === 'scan') {
  test('image-only PDF advertised OCR extracts and indexes the actual pixels', () => {
    const fixture = manifest.fixtures.find(item => item.scenario === 'scan-pdf')
    assert.equal(fixture.containsTextLayer, false)
    extraction(fixture, context.documents.find(item => item.file === fixture.file)?.operations)
  })
} else {
  test('frozen candidate raw HTTP chronology and all 43 actual format registrations', () => {
    assert.equal(context.completed, true)
    assert.ok(Date.parse(context.finishedAt) >= Date.parse(context.startedAt))
    assert.ok(Date.parse(context.startedAt) >= Date.parse(context.frozenAt))
    assert.equal(rows.length, byId.size, 'HTTP ids must be unique')
    assert.equal(context.httpSha256, hash(fs.readFileSync(path.join(directory, 'http.jsonl'))))
    const formats = success(context.operations.formats)
    assert.deepEqual([...formats.extensions].sort(), [...manifest.advertisedFormats].sort())
    assert.equal(new Set(manifest.advertisedFormats).size, 43)
    assert.equal(manifest.fixtures.filter(item => item.scenario === 'advertised').length, 43)
  })
  test('knowledge base create read update list and owned deletion', () => {
    const operations = context.operations
    const created = success(operations.createPrimary)
    assert.equal(created.id, context.bases.primary)
    assert.equal(success(operations.readPrimary).name, context.names.primary)
    assert.equal(success(operations.updatePrimary).description, context.names.updatedDescription)
    assert.equal(success(operations.readUpdatedPrimary).description, context.names.updatedDescription)
    assert.ok(success(operations.listBases).some(base => base.id === created.id && base.description === context.names.updatedDescription))
    assert.equal(success(operations.deletePrimary).deleted, true)
    absent(operations.deletedPrimaryRead)
    assert.equal(success(operations.deleteOther).deleted, true)
    absent(operations.deletedOtherRead)
    assert.ok(success(operations.finalBaseList).every(base => !Object.values(context.bases).includes(base.id)))
  })
  for (const fixture of manifest.fixtures.filter(item => item.scenario === 'advertised')) test('genuine ' + fixture.extension + ' extraction, exact content, indexed CRUD and isolation', () => {
    const evidence = context.documents.find(item => item.file === fixture.file), operations = evidence?.operations
    const uploaded = extraction(fixture, operations)
    const updated = success(operations.update)
    assert.equal(updated.id, uploaded.id)
    assert.equal(updated.filename, evidence.updatedFilename)
    assert.equal(updated.content, evidence.updatedText)
    assert.equal(updated.contentExact, true)
    assert.equal(success(operations.readUpdated).content, evidence.updatedText)
    noDocument(operations.staleSearch, uploaded.id)
    hasDocument(operations.updatedSearch, uploaded.id, evidence.updatedText)
    assert.equal(success(operations.delete).deleted, true)
    absent(operations.deletedRead)
    noDocument(operations.deletedSearch, uploaded.id)
    assert.ok(success(operations.deletedList).every(document => document.id !== uploaded.id))
  })
  test('document move changes scope and deleting a base cascades its real indexed documents', () => {
    const operations = context.operations
    const document = success(operations.createCascade)
    assert.equal(success(operations.moveCascade).knowledgeBaseId, context.bases.other)
    noDocument(operations.cascadeOldScope, document.id)
    hasDocument(operations.cascadeNewScope, document.id, context.names.cascadeText)
    absent(operations.cascadeDeletedRead)
    noDocument(operations.cascadeDeletedSearch, document.id)
    assert.ok(success(operations.cascadeFinalDocuments).every(item => item.id !== document.id))
  })
}
