import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { AccountAuthError } from './account-error.js'

const N = 2 ** 15, r = 8, p = 3, bytes = 32
const format = /^scrypt-v1:([a-f0-9]{32}):([a-f0-9]{64})$/
const missing = 'scrypt-v1:' + '0'.repeat(32) + ':' + '0'.repeat(64)
let pending = 0

export function childLoginName(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{2,47}$/.test(value.trim())) {
    throw new AccountAuthError(400, '登录名需为 3–48 位，以字母或数字开头，可包含点、下划线和短横线。')
  }
  return value.trim().toLowerCase()
}

function passwordInput(value: unknown, creating: boolean): string {
  if (typeof value !== 'string' || value.length > 512) throw new AccountAuthError(400, '请输入有效密码。')
  const normalized = value.normalize('NFC'), count = Array.from(normalized).length
  if (count > 128 || (creating && count < 15)) throw new AccountAuthError(400, '新密码需为 15–128 个字符，可以使用空格。')
  return normalized
}

async function derive(password: string, salt: Buffer): Promise<Buffer> {
  // Bound native memory use independently of the number of HTTP clients or libuv workers.
  if (pending >= 2) throw new AccountAuthError(429, '密码服务正忙，请稍后再试。')
  pending++
  try { return await new Promise<Buffer>((resolve, reject) => scrypt(password, salt, bytes, { N, r, p, maxmem: 64 * 1024 * 1024 }, (err, key) => err ? reject(err) : resolve(key))) }
  finally { pending-- }
}

export async function newChildPassword(value: unknown): Promise<string> {
  const password = passwordInput(value, true), salt = randomBytes(16)
  return ['scrypt-v1', salt.toString('hex'), (await derive(password, salt)).toString('hex')].join(':')
}

export async function matchesChildPassword(value: unknown, stored?: string): Promise<boolean> {
  const password = passwordInput(value, false), valid = typeof stored === 'string' ? format.exec(stored) : null
  // Absent and disabled accounts cost the same password work as a wrong password.
  const [, salt, key] = valid ?? format.exec(missing)!
  const matched = timingSafeEqual(await derive(password, Buffer.from(salt, 'hex')), Buffer.from(key, 'hex'))
  return valid !== null && matched
}
