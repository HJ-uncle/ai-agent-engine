import type { FastifyInstance } from 'fastify'
import type { Row, Transaction } from '@libsql/client'
import { issueActivationCode, listActivationCodes, revokeActivationCode } from '../../../auth/account-activation.js'
import { AccountAuthError } from '../../../auth/account-error.js'
import { fields, pageQuery } from './rbac-directory.js'
import { AdminHttpError, type AuditChange } from './rbac-storage.js'
import { accountAdminOperation } from './rbac-access.js'

const options = { bodyLimit: 2048 }
const uuid = /^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i
const parentId = (id: string) => { if (!uuid.test(id)) throw new AdminHttpError(400, '主账号标识无效。'); return id }
const quota = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 100
const parentSelect = `SELECT u.id, u.name, COALESCE(q.child_limit,3) AS child_limit,
 (SELECT count(*) FROM account_children child WHERE child.parent_id=u.id) AS used
 FROM account_activation_codes a JOIN users u ON u.id=a.used_by JOIN account_profiles p ON p.user_id=u.id LEFT JOIN account_child_quotas q ON q.parent_id=u.id
 WHERE a.used_by IS NOT NULL AND a.used_at IS NOT NULL AND u.tenant_id <> 'default' AND NOT EXISTS(SELECT 1 FROM account_children c WHERE c.child_id=u.id)`
const parentRow = (r: Row) => ({ id: String(r.id), name: String(r.name || '主账号'), limit: Number(r.child_limit), used: Number(r.used) })
async function families(db: Transaction, query: unknown) {
  const {limit,cursor,q} = pageQuery(query,'families'); const predicates: string[] = [], args: (string|number)[] = []
  if (cursor) {predicates.push('a.used_by > ?'); args.push(parentId(cursor))}
  if (q) {predicates.push('(instr(lower(u.name),lower(?)) > 0 OR u.id=?)'); args.push(q,q)}
  const rows=(await db.execute({sql: parentSelect+predicates.map(p=>' AND '+p).join('')+' ORDER BY a.used_by LIMIT ?',args:[...args,limit+1]})).rows
  return {items:rows.slice(0,limit).map(parentRow),nextCursor:rows.length>limit?String(rows[limit-1].id):null}
}
async function changeQuota(db: Transaction, id: string, input: unknown, record: (change: AuditChange) => void) {
  const body=fields(input,['limit','expectedLimit']), n=body.limit
  if (!quota(n) || !quota(body.expectedLimit)) throw new AdminHttpError(400,'额度必须为零至一百之间的整数。')
  const row=(await db.execute({sql: parentSelect+' AND a.used_by=?',args:[parentId(id)]})).rows[0]
  if (!row) throw new AdminHttpError(404,'主账号不存在。','not_found')
  const current=parentRow(row)
  if (body.expectedLimit!==current.limit) throw new AdminHttpError(409,'额度已被其他管理员修改，请刷新后重试。','quota_changed')
  if (n<current.used) throw new AdminHttpError(409,'额度不能低于已经占用的名额。','quota_in_use')
  await db.execute({sql:'INSERT INTO account_child_quotas(parent_id,child_limit) VALUES(?,?) ON CONFLICT(parent_id) DO UPDATE SET child_limit=excluded.child_limit',args:[id,n]})
  record({fields:['limit'],before:{limit:current.limit},after:{limit:n}})
  return {...current,limit:n}
}
async function activation<T>(fn: () => Promise<T>) {
  try {return await fn()} catch(error) {if(error instanceof AccountAuthError) throw new AdminHttpError(error.statusCode,error.message,'activation_invalid'); throw error}
}
export function registerFamilyAdminRoutes(app: FastifyInstance) {
  app.get('/admin/account-families',(req,reply)=>accountAdminOperation(req,reply,'accounts.read','accounts.read',null,false,tx=>families(tx,req.query)))
  app.patch<{Params:{id:string}}>('/admin/account-families/:id/quota',options,(req,reply)=>accountAdminOperation(req,reply,'accounts.quota','account.quota.update',req.params.id,true,(tx,_actor,record)=>changeQuota(tx,req.params.id,req.body,record)))
  app.get('/admin/activation-codes',(req,reply)=>accountAdminOperation(req,reply,'accounts.activation','activation.read',null,false,tx=>{
    const raw=fields(req.query ?? {},['limit','cursor']); const limit=raw.limit===undefined?20:typeof raw.limit==='string'&&/^\d{1,3}$/.test(raw.limit)?Number(raw.limit):NaN
    if (raw.cursor!==undefined&&typeof raw.cursor!=='string') throw new AdminHttpError(400,'分页参数无效。')
    return activation(()=>listActivationCodes(tx,{limit,cursor:raw.cursor as string|undefined}))
  }))
  app.post('/admin/activation-codes',options,(req,reply)=>accountAdminOperation(req,reply,'accounts.activation','activation.issue',null,true,async (tx,actor,record)=>{
    fields(req.body ?? {},[]); const issued=await activation(()=>issueActivationCode(tx,actor.id)); record({targetId:issued.id}); return issued
  }))
  app.delete<{Params:{id:string}}>('/admin/activation-codes/:id',(req,reply)=>accountAdminOperation(req,reply,'accounts.activation','activation.revoke',req.params.id,true,tx=>activation(()=>revokeActivationCode(tx,req.params.id))))
}
