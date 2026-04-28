import { createHash } from 'node:crypto'

export function emailHash(email: string) {
  return createHash('sha256').update(email.toLowerCase()).digest('hex').slice(0, 12)
}

export function audit(event: string, data: Record<string, unknown>) {
  const payload = { ts: new Date().toISOString(), event, ...data }
  process.stdout.write(`${JSON.stringify(payload)}\n`)
}

