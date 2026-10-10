import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'

test('real five-process MCP protocol, shared CAS, idempotency, persistence, and cleanup', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aether-continuation-mcp-'))
  const script = fileURLToPath(new URL('./continuation-mcp-fixture.mjs', import.meta.url))
  const children = []
  const open = () => {
    const child = spawn(process.execPath, [script, root], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    const completion = new Promise(resolve => child.on('close', (code, signal) => resolve({ code, signal })))
    const pending = new Map(); let sequence = 0
    createInterface({ input: child.stdout }).on('line', line => {
      const result = JSON.parse(line); pending.get(result.id)?.(result); pending.delete(result.id)
    })
    const rpc = (method, params = {}) => new Promise(resolve => {
      const id = ++sequence; pending.set(id, resolve); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    })
    const handle = { child, completion, rpc }; children.push(handle); return handle
  }
  try {
    const clients = Array.from({ length: 5 }, open)
    for (const client of clients) {
      assert.equal((await client.rpc('initialize')).result.serverInfo.name, 'Retained Development Evidence')
      assert.deepEqual((await client.rpc('tools/list')).result.tools.map(tool => tool.name), ['get_spec', 'checkpoint', 'read_checkpoint'])
    }
    const attempts = await Promise.all(clients.map((client, index) => client.rpc('tools/call', { name: 'checkpoint', arguments: { key: 'shared', value: `writer-${index}`, expectedRevision: 0, idempotencyKey: `op-${index}` } })))
    const winner = attempts.findIndex(item => item.result.isError === false)
    assert.notEqual(winner, -1)
    assert.equal(attempts.filter(item => item.result.isError === false).length, 1)
    assert.equal(attempts.filter(item => JSON.parse(item.result.content[0].text).code === 'REVISION_CONFLICT').length, 4)
    const original = JSON.parse(attempts[winner].result.content[0].text)
    const replay = await clients[winner].rpc('tools/call', { name: 'checkpoint', arguments: { key: 'shared', value: `writer-${winner}`, expectedRevision: 0, idempotencyKey: `op-${winner}` } })
    assert.deepEqual(JSON.parse(replay.result.content[0].text), original)
    const conflict = await clients[0].rpc('tools/call', { name: 'checkpoint', arguments: { key: 'shared', value: 'changed', expectedRevision: 1, idempotencyKey: `op-${winner}` } })
    assert.equal(JSON.parse(conflict.result.content[0].text).code, 'IDEMPOTENCY_CONFLICT')
    for (const client of clients) { client.child.stdin.end(); assert.equal((await client.completion).code, 0) }
    const restarted = open()
    const restored = await restarted.rpc('tools/call', { name: 'read_checkpoint', arguments: { key: 'shared' } })
    assert.deepEqual(JSON.parse(restored.result.content[0].text), original)
    const invalid = await restarted.rpc('tools/call', { name: 'checkpoint', arguments: { key: '__proto__', value: 'bad', expectedRevision: 0, idempotencyKey: 'bad' } })
    assert.match(invalid.error.message, /Invalid checkpoint/)
    assert.equal(fs.existsSync(path.join(root, 'mcp-checkpoints.json.lock')), false)
  } finally {
    for (const client of children) { client.child.stdin.end(); await client.completion }
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()))
    assert.match(path.basename(root), /^aether-continuation-mcp-/)
    fs.rmSync(root, { recursive: true, force: true })
  }
}, { timeout: 30_000 })
