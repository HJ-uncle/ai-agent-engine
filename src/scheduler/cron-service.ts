import { CronStore, validateCronFields, type CronJob, type CreateCronJobInput, type UpdateCronJobInput } from '../storage/cron/index.js'
import { SQLiteAgentStore } from '../storage/agent/index.js'
import { SessionStore } from '../storage/session/index.js'
import { workspaceManager } from '../workspace/manager.js'
import { isRequestAuthenticationRequired } from '../api/http/middleware.js'
import { CronValidationError, normalizeCronConfiguration, previewCronSchedule, type CronConfigurationV2 } from './cron-schedule.js'

const record=(value:unknown):value is Record<string,unknown>=>Boolean(value && typeof value==='object' && !Array.isArray(value))
const fields=new Set(['name','description','cronExpr','message','sessionId','agentId','thinkingMode','timeoutSeconds','enabled','configuration','expectedRevision'])
export interface CronCapabilities {
  version:2;executionSupported:boolean;reason?:'authenticated_dispatch_not_supported'
  schedules:Array<'interval'|'calendar'|'legacy'>;targets:Array<'session'|'standalone'|'workspace'>
  notificationPolicies:Array<'all_runs'|'silent'>;overlapPolicy:'skip';missedRunPolicy:'skip';manualRun:false;authEnabledDispatch:false
  runHistory:boolean;ownedCancellation:boolean;persistentNotifications:boolean
}
export function cronCapabilities():CronCapabilities {
  const executionSupported=!isRequestAuthenticationRequired()
  return {version:2,executionSupported,...(!executionSupported?{reason:'authenticated_dispatch_not_supported' as const}:{}),
    schedules:['interval','calendar','legacy'],targets:['session','standalone','workspace'],notificationPolicies:['all_runs','silent'],
    overlapPolicy:'skip',missedRunPolicy:'skip',manualRun:false,authEnabledDispatch:false,runHistory:true,ownedCancellation:true,persistentNotifications:true}
}
function input(value:unknown,create:boolean):CreateCronJobInput|UpdateCronJobInput{
  if(!record(value))throw new CronValidationError('Cron configuration body must be an object')
  for(const key of Object.keys(value))if(!fields.has(key)||create&&key==='expectedRevision')throw new CronValidationError('Unsupported cron field: '+key)
  if(create){for(const key of ['name','message'])if(typeof value[key]!=='string'||!String(value[key]).trim())throw new CronValidationError(key+' is required')}
  const normalized={...value,...(value.configuration!==undefined?{configuration:normalizeCronConfiguration(value.configuration)}:{})} as CreateCronJobInput|UpdateCronJobInput
  validateCronFields(normalized)
  return normalized
}
/** Both HTTP and AI tools pass through the same target and capability checks. */
export class CronService {
  constructor(private readonly store=new CronStore()){}
  private assertExecution(tenantId:string):void{
    if(isRequestAuthenticationRequired())throw new CronValidationError('Authenticated automation dispatch is not supported by this engine',409,'CRON_EXECUTION_UNSUPPORTED')
    if(tenantId!=='default')throw new CronValidationError('Local automation cannot dispatch another tenant',403,'CRON_TENANT_UNSUPPORTED')
  }
  private async validateTarget(tenantId:string,configuration:CronConfigurationV2,agentId?:string|null):Promise<void>{
    if(configuration.target.kind==='workspace'){
      try{if(!workspaceManager.getBoundDirectory({tenantId,sessionId:configuration.target.sourceSessionId}))throw new Error('Source session has no selected workspace')}
      catch(error){throw new CronValidationError(error instanceof Error?error.message:'Source workspace is unavailable',400,'CRON_WORKSPACE_UNAVAILABLE')}
    }
    if(configuration.target.kind==='session'){
      const binding=await new SessionStore().getBinding(configuration.target.sessionId,tenantId)
      if(binding && agentId!==undefined && (binding.agentId??null)!==(agentId??null))throw new CronValidationError('The target session already has a fixed Agent; keep its binding',409,'CRON_AGENT_BINDING_CONFLICT')
      if(binding?.agentId && !await new SQLiteAgentStore().getById(binding.agentId,tenantId))throw new CronValidationError('The target session Agent is unavailable',400,'CRON_AGENT_UNAVAILABLE')
    }
    if(agentId && !await new SQLiteAgentStore().getById(agentId,tenantId))throw new CronValidationError('Agent is unavailable in this tenant',400,'CRON_AGENT_UNAVAILABLE')
  }
  async create(tenantId:string,raw:unknown,defaults:{sessionId?:string}={}):Promise<CronJob>{
    const value=input(raw,true) as CreateCronJobInput
    // A paused configuration cannot dispatch. Keep its save path available when
    // execution is unsupported, matching the editor's explicit paused workflow.
    if(value.enabled!==false)this.assertExecution(tenantId)
    // The current conversation is the legacy tool default, never a fake v2 session.
    if(value.configuration===undefined && value.sessionId===undefined && defaults.sessionId)value.sessionId=defaults.sessionId
    const configuration=value.configuration??normalizeCronConfiguration({version:2,schedule:{kind:'legacy',expression:value.cronExpr,timeZone:Intl.DateTimeFormat().resolvedOptions().timeZone},
      target:{kind:'session',sessionId:value.sessionId},notificationPolicy:'all_runs',toolProfile:'general'})
    await this.validateTarget(tenantId,configuration,value.agentId)
    return this.store.create(tenantId,{...value,configuration})
  }
  async update(tenantId:string,id:string,raw:unknown):Promise<CronJob|null>{
    const value=input(raw,false) as UpdateCronJobInput
    const existing=await this.store.getById(id,tenantId)
    if(!existing)return null
    // Bind target/capability validation to the row actually read, not a caller's
    // guessed future revision that could match a later concurrent activation.
    if(value.expectedRevision!==undefined && value.expectedRevision!==existing.revision)
      throw new CronValidationError('Automation was modified; reload before saving',409,'CRON_REVISION_CONFLICT')
    // Revalidate execution only when this mutation keeps or makes the plan live.
    // A draft save must not smuggle activation through an omitted enabled field.
    const remainsEnabled=value.enabled??existing.enabled
    if(remainsEnabled && (value.configuration!==undefined || value.enabled===true || value.agentId!==undefined || value.sessionId!==undefined || value.cronExpr!==undefined))this.assertExecution(tenantId)
    let configuration=value.configuration??existing.configuration
    if(!value.configuration && (value.sessionId!==undefined||value.cronExpr!==undefined)){
      if(configuration.schedule.kind!=='legacy'||configuration.target.kind!=='session')throw new CronValidationError('Use version 2 configuration to edit this automation',409,'CRON_CONFIGURATION_CONFLICT')
      configuration=normalizeCronConfiguration({...configuration,schedule:{...configuration.schedule,expression:value.cronExpr??configuration.schedule.expression},
        target:{kind:'session',sessionId:value.sessionId??configuration.target.sessionId}})
    }
    if(value.configuration!==undefined || value.enabled===true || value.agentId!==undefined || value.sessionId!==undefined)
      await this.validateTarget(tenantId,configuration,value.agentId!==undefined?value.agentId:existing.agentId)
    // Bind the validated target to this revision; a concurrent edit must be reviewed again.
    return this.store.update(id,tenantId,{...value,expectedRevision:existing.revision})
  }
  async list(tenantId:string):Promise<CronJob[]>{return this.store.list(tenantId)}
  async get(tenantId:string,id:string):Promise<CronJob|null>{return this.store.getById(id,tenantId)}
  async delete(tenantId:string,id:string):Promise<boolean>{return this.store.delete(id,tenantId)}
  preview(raw:unknown){
    if(!record(raw)||Object.keys(raw).some(key=>!['schedule','after','count'].includes(key)))throw new CronValidationError('Invalid schedule preview body')
    return previewCronSchedule(raw.schedule as Parameters<typeof previewCronSchedule>[0],raw.after as number|undefined,raw.count as number|undefined)
  }
}
export const cronService=new CronService()
