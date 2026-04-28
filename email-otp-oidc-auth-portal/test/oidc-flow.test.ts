import { describe, expect, it, beforeAll } from 'vitest'
import request from 'supertest'
import { createHash, randomBytes } from 'node:crypto'

process.env.VITEST = '1'
process.env.AUTH_PROVIDER = 'fake'
process.env.ADMIN_TOKEN = 'test-admin-token-123456'
process.env.ISSUER_URL = 'http://localhost:3000'
process.env.DATA_DIR = './data-test'

function base64Url(buf: Buffer) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function pkce() {
  const verifier = base64Url(randomBytes(32))
  const challenge = base64Url(createHash('sha256').update(verifier).digest())
  return { verifier, challenge }
}

function extractCsrf(html: string) {
  const m = html.match(/name="csrf_token" value="([^"]+)"/)
  if (!m) throw new Error('csrf token not found')
  return m[1]
}

describe('oidc email otp flow', () => {
  let app: any

  beforeAll(async () => {
    const mod = await import('../src/server.js')
    app = await mod.createApp()
  })

  it('rejects redirect_uri not in whitelist', async () => {
    await request(app)
      .post('/admin/clients')
      .set('x-admin-token', process.env.ADMIN_TOKEN!)
      .send({
        id: 'client-a',
        name: 'Client A',
        redirectUris: ['http://localhost:4000/callback'],
        scopes: ['openid', 'email'],
        enabled: true
      })
      .expect(201)

    await request(app)
      .get('/authorize')
      .query({
        response_type: 'code',
        client_id: 'client-a',
        redirect_uri: 'http://evil.test/callback',
        scope: 'openid email',
        state: 's1',
        code_challenge: pkce().challenge,
        code_challenge_method: 'S256'
      })
      .expect(400)
  })

  it('serves discovery and jwks', async () => {
    const discovery = await request(app).get('/.well-known/openid-configuration').expect(200)
    expect(discovery.body.issuer).toBe('http://localhost:3000')
    expect(discovery.body.authorization_endpoint).toBe('http://localhost:3000/authorize')

    const jwks = await request(app).get('/jwks.json').expect(200)
    expect(Array.isArray(jwks.body.keys)).toBe(true)
    expect(jwks.body.keys.length).toBeGreaterThan(0)
  })

  it('completes authorize -> otp -> token -> userinfo', async () => {
    const agent = request.agent(app)
    const { verifier, challenge } = pkce()

    const authRes = await agent
      .get('/authorize')
      .query({
        response_type: 'code',
        client_id: 'client-a',
        redirect_uri: 'http://localhost:4000/callback',
        scope: 'openid email',
        state: 's2',
        code_challenge: challenge,
        code_challenge_method: 'S256'
      })
      .expect(200)

    const csrf = extractCsrf(authRes.text)

    await agent
      .post('/otp/send')
      .type('form')
      .send({ csrf_token: csrf, email: 'u@example.com' })
      .expect(200)

    const verifyRes = await agent
      .post('/otp/verify')
      .type('form')
      .send({ csrf_token: csrf, email: 'u@example.com', token: '000000' })
      .expect(302)

    const loc = verifyRes.headers.location as string
    expect(loc).toMatch(/^http:\/\/localhost:4000\/callback\?/)
    const url = new URL(loc)
    const code = url.searchParams.get('code')
    const state = url.searchParams.get('state')
    expect(state).toBe('s2')
    expect(code).toBeTruthy()

    const tokenRes = await agent
      .post('/token')
      .type('form')
      .send({
        grant_type: 'authorization_code',
        code,
        client_id: 'client-a',
        redirect_uri: 'http://localhost:4000/callback',
        code_verifier: verifier
      })
      .expect(200)

    expect(tokenRes.body.access_token).toBeTypeOf('string')
    expect(tokenRes.body.id_token).toBeTypeOf('string')

    const userinfoRes = await agent
      .get('/userinfo')
      .set('authorization', `Bearer ${tokenRes.body.access_token}`)
      .expect(200)

    expect(userinfoRes.body.sub).toBeTruthy()
    expect(userinfoRes.body.email).toBe('u@example.com')
    expect(userinfoRes.body.email_verified).toBe(true)
  })

  it('fails token exchange when PKCE verifier mismatch', async () => {
    const agent = request.agent(app)
    const { verifier, challenge } = pkce()

    const authRes = await agent
      .get('/authorize')
      .query({
        response_type: 'code',
        client_id: 'client-a',
        redirect_uri: 'http://localhost:4000/callback',
        scope: 'openid email',
        state: 's3',
        code_challenge: challenge,
        code_challenge_method: 'S256'
      })
      .expect(200)

    const csrf = extractCsrf(authRes.text)

    await agent
      .post('/otp/send')
      .type('form')
      .send({ csrf_token: csrf, email: 'u2@example.com' })
      .expect(200)

    const verifyRes = await agent
      .post('/otp/verify')
      .type('form')
      .send({ csrf_token: csrf, email: 'u2@example.com', token: '000000' })
      .expect(302)

    const code = new URL(verifyRes.headers.location as string).searchParams.get('code')

    await agent
      .post('/token')
      .type('form')
      .send({
        grant_type: 'authorization_code',
        code,
        client_id: 'client-a',
        redirect_uri: 'http://localhost:4000/callback',
        code_verifier: verifier + 'x'
      })
      .expect(400)
  })
})
