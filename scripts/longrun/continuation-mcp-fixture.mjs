import fs from 'node:fs'
import path from 'node:path'
import { createInterface } from 'node:readline'

const root = path.resolve(process.argv[2])
const stateFile = path.join(root, 'mcp-checkpoints.json')
const auditFile = path.join(root, 'mcp-actions.jsonl')
fs.mkdirSync(root, { recursive: true })
const tools = [
  { name: 'get_spec', description: 'Read retained development acceptance rules for Ops Board and Ledger API', inputSchema: { type: 'object', properties: { projectId: { type: 'string', enum: ['ops-board', 'ledger-api'] } }, required: ['projectId'], additionalProperties: false } },
  { name: 'checkpoint', description: 'Persist an idempotent checkpoint with optimistic revision. Read current revision before replacing.', inputSchema: { type: 'object', properties: { key: { type: 'string' }, value: { type: 'string' }, expectedRevision: { type: 'integer', minimum: 0 }, idempotencyKey: { type: 'string' } }, required: ['key', 'value', 'expectedRevision', 'idempotencyKey'], additionalProperties: false } },
  { name: 'read_checkpoint', description: 'Read durable checkpoint revision and committed content', inputSchema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'], additionalProperties: false } },
]
const read = () => fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : { records: {}, replay: {} }
for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  let request
  try {
    request = JSON.parse(line)
    if (request.id === undefined) continue
    let result
    if (request.method === 'initialize') result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'Retained Development Evidence', version: '1.0.0' } }
    else if (request.method === 'tools/list') result = { tools }
    else if (request.method === 'ping') result = {}
    else if (request.method === 'tools/call') {
      const { name, arguments: args = {} } = request.params
      let value, isError = false
      if (name === 'get_spec') {
        if (!['ops-board', 'ledger-api'].includes(args.projectId)) throw new Error('Invalid project')
        value = { revision: 'CONTINUATION-100K-v1', projectId: args.projectId, rules: ['Preserve every existing R4 assertion and durable project data.', 'New features need independent contracts, parent tests, child review, and post-review tests.', 'Use integer cents and atomic inventory transactions in Ledger API.', 'Keep saved views immutable; reject stale CAS revisions and preserve failed form input in Ops Board.'] }
      } else if (name === 'read_checkpoint') {
        if (typeof args.key !== 'string' || !args.key || ['__proto__', 'constructor', 'prototype'].includes(args.key)) throw new Error('Invalid checkpoint key')
        const state = read(); value = Object.hasOwn(state.records, args.key) ? state.records[args.key] : { revision: 0, value: null }
      }
      else if (name === 'checkpoint') {
        if (typeof args.key !== 'string' || !args.key || ['__proto__', 'constructor', 'prototype'].includes(args.key) || typeof args.value !== 'string' || !Number.isSafeInteger(args.expectedRevision) || args.expectedRevision < 0 || typeof args.idempotencyKey !== 'string' || !args.idempotencyKey) throw new Error('Invalid checkpoint arguments')
        // Lock serializes separate stdio processes, not just requests in one process.
        let fd
        for (let attempt = 0; attempt < 200; attempt++) {
          try { fd = fs.openSync(stateFile + '.lock', 'wx'); break } catch (error) { if (error.code !== 'EEXIST') throw error; await new Promise(resolve => setTimeout(resolve, 10)) }
        }
        if (fd === undefined) throw new Error('Checkpoint lock timeout')
        try {
          const state = read(), identity = JSON.stringify([args.key, args.idempotencyKey]), replay = state.replay[identity]
          const current = state.records[args.key] ?? { revision: 0, value: null }
          if (replay) {
            if (replay.value !== args.value) { value = { code: 'IDEMPOTENCY_CONFLICT' }; isError = true } else value = replay
          } else if (current.revision !== args.expectedRevision) { value = { code: 'REVISION_CONFLICT', actualRevision: current.revision }; isError = true }
          else {
            value = { revision: current.revision + 1, value: args.value }
            state.records[args.key] = value; state.replay[identity] = value
            const temporary = stateFile + `.${process.pid}.tmp`
            fs.writeFileSync(temporary, JSON.stringify(state)); fs.renameSync(temporary, stateFile)
          }
        } finally { fs.closeSync(fd); fs.unlinkSync(stateFile + '.lock') }
      } else throw new Error('Unknown tool')
      fs.appendFileSync(auditFile, JSON.stringify({ at: new Date().toISOString(), pid: process.pid, name, args, result: value, isError }) + '\n')
      result = { content: [{ type: 'text', text: JSON.stringify(value) }], isError }
    } else throw new Error('Unsupported method')
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n')
  } catch (error) {
    if (request?.id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32602, message: error.message } }) + '\n')
  }
}
