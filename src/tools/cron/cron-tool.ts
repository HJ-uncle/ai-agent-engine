import { randomUUID } from 'node:crypto'
import type { Tool, ToolResult, JSONSchema } from '../../core/agent-context/index.js'
import { cronService, cronCapabilities } from '../../scheduler/cron-service.js'
import { summarizeCronSchedule } from '../../scheduler/cron-schedule.js'
import type { CronJob, CreateCronJobInput, UpdateCronJobInput } from '../../storage/cron/index.js'
import { createApprovedMutationTool } from '../management/approved-mutation.js'

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
  return {success:true,status:'succeeded',metadata:{resourceChange:{kind:'automation',action:operation==='created'?'create':'update',id:job.id}},output:JSON.stringify({automationReceipt:{kind:'automation',schemaVersion:2,jobId:job.id,operation},
    summary:job.name+' · '+summarizeCronSchedule(job.configuration.schedule),job:{id:job.id,name:job.name,enabled:job.enabled,nextRunAt:job.nextRunAt,configuration:job.configuration}})}
}
const safe=async(action:()=>Promise<ToolResult>):Promise<ToolResult>=>{try{return await action()}catch(error){return {success:false,output:error instanceof Error?error.message:String(error)}}}
export const cronTools:Tool[]=[
  {name:'cron_capabilities',displayName:'自动化运行能力',description:'Check supported schedules, targets and background execution before creating an automation. If executionSupported=false, only explicitly paused plans (enabled:false) can be saved; never claim they will run. No manual-run capability.',
    parameters:{type:'object',additionalProperties:false,properties:{},required:[]},execute:async(_,ctx)=>{
      const capabilities=cronCapabilities()
      return {success:true,output:JSON.stringify({...capabilities,...(ctx.tenantId!=='default'?{executionSupported:false,reason:'tenant_dispatch_not_supported'}:{})})}
    }},
  {name:'cron_list',displayName:'列出定时任务',description:'List automations in this tenant; returns exact IDs for later changes.',parameters:{type:'object',properties:{},required:[]},
    execute:(_,ctx)=>safe(async()=>({success:true,output:JSON.stringify({jobs:await cronService.list(ctx.tenantId)})}))},
  {name:'cron_preview',displayName:'预览定时规则',description:'Preview actual upcoming UTC occurrences without saving or running a task.',
    parameters:{type:'object',additionalProperties:false,properties:{schedule,after:{type:'integer',minimum:0},count:{type:'integer',minimum:1,maximum:20}},required:['schedule']},
    execute:args=>safe(async()=>({success:true,output:JSON.stringify(cronService.preview(args))}))},
  createApprovedMutationTool<{version:1;tenantId:string;id:string;input:CreateCronJobInput}>({name:'cron_create',displayName:'创建定时任务',description:'先查看 cron_capabilities。创建定时任务；支持间隔、带时区日历规则和旧 cron。工作区目标要求已选项目；重复和错过的运行跳过。',
    parameters:{type:'object',additionalProperties:false,properties,required:['name','message'],anyOf:[{required:['configuration']},{required:['cronExpr']}]},
    prepare:async(raw,ctx)=>({version:1,tenantId:ctx.tenantId,id:randomUUID(),input:await cronService.prepareCreate(ctx.tenantId,raw,{sessionId:ctx.sessionId})}),
    preview:operation=>operation.input,
    apply:async(operation,ctx)=>receipt(await cronService.create(ctx.tenantId,operation.input,{},operation.id,ctx.signal),'created')}),
  createApprovedMutationTool<{version:1;tenantId:string;id:string;before:CronJob;input:UpdateCronJobInput}>({name:'cron_update',displayName:'更新定时任务',description:'通过完整 ID 修改、暂停或启用定时任务，审批后按原版本检查并发冲突。',
    parameters:{type:'object',additionalProperties:false,properties:{id:{type:'string'},...properties,expectedRevision:{type:'integer',minimum:1}},required:['id']},
    prepare:async(raw,ctx)=>{
      const args=object(raw),jobId=id(args),{id:_,...updates}=args
      if(!Object.keys(updates).some(key=>key!=='expectedRevision'))throw new Error('至少提供一个更新字段')
      const before=await cronService.get(ctx.tenantId,jobId)
      if(!before)throw new Error('Automation not found; use its exact id')
      const input=await cronService.prepareUpdate(ctx.tenantId,jobId,{...updates,expectedRevision:updates.expectedRevision??before.revision})
      if(!input)throw new Error('Automation no longer exists')
      return {version:1,tenantId:ctx.tenantId,id:jobId,before,input}
    },
    preview:operation=>({before:operation.before,changes:operation.input}),
    apply:async(operation,ctx)=>{
      const job=await cronService.update(ctx.tenantId,operation.id,operation.input,ctx.signal)
      if(!job)throw new Error('Automation no longer exists')
      const updates=operation.input
      const change=Object.keys(updates).every(key=>key==='enabled'||key==='expectedRevision')&&typeof updates.enabled==='boolean'?(updates.enabled?'enabled':'disabled'):'updated'
      return receipt(job,change)
    }}),
  createApprovedMutationTool<{version:1;tenantId:string;id:string;before:CronJob}>({name:'cron_delete',displayName:'删除定时任务',description:'删除指定定时任务并保留运行历史；不会停止已经开始的运行。',
    parameters:{type:'object',additionalProperties:false,properties:{id:{type:'string'}},required:['id']},
    prepare:async(raw,ctx)=>{
      const args=object(raw);if(Object.keys(args).some(key=>key!=='id'))throw new Error('Unsupported delete field')
      const before=await cronService.get(ctx.tenantId,id(args))
      if(!before)throw new Error('Automation not found; use its exact id')
      return {version:1,tenantId:ctx.tenantId,id:before.id,before}
    },
    preview:operation=>operation.before,
    apply:async(operation,ctx)=>{
      if(!await cronService.delete(ctx.tenantId,operation.id,operation.before.revision,ctx.signal))throw new Error('Automation no longer exists')
      return {success:true,status:'succeeded',output:'Automation deleted',metadata:{resourceChange:{kind:'automation',action:'delete',id:operation.id}}}
    }})
]
