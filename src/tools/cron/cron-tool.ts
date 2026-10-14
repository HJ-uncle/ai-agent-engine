import type { Tool, AgentContext, ToolResult, JSONSchema } from '../../core/agent-context/index.js'
import { cronService } from '../../scheduler/cron-service.js'
import { summarizeCronSchedule } from '../../scheduler/cron-schedule.js'
import type { CronJob } from '../../storage/cron/index.js'

const schedule:JSONSchema={oneOf:[
  {type:'object',additionalProperties:false,properties:{kind:{const:'interval'},everyMinutes:{type:'integer',minimum:1},anchorAt:{type:'integer',minimum:0}},required:['kind','everyMinutes','anchorAt']},
  {type:'object',additionalProperties:false,properties:{kind:{const:'calendar'},localTime:{type:'string',description:'HH:mm'},timeZone:{type:'string',description:'IANA time zone'},daysOfWeek:{type:'array',items:{type:'integer',minimum:0,maximum:6},minItems:1}},required:['kind','localTime','timeZone']},
  {type:'object',additionalProperties:false,properties:{kind:{const:'legacy'},expression:{type:'string'},timeZone:{type:'string'}},required:['kind','expression','timeZone']}
]}
const configuration:JSONSchema={type:'object',additionalProperties:false,properties:{version:{const:2},schedule,
  target:{oneOf:[{type:'object',additionalProperties:false,properties:{kind:{const:'session'},sessionId:{type:'string'}},required:['kind','sessionId']},
    {type:'object',additionalProperties:false,properties:{kind:{const:'standalone'}},required:['kind']},
    {type:'object',additionalProperties:false,properties:{kind:{const:'workspace'},sourceSessionId:{type:'string'}},required:['kind','sourceSessionId']}]},
  notificationPolicy:{type:'string',enum:['all_runs','silent']},toolProfile:{type:'string',enum:['general','code']}},required:['version','schedule','target','notificationPolicy','toolProfile']}
const properties:Record<string,JSONSchema>={name:{type:'string'},description:{type:'string'},message:{type:'string',description:'Task sent to the Agent at each occurrence'},
  configuration,cronExpr:{type:'string',description:'Legacy five-field rule; prefer configuration'},sessionId:{type:'string',description:'Legacy reuse target, defaults to current conversation'},
  agentId:{type:['string','null'],description:'null clears the selection for new-session targets; reuse keeps its fixed Agent'},thinkingMode:{type:['boolean','string','null'],enum:[true,false,'low','medium','high',null]},timeoutSeconds:{type:['integer','null'],minimum:0,description:'0 or null means no deadline'},enabled:{type:'boolean'}}
function object(value:unknown):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Tool arguments must be an object');return value as Record<string,unknown>}
function id(args:Record<string,unknown>):string{if(typeof args.id!=='string'||!args.id.trim())throw new Error('Exact automation id is required');return args.id}
function receipt(job:CronJob,operation:'created'|'updated'|'enabled'|'disabled'):ToolResult{
  return {success:true,output:JSON.stringify({automationReceipt:{kind:'automation',schemaVersion:2,jobId:job.id,operation},
    summary:job.name+' · '+summarizeCronSchedule(job.configuration.schedule),job:{id:job.id,name:job.name,enabled:job.enabled,nextRunAt:job.nextRunAt,configuration:job.configuration}})}
}
const safe=async(action:()=>Promise<ToolResult>):Promise<ToolResult>=>{try{return await action()}catch(error){return {success:false,output:error instanceof Error?error.message:String(error)}}}
export const cronTools:Tool[]=[
  {name:'cron_list',displayName:'列出定时任务',description:'List automations in this tenant; returns exact IDs for later changes.',parameters:{type:'object',properties:{},required:[]},
    execute:(_,ctx)=>safe(async()=>({success:true,output:JSON.stringify({jobs:await cronService.list(ctx.tenantId)})}))},
  {name:'cron_preview',displayName:'预览定时规则',description:'Preview actual upcoming UTC occurrences without saving or running a task.',
    parameters:{type:'object',additionalProperties:false,properties:{schedule,after:{type:'integer',minimum:0},count:{type:'integer',minimum:1,maximum:20}},required:['schedule']},
    execute:args=>safe(async()=>({success:true,output:JSON.stringify(cronService.preview(args))}))},
  {name:'cron_create',displayName:'创建定时任务',description:'Create an automation using interval, timezone calendar or legacy schedule. Reuse keeps the session Agent; new targets use safe defaults. Workspace targets require an explicitly selected project. Overlap and missed runs are skipped.',
    parameters:{type:'object',additionalProperties:false,properties,required:['name','message'],anyOf:[{required:['configuration']},{required:['cronExpr']}]},
    execute:(args,ctx)=>safe(async()=>receipt(await cronService.create(ctx.tenantId,args,{sessionId:ctx.sessionId}),'created'))},
  {name:'cron_update',displayName:'更新定时任务',description:'Edit or pause an automation by its exact id. Use expectedRevision to avoid overwriting another edit.',
    parameters:{type:'object',additionalProperties:false,properties:{id:{type:'string'},...properties,expectedRevision:{type:'integer',minimum:1}},required:['id']},
    execute:(raw,ctx)=>safe(async()=>{const args=object(raw),jobId=id(args),{id:_,...updates}=args;const job=await cronService.update(ctx.tenantId,jobId,updates)
      if(!job)return {success:false,output:'Automation not found; use its exact id'}
      const operation=Object.keys(updates).every(key=>key==='enabled'||key==='expectedRevision')&&typeof updates.enabled==='boolean'?(updates.enabled?'enabled':'disabled'):'updated'
      return receipt(job,operation)})},
  {name:'cron_delete',displayName:'删除定时任务',description:'Delete an automation by exact id. Its run history remains available; deleting does not cancel an already running task.',
    parameters:{type:'object',additionalProperties:false,properties:{id:{type:'string'}},required:['id']},
    execute:(raw,ctx)=>safe(async()=>{const args=object(raw);if(Object.keys(args).some(key=>key!=='id'))throw new Error('Unsupported delete field')
      return await cronService.delete(ctx.tenantId,id(args))?{success:true,output:'Automation deleted'}:{success:false,output:'Automation not found; use its exact id'}})}
]
