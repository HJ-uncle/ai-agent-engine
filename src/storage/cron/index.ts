import { v4 as uuidv4 } from 'uuid'
import { getDb } from '../sqlite/db.js'
import { withCronWrite } from './runs.js'
import { CronValidationError, localCronTimeZone, normalizeCronConfiguration, nextOccurrence, type CronConfigurationV2 } from '../../scheduler/cron-schedule.js'

export const DEFAULT_CRON_TIMEOUT_SECONDS = 0
export function validCronTimeoutSeconds(value: unknown): value is number | null | undefined {
  return value == null || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
}
export type CronThinkingMode = boolean | 'low' | 'medium' | 'high' | null
export function validCronThinkingMode(value: unknown): value is CronThinkingMode | undefined {
  return value === undefined || value === null || typeof value === 'boolean' || value === 'low' || value === 'medium' || value === 'high'
}
export interface CronJob {
  id: string; tenantId: string; name: string; description?: string
  cronExpr: string | null; message: string; sessionId: string | null; agentId?: string
  thinkingMode?: CronThinkingMode; timeoutSeconds?: number | null; enabled: boolean
  configuration: CronConfigurationV2; revision: number; scheduleRevision: number
  lastRunAt?: number; nextRunAt?: number; createdAt: number; updatedAt: number
}
export interface CreateCronJobInput {
  name: string; description?: string; cronExpr?: string; message: string; sessionId?: string; agentId?: string | null
  thinkingMode?: CronThinkingMode; timeoutSeconds?: number | null; enabled?: boolean; configuration?: CronConfigurationV2
}
export interface UpdateCronJobInput {
  name?: string; description?: string; cronExpr?: string; message?: string; sessionId?: string; agentId?: string | null
  thinkingMode?: CronThinkingMode; timeoutSeconds?: number | null; enabled?: boolean; configuration?: CronConfigurationV2; expectedRevision?: number
}
function requiredText(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new CronValidationError(field+' must be a non-empty string')
  return value.trim()
}
export function validateCronFields(input: CreateCronJobInput | UpdateCronJobInput): void {
  if (!validCronTimeoutSeconds(input.timeoutSeconds)) throw new CronValidationError('Invalid timeoutSeconds: expected a non-negative integer or null')
  if (!validCronThinkingMode(input.thinkingMode)) throw new CronValidationError('Invalid thinkingMode')
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') throw new CronValidationError('enabled must be boolean')
  for (const field of ['name','message','cronExpr','sessionId'] as const) if(input[field]!==undefined) requiredText(input[field],field)
  if(input.agentId!=null)requiredText(input.agentId,'agentId')
  if (input.description!==undefined && typeof input.description!=='string') throw new CronValidationError('description must be a string')
  if('expectedRevision' in input && input.expectedRevision!==undefined && (!Number.isSafeInteger(input.expectedRevision)||input.expectedRevision<1))throw new CronValidationError('expectedRevision must be a positive integer')
}
function legacyConfiguration(cronExpr: unknown, sessionId: unknown): CronConfigurationV2 {
  return normalizeCronConfiguration({version:2,schedule:{kind:'legacy',expression:requiredText(cronExpr,'cronExpr'),timeZone:localCronTimeZone()},
    target:{kind:'session',sessionId:requiredText(sessionId,'sessionId')},notificationPolicy:'all_runs',toolProfile:'general'})
}
function legacyColumns(configuration:CronConfigurationV2): {cronExpr:string|null;sessionId:string|null} {
  return {cronExpr:configuration.schedule.kind==='legacy'?configuration.schedule.expression:null,
    sessionId:configuration.target.kind==='session'?configuration.target.sessionId:null}
}
function configurationForCreate(input:CreateCronJobInput):CronConfigurationV2 {
  const configuration=input.configuration===undefined?legacyConfiguration(input.cronExpr,input.sessionId):normalizeCronConfiguration(input.configuration)
  const legacy=legacyColumns(configuration)
  if((input.cronExpr!==undefined && input.cronExpr!==legacy.cronExpr)||(input.sessionId!==undefined && input.sessionId!==legacy.sessionId))
    throw new CronValidationError('Legacy fields conflict with configuration',409,'CRON_CONFIGURATION_CONFLICT')
  return configuration
}
export function cronJobFromRow(row:Record<string,unknown>):CronJob {
  const configuration=row.configuration_json==null ? normalizeCronConfiguration({version:2,
    schedule:{kind:'legacy',expression:row.cron_expr,timeZone:localCronTimeZone()},target:{kind:'session',sessionId:row.session_id},
    notificationPolicy:'all_runs',toolProfile:'general'},{allowInvalidLegacy:true}) : normalizeCronConfiguration(JSON.parse(String(row.configuration_json)),{allowInvalidLegacy:true})
  return {id:String(row.id),tenantId:String(row.tenant_id),name:String(row.name),description:row.description==null?undefined:String(row.description),
    cronExpr:row.cron_expr==null?null:String(row.cron_expr),message:String(row.message),sessionId:row.session_id==null?null:String(row.session_id),
    agentId:row.agent_id==null?undefined:String(row.agent_id),thinkingMode:row.thinking_mode==null?undefined:JSON.parse(String(row.thinking_mode)) as CronThinkingMode,
    timeoutSeconds:row.timeout_seconds==null?null:Number(row.timeout_seconds),enabled:Boolean(row.enabled),configuration,
    revision:Number(row.revision??1),scheduleRevision:Number(row.schedule_revision??1),lastRunAt:row.last_run_at==null?undefined:Number(row.last_run_at),
    nextRunAt:row.next_run_at==null?undefined:Number(row.next_run_at),createdAt:Number(row.created_at),updatedAt:Number(row.updated_at)}
}
export class CronStore {
  private get db(){return getDb()}
  async create(tenantId:string,input:CreateCronJobInput):Promise<CronJob> {
    validateCronFields(input)
    const name=requiredText(input.name,'name'),message=requiredText(input.message,'message'),configuration=configurationForCreate(input)
    const id=uuidv4(),now=Date.now(),enabled=input.enabled!==false,legacy=legacyColumns(configuration)
    const next=enabled?nextOccurrence(configuration.schedule,now):null
    await withCronWrite(this.db,async tx=>{
      await tx.execute({sql:`INSERT INTO cron_jobs (id,tenant_id,name,description,cron_expr,message,session_id,agent_id,thinking_mode,timeout_seconds,enabled,created_at,updated_at,configuration_json,revision,schedule_revision,next_run_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,1,?)`,args:[id,tenantId,name,input.description??null,legacy.cronExpr,message,legacy.sessionId,input.agentId??null,
        input.thinkingMode==null?null:JSON.stringify(input.thinkingMode),input.timeoutSeconds??null,enabled?1:0,now,now,JSON.stringify(configuration),next]})
    })
    return (await this.getById(id,tenantId))!
  }
  async getById(id:string,tenantId:string):Promise<CronJob|null>{
    const result=await this.db.execute({sql:'SELECT * FROM cron_jobs WHERE id=? AND tenant_id=?',args:[id,tenantId]})
    return result.rows[0]?cronJobFromRow(result.rows[0]):null
  }
  async list(tenantId:string):Promise<CronJob[]>{return (await this.db.execute({sql:'SELECT * FROM cron_jobs WHERE tenant_id=? ORDER BY created_at DESC',args:[tenantId]})).rows.map(cronJobFromRow)}
  async listEnabled():Promise<CronJob[]>{return (await this.db.execute('SELECT * FROM cron_jobs WHERE enabled=1')).rows.map(cronJobFromRow)}
  async update(id:string,tenantId:string,input:UpdateCronJobInput):Promise<CronJob|null>{
    validateCronFields(input)
    if(input.expectedRevision!==undefined && (!Number.isSafeInteger(input.expectedRevision)||input.expectedRevision<1))throw new CronValidationError('expectedRevision must be a positive integer')
    return withCronWrite(this.db,async tx=>{
      const result=await tx.execute({sql:'SELECT * FROM cron_jobs WHERE id=? AND tenant_id=?',args:[id,tenantId]})
      if(!result.rows[0])return null
      const job=cronJobFromRow(result.rows[0])
      if(input.expectedRevision!==undefined && input.expectedRevision!==job.revision)throw new CronValidationError('Cron job was modified; reload before saving',409,'CRON_REVISION_CONFLICT')
      let configuration=job.configuration
      if(input.configuration!==undefined)configuration=configurationForCreate({...input,name:job.name,message:job.message,configuration:input.configuration})
      else if(input.cronExpr!==undefined || input.sessionId!==undefined){
        if(configuration.schedule.kind!=='legacy'||configuration.target.kind!=='session')throw new CronValidationError('Use version 2 configuration to edit this automation',409,'CRON_CONFIGURATION_CONFLICT')
        configuration=normalizeCronConfiguration({...configuration,schedule:{...configuration.schedule,expression:input.cronExpr??configuration.schedule.expression},
          target:{kind:'session',sessionId:input.sessionId??configuration.target.sessionId}})
      }
      const enabled=input.enabled??job.enabled,scheduleChanged=JSON.stringify(configuration.schedule)!==JSON.stringify(job.configuration.schedule),enableChanged=enabled!==job.enabled
      const next=(scheduleChanged||enableChanged)?(enabled?nextOccurrence(configuration.schedule,Date.now()):null):(job.nextRunAt??null)
      const legacy=legacyColumns(configuration),thinking=input.thinkingMode!==undefined?input.thinkingMode:job.thinkingMode
      await tx.execute({sql:`UPDATE cron_jobs SET name=?,description=?,cron_expr=?,message=?,session_id=?,agent_id=?,thinking_mode=?,timeout_seconds=?,enabled=?,updated_at=?,configuration_json=?,revision=?,schedule_revision=?,next_run_at=? WHERE id=? AND tenant_id=?`,args:[
        input.name?.trim()??job.name,input.description!==undefined?input.description:job.description??null,legacy.cronExpr,input.message?.trim()??job.message,legacy.sessionId,
        input.agentId!==undefined?input.agentId:job.agentId??null,thinking==null?null:JSON.stringify(thinking),input.timeoutSeconds!==undefined?input.timeoutSeconds:job.timeoutSeconds??null,
        enabled?1:0,Date.now(),JSON.stringify(configuration),job.revision+1,job.scheduleRevision+(scheduleChanged||enableChanged?1:0),next,id,tenantId]})
      const updated=await tx.execute({sql:'SELECT * FROM cron_jobs WHERE id=? AND tenant_id=?',args:[id,tenantId]})
      return cronJobFromRow(updated.rows[0])
    })
  }
  async updateRuntime(id:string,lastRunAt:number,nextRunAt?:number|null):Promise<void>{
    await this.db.execute({sql:'UPDATE cron_jobs SET last_run_at=?,next_run_at=?,updated_at=? WHERE id=?',args:[lastRunAt,nextRunAt??null,Date.now(),id]})
  }
  async delete(id:string,tenantId:string):Promise<boolean>{return withCronWrite(this.db,async tx=>(await tx.execute({sql:'DELETE FROM cron_jobs WHERE id=? AND tenant_id=?',args:[id,tenantId]})).rowsAffected>0)}
}
