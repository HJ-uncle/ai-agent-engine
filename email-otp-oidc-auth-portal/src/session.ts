import type { RequestHandler } from 'express'
import { nanoid } from 'nanoid'
import type Database from 'better-sqlite3'
import { deleteSession, getSession, pruneExpiredSessions, upsertSession } from './db.js'
import { env } from './config.js'

export type SessionData = {
  csrfToken?: string
  user?: { sub: string; email: string }
  authRequest?: {
    clientId: string
    redirectUri: string
    scope: string
    state: string
    codeChallenge: string
    codeChallengeMethod: 'S256'
    nonce?: string
  }
}

declare module 'express-serve-static-core' {
  interface Request {
    sessionId: string
    session: SessionData
  }
}

export function sessionMiddleware(db: Database.Database): RequestHandler {
  return (req, res, next) => {
    const now = Date.now()
    pruneExpiredSessions(db, now)

    const sid = typeof req.cookies?.sid === 'string' ? req.cookies.sid : undefined
    const record = sid ? getSession(db, sid) : null

    if (record && record.expiresAt > now) {
      req.sessionId = record.id
      req.session = record.data as SessionData
    } else {
      const id = nanoid(32)
      req.sessionId = id
      req.session = {}
      res.cookie('sid', id, {
        httpOnly: true,
        sameSite: 'lax',
        secure: env.ISSUER_URL.startsWith('https://'),
        path: '/'
      })
    }

    const originalEnd = res.end.bind(res)
    res.end = ((...args: unknown[]) => {
      const expiresAt = now + env.SESSION_TTL_SECONDS * 1000
      upsertSession(db, { id: req.sessionId, data: req.session, expiresAt })
      return originalEnd(...(args as [any, any]))
    }) as any

    next()
  }
}

export function destroySession(db: Database.Database, sessionId: string) {
  deleteSession(db, sessionId)
}

