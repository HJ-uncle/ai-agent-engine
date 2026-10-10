import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const engineRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

export function resourceRequester(base, token, observations = [], fetcher = fetch) {
  return async (route, { method = 'GET', body } = {}) => {
    const headers = { 'x-aether-instance-token': token, 'x-aether-tool-profile': 'code' }
    if (body !== undefined) headers['content-type'] = 'application/json'
    const response = await fetcher(base + '/api/v1' + route, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000) })
    const value = await response.json()
    observations.push({ at: new Date().toISOString(), route, method, httpStatus: response.status, code: value?.code })
    if (!response.ok || Number(value?.code) !== 200 || value?.success === false || value?.error) {
      const error = new Error(`${route}: HTTP ${response.status} code ${value?.code}`)
      error.httpStatus = response.status
      error.businessCode = Number(value?.code)
      throw error
    }
    return value.data
  }
}

export async function verifyKnowledgeCrud(request, knowledgeBaseId) {
  const original = { knowledgeBaseId, filename: 'crud-check.txt', content: 'temporary independently verified CRUD item' }
  const scratch = await request('/knowledge/documents', { method: 'POST', body: original })
  if (!scratch?.id) throw new Error('Knowledge CRUD create did not return a document identity')
  const route = '/knowledge/documents/' + scratch.id
  const created = await request(route)
  if (created?.filename !== original.filename || created?.content !== original.content) throw new Error('Knowledge CRUD create/read mismatch')
  const update = { filename: 'crud-check-edited.txt', content: 'updated temporary independent CRUD item' }
  await request(route, { method: 'PUT', body: update })
  const edited = await request(route)
  if (edited?.filename !== update.filename || edited?.content !== update.content) throw new Error('Knowledge CRUD update/read mismatch')
  const deleted = await request(route, { method: 'DELETE' })
  if (deleted?.deleted !== true) throw new Error('Knowledge CRUD delete did not confirm removal')
  try {
    await request(route)
  } catch (error) {
    if (error.httpStatus !== 404 && error.businessCode !== 40400) throw error
    return { documentId: scratch.id, createReadVerified: true, updateReadVerified: true, deleteReadVerified: true }
  }
  throw new Error('Knowledge CRUD delete did not remove the document')
}

export function knowledgeCrudPassed(proof) {
  return proof?.passed === true && typeof proof?.crud?.documentId === 'string' && proof.crud.documentId.length > 0 && proof.crud.createReadVerified === true && proof.crud.updateReadVerified === true && proof.crud.deleteReadVerified === true
}

