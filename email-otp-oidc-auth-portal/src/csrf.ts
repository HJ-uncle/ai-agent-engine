import { nanoid } from 'nanoid'
import type { Request } from 'express'

export function getOrCreateCsrfToken(req: Request) {
  if (!req.session.csrfToken) req.session.csrfToken = nanoid(24)
  return req.session.csrfToken
}

export function requireCsrf(req: Request) {
  const token = typeof req.body?.csrf_token === 'string' ? req.body.csrf_token : ''
  return token.length > 0 && token === req.session.csrfToken
}

