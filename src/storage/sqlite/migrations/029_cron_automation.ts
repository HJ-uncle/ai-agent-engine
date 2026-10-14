import type { Client } from '@libsql/client'
import { localCronTimeZone, nextOccurrence, normalizeCronConfiguration } from '../../../scheduler/cron-schedule.js'
import { ensureCronRunSchema } from '../../cron/runs.js'

const quote=(value:string)=>'"'+value.replaceAll('"','""')+'"'
/** Split column definitions without touching strings, CHECK clauses or custom columns. */
function definitions(sql:string):string[]{
  const start=sql.indexOf('('),end=sql.lastIndexOf(')')
  if(start<0||end<=start)throw new Error('Cannot read existing cron table schema')
  const body=sql.slice(start+1,end),parts:string[]=[]
  let depth=0,quoted='',from=0
  for(let index=0;index<body.length;index++){
    const char=body[index]
    if(quoted){if(char===quoted){if(body[index+1]===quoted && quoted!==']')index++;else quoted=''};continue}
    if(char==='\''||char==='"'||char==='`'||char==='['){quoted=char==='['?']':char;continue}
    if(char==='(')depth++;else if(char===')')depth--;else if(char===','&&depth===0){parts.push(body.slice(from,index));from=index+1}
  }
  parts.push(body.slice(from));return parts
}
export async function up(db:Client):Promise<void>{
  const columns=(await db.execute('PRAGMA table_xinfo(cron_jobs)')).rows
  if(!columns.length)throw new Error('Cron table must exist before automation migration')
  const names=new Set(columns.map(row=>String(row.name)))
  const complete=names.has('configuration_json')&&names.has('revision')&&names.has('schedule_revision') && columns.filter(row=>row.name==='cron_expr'||row.name==='session_id').every(row=>Number(row.notnull)===0)
  {
    const tx=await db.transaction('write')
    try{
      if(!complete){
      const schema=String((await tx.execute("SELECT sql FROM sqlite_schema WHERE type='table' AND name='cron_jobs'")).rows[0]?.sql??'')
      const parts=definitions(schema).map(part=>part.replace(/^(\s*(?:cron_expr|session_id|"cron_expr"|"session_id"|`cron_expr`|`session_id`|\[cron_expr\]|\[session_id\])\s+TEXT)\s+NOT\s+NULL\b/i,'$1'))
      if(!names.has('configuration_json'))parts.push('configuration_json TEXT')
      if(!names.has('revision'))parts.push('revision INTEGER NOT NULL DEFAULT 1')
      if(!names.has('schedule_revision'))parts.push('schedule_revision INTEGER NOT NULL DEFAULT 1')
      const objects=(await tx.execute("SELECT sql FROM sqlite_schema WHERE tbl_name='cron_jobs' AND type IN ('index','trigger') AND sql IS NOT NULL")).rows.map(row=>String(row.sql))
      const table='cron_jobs_automation_v2'
      await tx.execute('CREATE TABLE '+quote(table)+' ('+parts.join(',')+')')
      const copy=columns.filter(row=>Number(row.hidden??0)===0).map(row=>quote(String(row.name))).join(',')
      await tx.execute('INSERT INTO '+quote(table)+' ('+copy+') SELECT '+copy+' FROM cron_jobs')
      await tx.execute('DROP TABLE cron_jobs')
      await tx.execute('ALTER TABLE '+quote(table)+' RENAME TO cron_jobs')
      for(const sql of objects)await tx.execute(sql)
      const migrated=(await tx.execute('PRAGMA table_info(cron_jobs)')).rows
      if(migrated.some(row=>(row.name==='cron_expr'||row.name==='session_id')&&Number(row.notnull)!==0))throw new Error('Cron nullable legacy migration did not apply')
      }
      // Freeze the host timezone once; later host changes must not move old jobs.
      const zone=localCronTimeZone(),now=Date.now()
      const legacy=(await tx.execute('SELECT id,cron_expr,session_id,enabled,next_run_at FROM cron_jobs WHERE configuration_json IS NULL')).rows
      for(const row of legacy){
        const configuration=normalizeCronConfiguration({version:2,schedule:{kind:'legacy',expression:row.cron_expr,timeZone:zone},target:{kind:'session',sessionId:row.session_id},notificationPolicy:'all_runs',toolProfile:'general'},{allowInvalidLegacy:true})
        let next:number|null=null
        if(row.enabled){try{next=nextOccurrence(configuration.schedule,now)}catch{/* Preserve invalid legacy jobs visibly; runtime reports their failure. */}}
        await tx.execute({sql:'UPDATE cron_jobs SET configuration_json=?,next_run_at=? WHERE id=?',args:[JSON.stringify(configuration),next,String(row.id)]})
      }
      await tx.commit()
    }catch(error){await tx.rollback().catch(()=>undefined);throw error}finally{tx.close()}
  }
  await ensureCronRunSchema(db)
}
