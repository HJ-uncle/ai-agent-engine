import { AccountAuthError } from './account-error.js'

export interface ChildAccount { id: string; name: string; status: 'active' | 'disabled'; createdAt: string }
export interface AccountFamily { limit: number; used: number; children: ChildAccount[] }

export function childDisplayName(value: unknown): string {
  if (typeof value !== 'string') throw new AccountAuthError(400, '请输入子账号名称。')
  const name = value.trim()
  if (!name || name.length > 80 || /[\p{Cc}\u202a-\u202e\u2066-\u2069]/u.test(value)) throw new AccountAuthError(400, '请输入 1 至 80 个字符的有效子账号名称。')
  return name
}
