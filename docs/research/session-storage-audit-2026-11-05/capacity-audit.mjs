// Read-only inventory. Never selects conversation text, tokens, secrets or IDs as output.
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const state = path.resolve(process.argv[2])
const target = path.resolve(process.argv[3])
const q = name => '"' + name.replaceAll('"', '""') + '"'
const classify = relative => {
  const p = relative.replaceAll('\\', '/')
  if (['agent.db', 'agent.db-wal', 'agent.db-shm'].includes(p)) return 'database'
  if (p.startsWith('sessions/')) return p.endsWith('.jsonl') ? 'sessions_jsonl' : p.endsWith('.bak') ? 'sessions_backup' : p.endsWith('.migrated') ? 'sessions_marker' : 'sessions_other'
  if (p.startsWith('memory/')) return 'memory'
  if (p.startsWith('change-snapshots/')) return 'snapshots'
  return 'other'
}
function inventory() {
  const groups = {}, mainFiles = [], sessionSizes = []
  let visited = 0
  const walk = (dir, depth = 0) => {
    if (depth > 24) throw new Error('Unexpected depth')
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (++visited > 50000) throw new Error('Unexpected inventory size')
      const file = path.join(dir, entry.name), info = fs.lstatSync(file)
      if (info.isSymbolicLink()) continue
      if (info.isDirectory()) { walk(file, depth + 1); continue }
      if (!info.isFile()) continue
      const rel = path.relative(state, file), group = classify(rel)
      groups[group] ??= { files: 0, bytes: 0 }
      groups[group].files++; groups[group].bytes += info.size
      if (group === 'database' || group === 'memory') mainFiles.push({ name: rel, bytes: info.size })
      if (group === 'sessions_jsonl') sessionSizes.push(info.size)
    }
  }
  walk(state)
  return { groups, mainFiles, sessionJsonlSizesDescending: sessionSizes.sort((a,b) => b-a), totalBytes: Object.values(groups).reduce((a,g) => a+g.bytes, 0) }
}

const report = { auditedAt: new Date().toISOString(), state, method: 'node:sqlite readOnly=true; PRAGMA query_only=ON; read transaction; aggregate sizes/counts only; no checkpoint/VACUUM/schema mutation', before: inventory() }
const db = new DatabaseSync(path.join(state, 'agent.db'), { readOnly: true, timeout: 2500 })
try {
  db.exec('PRAGMA query_only=ON; BEGIN')
  report.database = {}
  for (const p of ['page_size','page_count','freelist_count','journal_mode','auto_vacuum','schema_version','user_version']) report.database[p] = Object.values(db.prepare('PRAGMA ' + p).get())[0]
  const objects = db.prepare("SELECT name,tbl_name,type FROM sqlite_schema WHERE type IN ('table','index')").all()
  const objectMap = new Map(objects.map(o => [o.name, o]))
  report.database.objects = db.prepare('SELECT name,count(*) pages,sum(pgsize) allocatedBytes,sum(payload) payloadBytes,sum(unused) unusedBytes,max(mx_payload) largestCellBytes FROM dbstat GROUP BY name ORDER BY allocatedBytes DESC').all().map(o => ({ ...o, ...objectMap.get(o.name) }))
  report.database.tables = []
  for (const table of objects.filter(o => o.type === 'table')) {
    const cols = db.prepare('PRAGMA table_info(' + q(table.name) + ')').all()
    const expr = cols.map((c,i) => `coalesce(sum(length(cast(${q(c.name)} AS BLOB))),0) AS ${q('b'+i)}`).join(',')
    const sizes = db.prepare(`SELECT count(*) AS rows${expr ? ',' + expr : ''} FROM ${q(table.name)}`).get()
    const columns = cols.map((c,i) => ({ name: c.name, type: c.type, valueBytes: sizes['b'+i] }))
    report.database.tables.push({ name: table.name, rows: sizes.rows, valueBytes: columns.reduce((a,c) => a+c.valueBytes,0), columns })
  }
  report.database.tables.sort((a,b) => b.valueBytes-a.valueBytes)
  db.exec('ROLLBACK')
} finally { db.close() }
report.after = inventory()
fs.writeFileSync(target, JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify({ output: target, groups: report.after.groups, mainFiles: report.after.mainFiles, database: { ...report.database, objects: report.database.objects.slice(0,12), tables: report.database.tables.slice(0,12).map(t => ({ ...t, columns: t.columns.filter(c => c.valueBytes > 50000) })) } }, null, 2))
