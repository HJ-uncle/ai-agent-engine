import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import cookieParser from 'cookie-parser'
import rateLimit from 'express-rate-limit'
import { nanoid } from 'nanoid'
import { z } from 'zod'
import { env } from './config.js'
import { openDb, getClientById, insertAuthCode, getAuthCode, markAuthCodeUsed, pruneExpiredAuthCodes, upsertClient, listClients, disableClient } from './db.js'
import { sessionMiddleware, destroySession } from './session.js'
import { getOrCreateCsrfToken, requireCsrf } from './csrf.js'
import { createAuthAdapter } from './auth/index.js'
import { loginPage } from './ui/login.js'
import { jwks as jwksBody, loadOrCreateKeys, createJwtSigner } from './oidc/keys.js'
import { openidConfiguration } from './oidc/discovery.js'
import { codeChallengeS256 } from './oidc/pkce.js'
import { verifyAccessToken } from './oidc/verify.js'
import { audit, emailHash } from './audit.js'

function requireAdmin(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (!env.ADMIN_TOKEN) return res.status(503).json({ error: 'admin_disabled' })
  const token = req.header('x-admin-token')
  if (token !== env.ADMIN_TOKEN) return res.status(401).json({ error: 'unauthorized' })
  next()
}

function redirectWithParams(redirectUri: string, params: Record<string, string>) {
  const u = new URL(redirectUri)
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v)
  return u.toString()
}

function badRequest(res: express.Response, error: string, errorDescription?: string) {
  return res.status(400).json({ error, ...(errorDescription ? { error_description: errorDescription } : {}) })
}

function requireAuthRequest(req: express.Request, res: express.Response) {
  if (!req.session.authRequest) {
    res.status(400).send('missing_auth_request')
    return null
  }
  return req.session.authRequest
}

