import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import assert from 'node:assert/strict'
const stage = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
function fixture(t, mode) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'continuation-integrity-'))
  t.after(() => { assert.equal(path.dirname(root), os.tmpdir()); assert.match(path.basename(root), /^continuation-integrity-/); fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) })
  // The native backend can hold Windows handles until process teardown. Audit
  // in a child just like the production engine; clean only after it exits.
  const script = `import fs from 'node:fs'; import path from 'node:path'; import {createRequire} from 'node:module';
  import {continuationDatabaseAudit} from './scripts/longrun/continuation-database-audit.mjs';
  const root=process.argv[1],stage=process.argv[2],mode=process.argv[3];const Database=createRequire(path.join(stage,'package.json'))('libsql');fs.mkdirSync(path.join(root,'memory'));
  for (const relative of ['agent.db', 'knowledge.db', 'memory/memory.db']) {
    if(mode==='missing'&&relative==='knowledge.db')continue;
    const db = new Database(path.join(root, relative))
    if (relative === 'agent.db') { db.exec('CREATE TABLE root_runs(state TEXT); CREATE TABLE subagent_runs(snapshot TEXT); CREATE TABLE command_jobs(snapshot TEXT);'); db.prepare('INSERT INTO root_runs VALUES (?)').run(JSON.stringify({status:'succeeded'})); }
    else if (relative.startsWith('memory')) {
      db.exec('CREATE TABLE vectors (id INTEGER PRIMARY KEY, embedding F32_BLOB(3)); CREATE INDEX vector_ann ON vectors(libsql_vector_idx(embedding));')
      db.prepare('INSERT INTO vectors VALUES (1,vector32(?))').run('[1,2,3]')
    } else db.exec('CREATE TABLE documents(id INTEGER PRIMARY KEY, content TEXT);')
    db.close()
  }
  if(mode==='waiting'){const db=new Database(path.join(root,'agent.db'));db.prepare('INSERT INTO root_runs VALUES (?)').run(JSON.stringify({status:'waiting'}));db.close();}
  console.log(JSON.stringify(continuationDatabaseAudit(root,stage)));`
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script, root, stage, mode], { cwd: stage, encoding: 'utf8', windowsHide: true })
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout)
}
test('native frozen backend validates real ANN memory and enforces read-only checks', t => {
  const result = fixture(t, 'normal')
  assert.equal(result.passed, true, JSON.stringify(result))
  assert.equal(result.databases.every(item => item.queryOnly === 1 && item.backend === 'native-libsql'), true)
})
test('an unresolved run or unexercised database cannot pass cleanup integrity', t => {
  const result = fixture(t, 'waiting')
  assert.equal(result.passed, false)
  assert.deepEqual(result.databases[0].nonterminal, [{ table: 'root_runs', valid: 1, status: 'waiting' }])
  assert.equal(fixture(t, 'missing').databases[1].passed, false)
})