async function main() {
const root = path.resolve(process.argv[2])
const state = JSON.parse(fs.readFileSync(path.join(root, 'continuation-state.json'), 'utf8'))
const base = process.env.CONTINUATION_BASE
if (!base) throw new Error('CONTINUATION_BASE required')
const observations = []
const request = resourceRequester(base, fs.readFileSync(path.join(root, '.instance-token'), 'utf8').trim(), observations)
const resourceFile = path.join(root, 'resources.json')
if (fs.existsSync(resourceFile)) {
  const existing = JSON.parse(fs.readFileSync(resourceFile, 'utf8'))
  const recheckFile = path.join(root, 'knowledge-crud-recheck.json')
  if (process.argv.includes('--verify-crud')) {
    if (!existing.knowledgeBaseIds?.[0]) throw new Error('Retained resources lack a knowledge base')
    const crud = await verifyKnowledgeCrud(request, existing.knowledgeBaseIds[0])
    fs.writeFileSync(recheckFile, JSON.stringify({ at: new Date().toISOString(), passed: true, crud, observations, resourceFile }, null, 2) + '\n')
    console.log(JSON.stringify({ resourceFile, recheckFile, knowledgeCrudPassed: true }))
    return
  }
  const recheck = fs.existsSync(recheckFile) ? JSON.parse(fs.readFileSync(recheckFile, 'utf8')) : null
  if (!knowledgeCrudPassed(existing.knowledgeApiAcceptance) && !knowledgeCrudPassed(recheck)) throw new Error('Retained resources lack verified CRUD evidence; rerun with --verify-crud')
  console.log(JSON.stringify({ resourceFile, resumed: true, knowledgeCrudPassed: true, ...(knowledgeCrudPassed(recheck) ? { recheckFile } : {}) }))
  return
}
const formats = await request('/knowledge/formats')
const kb = await request('/knowledge/bases', { method: 'POST', body: { name: `Retained continuation ${path.basename(root)}`, description: 'Original R4 compatibility and new six-hour development acceptance rules' } })
const doc = await request('/knowledge/documents', { method: 'POST', body: { knowledgeBaseId: kb.id, filename: 'continuation-acceptance.md', contentType: 'text/markdown', content: `# Retained development requirements\n\nSpec revision CONTINUATION-100K-v1.\n\nPreserve original R4 assertions and project data. Never replace mature code with stubs or alter protected tests. Ops Board keeps saved views immutable and failed form input intact. Ledger API represents currency in integer cents, rejects overselling, preserves idempotency and atomic stock reservations.\n\nNew functionality needs independently frozen contracts, real implementation changes, parent tests, two fresh child reviews and post-review parent tests. Model switching does not relax a project's contract. Archive original transcripts, exact identifiers, failed attempts, and migrations. User corrections override old decisions.\n\nProject roots: ${state.projectRoot}\n` } })
await request('/knowledge/documents/' + doc.id)
await request('/knowledge/documents/' + doc.id, { method: 'PUT', body: { content: (await request('/knowledge/documents/' + doc.id)).content + '\nFinal checkpoint: keep new feature persistence compatible with R4 retained data.\n' } })
const search = await request('/knowledge/search', { method: 'POST', body: { query: 'integer cents', knowledgeBaseIds: [kb.id], limit: 5 } })
if (!Array.isArray(search) || !search.length) throw new Error('Knowledge indexing/search did not return the actual acceptance document')
// Independent CRUD sacrificial document: original evidence document remains retained.
const crud = await verifyKnowledgeCrud(request, kb.id)
const skill = { id: 'continuation-checkpoint', name: 'Continuation Checkpoint', description: 'Retain development evidence and recover precise prior decisions after model switches or context compaction.', promptContent: `At the start of a new milestone, inspect the current contract and get the retained MCP project specification. Before changing code use exact file hashes and preserve other contributors' work. Track the task using todo tools. Run protected project tests, obtain two current read-only reviews, then rerun parent tests. Remember accepted decisions in current-session memory. When earlier values or requirements are unclear, call search_history and cite original message IDs; prefer newer user corrections. Record an idempotent MCP checkpoint containing the milestone/test evidence, and read it back. A failed review is not a pass even when its partial summary says pass. Do not claim unexecuted browser/terminal/knowledge actions.` }
const stageNode = path.join(engineRoot, '..', 'aether-code/resources/engine/win32-x64/runtime/node.exe')
const resources = {
  at: new Date().toISOString(), inlineSkills: [skill], skillIds: [skill.id],
  inlineMcpServers: [{ id: 'continuation', name: 'Retained Development Evidence', transportType: 'stdio', command: stageNode, args: [path.join(engineRoot, 'scripts/longrun/continuation-mcp-fixture.mjs'), path.join(root, 'resources')] }],
  mcpServerIds: ['continuation'], knowledgeBaseIds: [kb.id],
  requiredTools: ['read_file', 'write_file', 'edit_file', 'list_files', 'glob_search', 'grep_search', 'execute_cmd', 'command_output', 'cancel_command', 'subagent', 'get_current_context', 'search_history', 'list_skills', 'get_skill', 'todo_list', 'todo_create', 'todo_update', 'todo_delete', 'remember', 'recall', 'list_memories', 'forget', 'link_memories', 'http_request', 'web_fetch', 'codegraph', 'code_diagnose', 'browser_tabs', 'browser_snapshot', 'browser_screenshot', 'browser_console', 'browser_network', 'mcp_continuation_get_spec', 'mcp_continuation_checkpoint', 'mcp_continuation_read_checkpoint'],
  engineLogFile: path.join(root, 'engine.out.log'), historyOracleFile: path.join(root, 'history-oracle.json'),
  supportedKnowledgeFormats: formats, retainedKnowledgeDocument: doc.id,
  knowledgeApiAcceptance: { passed: true, observations, crud, searchResults: search.length, scope: 'Actual API CRUD with create/update reads and verified absence after delete, plus index lookup; later Agent RAG injection needs separate evidence' },
  semanticEmbedding: { baseUrl: 'http://127.0.0.1:12501/v1', model: 'Xenova/paraphrase-multilingual-MiniLM-L12-v2', dimensions: 384, preliminaryProof: path.join(engineRoot, '.tmp/local-embedding-runtime/semantic-preflight.json'), qualification: 'Local genuine inference passed; real engine storage/backfill/recall is a separate gate' },
}
fs.writeFileSync(resourceFile, JSON.stringify(resources, null, 2) + '\n')
console.log(JSON.stringify({ resourceFile, kbId: kb.id, documentId: doc.id, requiredTools: resources.requiredTools.length, knowledgeCrudPassed: true }))
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
