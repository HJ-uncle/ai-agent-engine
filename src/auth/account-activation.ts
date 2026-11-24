import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { Transaction } from '@libsql/client'
import { AccountAuthError } from './account-error.js'

const lifetime = 7 * 24 * 60 * 60 * 1000
const format = /^aether_activate_[A-Za-z0-9_-]{43}$/
const uuid = /^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i
const digest = (code: string) => createHash('sha256').update(code).digest('hex')
export interface ActivationProof { readonly digest: string }
export function activationProof(code: unknown): ActivationProof | undefined {
  if (code === undefined || code === null || code === '') return undefined
  if (typeof code !== 'string' || !format.test(code)) throw new AccountAuthError(400, '主账号开通码格式不正确，请使用管理员签发的完整开通码。')
  return { digest: digest(code) }
}
export async function consumeActivation(db: Transaction, proof: ActivationProof | undefined, userId: string): Promise<void> {
  if (!proof) throw new AccountAuthError(403, '创建主账号需要后台签发的开通码。已有账号请使用原登录方式。')
  const now = Date.now()
  const consumed = await db.execute({ sql: `UPDATE account_activation_codes SET used_by=?,used_at=?
    WHERE code_hash=? AND used_at IS NULL AND revoked_at IS NULL AND expires_at>?`, args: [userId, now, proof.digest, now] })
  if (consumed.rowsAffected !== 1) throw new AccountAuthError(403, '开通码无效或已失效，请联系管理员领取新的开通码。')
}
export async function issueActivationCode(db: Transaction, actorId: string) {
  const id=randomUUID(), code='aether_activate_'+randomBytes(32).toString('base64url'), now=Date.now(), expires=now+lifetime
  await db.execute({sql:'INSERT INTO account_activation_codes(id,code_hash,issued_by,created_at,expires_at) VALUES(?,?,?,?,?)',args:[id,digest(code),actorId,now,expires]})
  return { id, code, createdAt: new Date(now).toISOString(), expiresAt: new Date(expires).toISOString() }
}
export async function revokeActivationCode(db: Transaction, id: string): Promise<{ revoked: true }> {
  if (!uuid.test(id)) throw new AccountAuthError(400, '开通码标识无效。')
  const now=Date.now()
  const result=await db.execute({sql:'UPDATE account_activation_codes SET revoked_at=? WHERE id=? AND used_at IS NULL AND revoked_at IS NULL AND expires_at>?',args:[now,id,now]})
  if (!result.rowsAffected) throw new AccountAuthError(409, '只能撤销尚未使用且有效的开通码，请刷新列表。')
  return {revoked:true}
}
export async function listActivationCodes(db: Pick<Transaction, 'execute'>, {limit,cursor}: {limit:number;cursor?:string|null}) {
  if (!Number.isInteger(limit) || limit<1 || limit>100) throw new AccountAuthError(400,'分页大小须在 1 到 100 之间。')
  const parts = cursor?.match(/^(\d{1,15})\/([a-f\d-]{36})$/i)
  if (cursor && (!parts || !uuid.test(parts[2]))) throw new AccountAuthError(400,'分页位置无效。')
  const page=await db.execute({sql:`SELECT id,created_at,expires_at,used_at,revoked_at FROM account_activation_codes
    ${parts?'WHERE (created_at,id)<(?,?)':''} ORDER BY created_at DESC,id DESC LIMIT ?`,args:parts?[Number(parts[1]),parts[2],limit+1]:[limit+1]})
  const rows=page.rows.slice(0,limit), last=rows.at(-1), now=Date.now()
  return {items:rows.map(row=>({id:String(row.id),createdAt:new Date(Number(row.created_at)).toISOString(),expiresAt:new Date(Number(row.expires_at)).toISOString(),
    status:row.used_at!==null?'used':row.revoked_at!==null?'revoked':Number(row.expires_at)<=now?'expired':'available'})),nextCursor:page.rows.length>limit&&last?`${last.created_at}/${last.id}`:null}
}