export async function createApp() {
  const db = openDb()
  const authAdapter = createAuthAdapter()
  const keys = await loadOrCreateKeys()
  const signJwt = await createJwtSigner(keys)

  const app = express()
  app.disable('x-powered-by')
  app.use(cookieParser())
  app.use(express.urlencoded({ extended: false }))
  app.use(express.json())
  app.use(cors({ origin: 'http://localhost:3001', credentials: true }))
  app.use(sessionMiddleware(db))

  const otpLimiter = rateLimit({ windowMs: 60_000, limit: 10, standardHeaders: true, legacyHeaders: false })
  const verifyLimiter = rateLimit({ windowMs: 60_000, limit: 20, standardHeaders: true, legacyHeaders: false })

  app.get('/health', (_req, res) => res.json({ ok: true }))

  app.get('/.well-known/openid-configuration', (_req, res) => res.json(openidConfiguration()))
  app.get('/jwks.json', (_req, res) => res.json(jwksBody(keys)))

  app.get('/authorize', (req, res) => {
    const schema = z.object({
      response_type: z.literal('code'),
      client_id: z.string().min(1),
      redirect_uri: z.string().url(),
      scope: z.string().min(1),
      state: z.string().min(1),
      code_challenge: z.string().min(10),
      code_challenge_method: z.literal('S256'),
      nonce: z.string().min(1).optional()
    })

    const parsed = schema.safeParse(req.query)
    if (!parsed.success) return badRequest(res, 'invalid_request')
    const q = parsed.data

    const client = getClientById(db, q.client_id)
    if (!client || !client.enabled) return badRequest(res, 'unauthorized_client')
    if (!client.redirectUris.includes(q.redirect_uri)) return badRequest(res, 'invalid_request', 'redirect_uri_not_allowed')
    if (!q.scope.split(/\s+/).includes('openid')) return badRequest(res, 'invalid_scope')

    req.session.authRequest = {
      clientId: q.client_id,
      redirectUri: q.redirect_uri,
      scope: q.scope,
      state: q.state,
      codeChallenge: q.code_challenge,
      codeChallengeMethod: q.code_challenge_method,
      nonce: q.nonce
    }

    const csrfToken = getOrCreateCsrfToken(req)

    if (!req.session.user) return res.status(200).type('html').send(loginPage({ csrfToken }))

    const code = nanoid(32)
    insertAuthCode(db, {
      code,
      clientId: q.client_id,
      redirectUri: q.redirect_uri,
      userId: req.session.user.sub,
      email: req.session.user.email,
      scope: q.scope,
      codeChallenge: q.code_challenge,
      codeChallengeMethod: q.code_challenge_method,
      nonce: q.nonce,
      createdAt: Date.now()
    })

    audit('authorize_code_issued', { clientId: q.client_id, email: emailHash(req.session.user.email) })
    return res.redirect(302, redirectWithParams(q.redirect_uri, { code, state: q.state }))
  })

  app.post('/otp/send', otpLimiter, async (req, res) => {
    if (!requireCsrf(req)) return res.status(403).send('csrf')
    const schema = z.object({ email: z.string().email() })
    const parsed = schema.safeParse(req.body)
    const csrfToken = getOrCreateCsrfToken(req)
    if (!parsed.success) return res.status(200).type('html').send(loginPage({ csrfToken, error: '邮箱格式不正确' }))

    const email = parsed.data.email.trim()
    const authReq = requireAuthRequest(req, res)
    if (!authReq) return

    try {
      await authAdapter.sendEmailOtp(email)
      audit('otp_sent', { email: emailHash(email), clientId: authReq.clientId })
      return res.status(200).type('html').send(loginPage({ csrfToken, email, message: '验证码已发送，请查收邮箱' }))
    } catch {
      audit('otp_send_failed', { email: emailHash(email), clientId: authReq.clientId })
      return res.status(200).type('html').send(loginPage({ csrfToken, email, error: '发送失败，请稍后再试' }))
    }
  })

  app.post('/otp/verify', verifyLimiter, async (req, res) => {
    if (!requireCsrf(req)) return res.status(403).send('csrf')
    const schema = z.object({ email: z.string().email(), token: z.string().min(1).max(32) })
    const parsed = schema.safeParse(req.body)
    const csrfToken = getOrCreateCsrfToken(req)
    if (!parsed.success) return res.status(200).type('html').send(loginPage({ csrfToken, error: '输入不正确' }))

    const email = parsed.data.email.trim()
    const token = parsed.data.token.trim()
    const authReq = requireAuthRequest(req, res)
    if (!authReq) return

    try {
      const user = await authAdapter.verifyEmailOtp(email, token)
      req.session.user = { sub: user.sub, email: user.email }

      const code = nanoid(32)
      insertAuthCode(db, {
        code,
        clientId: authReq.clientId,
        redirectUri: authReq.redirectUri,
        userId: user.sub,
        email: user.email,
        scope: authReq.scope,
        codeChallenge: authReq.codeChallenge,
        codeChallengeMethod: authReq.codeChallengeMethod,
        nonce: authReq.nonce,
        createdAt: Date.now()
      })

      audit('login_success', { email: emailHash(user.email), clientId: authReq.clientId })
      return res.redirect(302, redirectWithParams(authReq.redirectUri, { code, state: authReq.state }))
    } catch {
      audit('login_failed', { email: emailHash(email), clientId: authReq.clientId })
      return res.status(200).type('html').send(loginPage({ csrfToken, email, error: '验证码错误或已过期' }))
    }
  })

  app.post('/token', async (req, res) => {
    pruneExpiredAuthCodes(db, Date.now(), env.AUTH_CODE_TTL_SECONDS)

    const schema = z.object({
      grant_type: z.literal('authorization_code'),
      code: z.string().min(1),
      client_id: z.string().min(1),
      redirect_uri: z.string().url(),
      code_verifier: z.string().min(10)
    })

    const parsed = schema.safeParse(req.body)
    if (!parsed.success) return badRequest(res, 'invalid_request')
    const body = parsed.data

    const client = getClientById(db, body.client_id)
    if (!client || !client.enabled) return badRequest(res, 'unauthorized_client')
    if (!client.redirectUris.includes(body.redirect_uri)) return badRequest(res, 'invalid_request', 'redirect_uri_not_allowed')

    const authCode = getAuthCode(db, body.code)
    if (!authCode) return badRequest(res, 'invalid_grant')
    if (authCode.usedAt) return badRequest(res, 'invalid_grant')
    if (authCode.clientId !== body.client_id) return badRequest(res, 'invalid_grant')
    if (authCode.redirectUri !== body.redirect_uri) return badRequest(res, 'invalid_grant')
    if (Date.now() - authCode.createdAt > env.AUTH_CODE_TTL_SECONDS * 1000) return badRequest(res, 'invalid_grant')

    const derived = codeChallengeS256(body.code_verifier)
    if (derived !== authCode.codeChallenge) return badRequest(res, 'invalid_grant')

    markAuthCodeUsed(db, authCode.code, Date.now())

    const scope = authCode.scope
    const aud = body.client_id
    const sub = authCode.userId

    const idTokenClaims: Record<string, unknown> = { sub, email: authCode.email, email_verified: true }
    if (authCode.nonce) idTokenClaims.nonce = authCode.nonce

    const accessTokenClaims: Record<string, unknown> = { sub, scope, email: authCode.email }

    const [idToken, accessToken] = await Promise.all([
      signJwt(idTokenClaims, env.ID_TOKEN_TTL_SECONDS, aud),
      signJwt(accessTokenClaims, env.ACCESS_TOKEN_TTL_SECONDS, aud)
    ])

    audit('token_issued', { clientId: body.client_id, email: emailHash(authCode.email) })
    return res.json({
      token_type: 'Bearer',
      access_token: accessToken,
      id_token: idToken,
      expires_in: env.ACCESS_TOKEN_TTL_SECONDS,
      scope
    })
  })

  app.get('/userinfo', async (req, res) => {
    const auth = req.header('authorization') ?? ''
    const m = auth.match(/^Bearer (.+)$/)
    if (!m) return res.status(401).json({ error: 'invalid_token' })
    try {
      const payload = await verifyAccessToken(m[1], keys.publicJwk)
      const scope = typeof payload.scope === 'string' ? payload.scope : ''
      const scopes = new Set(scope.split(/\s+/).filter(Boolean))
      const out: Record<string, unknown> = { sub: payload.sub }
      if (scopes.has('email')) {
        out.email = payload.email
        out.email_verified = true
      }
      return res.json(out)
    } catch {
      return res.status(401).json({ error: 'invalid_token' })
    }
  })

  app.get('/logout', (req, res) => {
    destroySession(db, req.sessionId)
    res.clearCookie('sid', { path: '/' })
    res.status(200).send('ok')
  })

  app.get('/admin/clients', requireAdmin, (_req, res) => res.json(listClients(db)))

  app.post('/admin/clients', requireAdmin, (req, res) => {
    const schema = z.object({
      id: z.string().min(1),
      name: z.string().min(1),
      redirectUris: z.array(z.string().url()).min(1),
      scopes: z.array(z.string().min(1)).default(['openid', 'email']),
      enabled: z.boolean().default(true)
    })
    const parsed = schema.safeParse(req.body)
    if (!parsed.success) return badRequest(res, 'invalid_request')
    upsertClient(db, parsed.data)
    return res.status(201).json({ ok: true })
  })

  app.put('/admin/clients/:id', requireAdmin, (req, res) => {
    const schema = z.object({
      name: z.string().min(1),
      redirectUris: z.array(z.string().url()).min(1),
      scopes: z.array(z.string().min(1)).min(1),
      enabled: z.boolean()
    })
    const parsed = schema.safeParse(req.body)
    if (!parsed.success) return badRequest(res, 'invalid_request')
    upsertClient(db, { id: req.params.id, ...parsed.data })
    return res.json({ ok: true })
  })

  app.delete('/admin/clients/:id', requireAdmin, (req, res) => {
    disableClient(db, req.params.id)
    return res.json({ ok: true })
  })

  return app
}

if (process.env.VITEST !== '1') {
  const app = await createApp()
  app.listen(env.PORT, () => {
    process.stdout.write(`listening on ${env.ISSUER_URL}\n`)
  })
}
