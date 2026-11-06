// Read-only aggregate drilldown. JSON payload text is evaluated by SQLite, never emitted.
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
const root = path.resolve(process.argv[2]), out = path.resolve(process.argv[3])
const db = new DatabaseSync(path.join(root, 'agent.db'), { readOnly: true, timeout: 2500 })
const stats = { at: new Date().toISOString() }
try {
  db.exec('PRAGMA query_only=ON; BEGIN')
  stats.maintenance = db.prepare(`SELECT backend,state,json_extract(payload_json,'$.kind') kind,count(*) rows,
    sum(length(cast(payload_json AS BLOB))) payloadBytes,
    sum(length(cast(json_extract(payload_json,'$.plan.encoded') AS BLOB))) encodedBytes,
    min(committed_at) earliestCommit,max(committed_at) latestCommit,
    min(length(cast(payload_json AS BLOB))) minPayloadBytes,max(length(cast(payload_json AS BLOB))) maxPayloadBytes
    FROM collaboration_history_maintenance WHERE json_valid(payload_json) GROUP BY backend,state,kind`).all()
  stats.audit = db.prepare(`SELECT category,decision,count(*) rows,sum(length(cast(target AS BLOB))) targetBytes,
    max(length(cast(target AS BLOB))) maxTargetBytes,min(created_at) earliest,max(created_at) latest
    FROM security_audit_log GROUP BY category,decision`).all()
  stats.auditDuplicateTargets = db.prepare(`SELECT count(*) distinctTargets,sum(n-1) repeatedRows FROM
    (SELECT count(*) n FROM security_audit_log GROUP BY category,decision,target)`).get()
  stats.conversations = db.prepare('SELECT count(*) rows FROM conversations').get()
  stats.subagentRuns = db.prepare('SELECT status,count(*) rows FROM subagent_runs GROUP BY status').all()
  const children = new Set(db.prepare('SELECT child_session_id FROM subagent_runs').all().map(x => x.child_session_id))
  stats.subagentFiles = { knownChild: { files: 0, bytes: 0 }, prefixedButUnlinked: { files: 0, bytes: 0 }, other: { files: 0, bytes: 0 } }
  function scan(dir) {
    for (const e of fs.readdirSync(dir, {withFileTypes:true})) {
      const p=path.join(dir,e.name), info=fs.lstatSync(p)
      if(info.isSymbolicLink()) continue
      if(info.isDirectory()) {scan(p);continue}
      if(!info.isFile() || !e.name.endsWith('.jsonl')) continue
      const id=e.name.slice(0,-6), k=children.has(id)?'knownChild':id.startsWith('subagent-')?'prefixedButUnlinked':'other'
      stats.subagentFiles[k].files++; stats.subagentFiles[k].bytes+=info.size
    }
  }
  scan(path.join(root,'sessions'))
  db.exec('ROLLBACK')
} finally { db.close() }
fs.writeFileSync(out,JSON.stringify(stats,null,2)+'\n')
console.log(JSON.stringify(stats,null,2))
