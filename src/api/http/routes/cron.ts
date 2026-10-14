import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { AuthContext } from '../../../auth/types.js'
import { CronValidationError } from '../../../scheduler/cron-schedule.js'
import { cronService, cronCapabilities } from '../../../scheduler/cron-service.js'
import { cancelCronRun } from '../../../scheduler/cron-dispatch.js'
import { CronRunStore } from '../../../storage/cron/runs.js'
import { isRequestAuthenticationRequired } from '../middleware.js'
import { success, fail, paginateArray } from '../response.js'

const runs=new CronRunStore()
function tenant(request:FastifyRequest):string{
  const context=(request as FastifyRequest&{authContext?:AuthContext}).authContext
  if(context?.tenantId)return context.tenantId
  if(isRequestAuthenticationRequired())throw new CronValidationError('Authentication required',401,'CRON_AUTHENTICATION_REQUIRED')
  return 'default'
}
function limit(value:unknown):number|undefined{
  if(value===undefined)return undefined
  if(typeof value!=='string' || !/^[1-9]\d*$/.test(value) || Number(value)>100)throw new CronValidationError('limit must be from 1 to 100')
  return Number(value)
}
function cursor(value:unknown):string|undefined{
  if(value===undefined)return undefined
  if(typeof value!=='string'||!value||value.length>1024)throw new CronValidationError('Invalid cursor')
  return value
}
function errorResponse(error:unknown){
  if(error instanceof RangeError)return fail(40001,error.message)
  if(error instanceof CronValidationError)return fail(error.statusCode===400?40001:error.statusCode===409?40900:error.statusCode===403?40300:40100,error.message)
  if(error instanceof Error && 'statusCode' in error && Number(error.statusCode)<500)return fail(Number(error.statusCode)*100,error.message)
  throw error
}
const protect=<T>(action:()=>Promise<T>)=>action().catch(error=>errorResponse(error))
export async function cronRoutes(fastify:FastifyInstance){
  fastify.get('/cron/capabilities',async()=>success(cronCapabilities()))
  fastify.post<{Body:unknown}>('/cron/preview',async request=>{
    try{return success(cronService.preview(request.body))}catch(error){return errorResponse(error)}
  })
  fastify.get<{Querystring:{current?:number;pageSize?:number}}>('/cron',async request=>protect(async()=>paginateArray(await cronService.list(tenant(request)),request.query.current,request.query.pageSize)))
  fastify.post<{Body:unknown}>('/cron',async request=>protect(async()=>success(await cronService.create(tenant(request),request.body))))
  fastify.get<{Querystring:{cursor?:string;limit?:string;unreadOnly?:string}}>('/cron/notifications',async request=>protect(async()=>{
    const unread=request.query.unreadOnly
    if(unread!==undefined && unread!=='true'&&unread!=='false')throw new CronValidationError('unreadOnly must be true or false')
    return success(await runs.listNotifications(tenant(request),{cursor:cursor(request.query.cursor),limit:limit(request.query.limit),unreadOnly:unread==='true'}))
  }))
  fastify.post<{Params:{id:string}}>('/cron/notifications/:id/read',async request=>protect(async()=>{
    const notification=await runs.readNotification(tenant(request),request.params.id)
    return notification?success(notification):fail(40400,'Notification not found')
  }))
  fastify.get<{Params:{runId:string}}>('/cron/runs/:runId',async request=>protect(async()=>{
    const run=await runs.get(tenant(request),request.params.runId)
    return run?success(run):fail(40400,'Automation run not found')
  }))
  fastify.post<{Params:{runId:string}}>('/cron/runs/:runId/cancel',async request=>protect(async()=>{
    const run=await cancelCronRun(tenant(request),request.params.runId)
    return run?success(run):fail(40400,'Automation run not found')
  }))
  fastify.get<{Params:{id:string};Querystring:{cursor?:string;limit?:string}}>('/cron/:id/runs',async request=>protect(async()=>success(await runs.listByJob(tenant(request),request.params.id,{cursor:cursor(request.query.cursor),limit:limit(request.query.limit)}))))
  fastify.get<{Params:{id:string}}>('/cron/:id',async request=>protect(async()=>{
    const job=await cronService.get(tenant(request),request.params.id)
    return job?success(job):fail(40400,'Cron job not found')
  }))
  fastify.put<{Params:{id:string};Body:unknown}>('/cron/:id',async request=>protect(async()=>{
    const job=await cronService.update(tenant(request),request.params.id,request.body)
    return job?success(job):fail(40400,'Cron job not found')
  }))
  fastify.delete<{Params:{id:string}}>('/cron/:id',async request=>protect(async()=>await cronService.delete(tenant(request),request.params.id)?success({deleted:true}):fail(40400,'Cron job not found')))
  for(const enabled of [true,false])fastify.post<{Params:{id:string}}>('/cron/:id/'+(enabled?'enable':'disable'),async request=>protect(async()=>{
    const job=await cronService.update(tenant(request),request.params.id,{enabled})
    return job?success(job):fail(40400,'Cron job not found')
  }))
}
