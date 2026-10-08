// Real HTTP issuer, signed ID tokens and credential verification; no token-verification mocks.
import { createServer, type Server } from 'node:http'
import { createHash } from 'node:crypto'
import { generateKeyPair, exportJWK, SignJWT, type KeyLike } from 'jose'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { AccountProviderRegistry, sanitizeExternalUserData, type BrowserAuthorization } from '../account-providers.js'

let server: Server, issuer: string, privateKey: KeyLike, publicJwk: object
let nonce = '', mode = '', expectedChallenge = '', credentialCalls = 0, stolenCalls = 0
let lastCredential: unknown, lastCodeVerifier = ''
beforeAll(async () => {
  const pair = await generateKeyPair('RS256')
  privateKey = pair.privateKey
  publicJwk = { ...await exportJWK(pair.publicKey), kid: 'fixture', alg: 'RS256', use: 'sig' }
  server = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json')
    if (req.url === '/.well-known/openid-configuration') {
      res.end(JSON.stringify({ issuer: mode === 'discovery-issuer' ? `${issuer}/wrong` : issuer,
        authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`,
        userinfo_endpoint: `${issuer}/userinfo`, jwks_uri: `${issuer}/jwks` })); return
    }
    if (req.url === '/jwks') { res.end(JSON.stringify({ keys: [publicJwk] })); return }
    if (req.url === '/token') {
      let body = ''; for await (const chunk of req) body += String(chunk)
      const form = new URLSearchParams(body)
      lastCodeVerifier = form.get('code_verifier') ?? ''
      if (createHash('sha256').update(lastCodeVerifier).digest('base64url') !== expectedChallenge || form.get('code') !== 'valid-code') {
        res.statusCode = 401; res.end('{"error":"invalid_grant"}'); return
      }
      const key = mode === 'signature' ? (await generateKeyPair('RS256')).privateKey : privateKey
      const token = await new SignJWT({ nonce: mode === 'nonce' ? 'attacker-nonce' : nonce })
        .setProtectedHeader({ alg: 'RS256', kid: 'fixture' }).setSubject('immutable-user-42')
        .setIssuer(mode === 'issuer' ? 'https://attacker.example' : issuer)
        .setAudience(mode === 'audience' ? 'another-client' : 'aether-desktop').setIssuedAt()
        .setExpirationTime(mode === 'expired' ? Math.floor(Date.now() / 1000) - 60 : '5m').sign(key)
      res.end(JSON.stringify({ id_token: token, access_token: 'server-access-token', token_type: 'Bearer' })); return
    }
    if (req.url === '/userinfo') {
      if (req.headers.authorization !== 'Bearer server-access-token') { res.statusCode = 401; res.end('{}'); return }
      res.end(JSON.stringify({ sub: mode === 'userinfo' ? 'other-subject' : 'immutable-user-42', name: '研发用户',
        email: 'same-email@example.test', access_token: 'must-not-persist', custom: { department: '研发', apiKey: 'must-not-persist' } })); return
    }
    if (req.url === '/verify') {
      credentialCalls++
      let body = ''; for await (const chunk of req) body += String(chunk)
      lastCredential = JSON.parse(body)
      if (mode === 'redirect') { res.writeHead(302, { Location: `${issuer}/stolen` }); res.end(); return }
      if (mode === 'oversize') { res.end(JSON.stringify({ active: true, extra: 'x'.repeat(300 * 1024) })); return }
      const data = lastCredential as { credential: string }
      res.end(JSON.stringify({ active: data.credential === 'existing-system-token', user: { id: 'erp-007', display: 'ERP用户',
        email: 'same-email@example.test', data: { department: 'Engineering', token: 'do-not-store', nested: { password: 'do-not-store', locale: 'zh-CN' } } } })); return
    }
    if (req.url === '/stolen') stolenCalls++
    res.statusCode = 404; res.end('{}')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing test port')
  issuer = `http://127.0.0.1:${address.port}`
})
afterAll(async () => { await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve())) })
beforeEach(() => { mode = ''; nonce = ''; expectedChallenge = ''; credentialCalls = 0; stolenCalls = 0; lastCredential = undefined })
const oidc = () => new AccountProviderRegistry([{ id: 'company', name: '企业 SSO', type: 'oidc', issuer, clientId: 'aether-desktop', clientSecret: 'private-client-secret' }])
const credentials = () => new AccountProviderRegistry([{ id: 'erp', name: '企业平台', type: 'credential', verificationUrl: `${issuer}/verify`, serviceToken: 'private-service-token',
  mapping: { subject: 'user.id', name: 'user.display', email: 'user.email', userData: 'user.data' } }])
async function start(registry: AccountProviderRegistry): Promise<BrowserAuthorization> {
  const flow = await registry.startBrowser('company', `${issuer}/callback`)
  const url = new URL(flow.authorizationUrl)
  nonce = url.searchParams.get('nonce') ?? ''; expectedChallenge = url.searchParams.get('code_challenge') ?? ''
  return flow
}
const completion = (flow: BrowserAuthorization) => ({ ...flow, code: 'valid-code', expectedState: flow.state, redirectUri: `${issuer}/callback` })

describe('external authentication protocol boundaries', () => {
  it('publishes capability names without client secrets, service tokens or upstream config', () => {
    expect(oidc().listPublic()).toEqual([{ id: 'company', name: '企业 SSO', type: 'oidc' }])
    expect(credentials().listPublic()).toEqual([{ id: 'erp', name: '企业平台', type: 'credential' }])
  })
  it('performs authorization code + PKCE and verifies signed OIDC identity and UserInfo', async () => {
    const registry = oidc(), flow = await start(registry)
    expect(new URL(flow.authorizationUrl).searchParams.get('code_challenge_method')).toBe('S256')
    const identity = await registry.completeBrowser('company', completion(flow))
    expect(lastCodeVerifier).toBe(flow.codeVerifier)
    expect(identity).toMatchObject({ providerId: 'company', issuer, subject: 'immutable-user-42', name: '研发用户' })
    expect(identity.userData.custom).toEqual({ department: '研发' })
    expect(JSON.stringify(identity)).not.toContain('must-not-persist')
  })
  it.each(['nonce', 'issuer', 'audience', 'signature', 'expired', 'userinfo'])('rejects forged or inconsistent %s', async attack => {
    const registry = oidc(), flow = await start(registry); mode = attack
    await expect(registry.completeBrowser('company', completion(flow))).rejects.toThrow()
  })
  it('rejects altered state before contacting token endpoint', async () => {
    const registry = oidc(), flow = await start(registry); lastCodeVerifier = 'not-called'
    await expect(registry.completeBrowser('company', { ...completion(flow), state: 'attacker-state' })).rejects.toThrow('state')
    expect(lastCodeVerifier).toBe('not-called')
  })
  it('rejects issuer substitution in discovery', async () => {
    mode = 'discovery-issuer'; await expect(start(oidc())).rejects.toThrow('issuer')
  })
  it('forbids a production discovery document from downgrading to loopback HTTP', async () => {
    const discovery = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({ issuer: 'https://sso.example.test',
      authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks` })))
    try {
      const registry = new AccountProviderRegistry([{ id: 'production', name: 'Production', type: 'oidc', issuer: 'https://sso.example.test', clientId: 'desktop' }])
      await expect(registry.startBrowser('production', 'https://aether.example.test/callback')).rejects.toThrow('传输安全')
      expect(discovery).toHaveBeenCalledTimes(1)
    } finally { discovery.mockRestore() }
  })
  it('rejects exchanged invalid code', async () => {
    const registry = oidc(), flow = await start(registry)
    await expect(registry.completeBrowser('company', { ...completion(flow), code: 'wrong-code' })).rejects.toThrow()
  })
  it('supports OAuth2 with an explicitly configured immutable subject field', async () => {
    const registry = new AccountProviderRegistry([{ id: 'company', name: 'OAuth2', type: 'oauth2', issuer,
      authorizationUrl: `${issuer}/authorize`, tokenUrl: `${issuer}/token`, userInfoUrl: `${issuer}/userinfo`,
      clientId: 'aether-desktop', mapping: { subject: 'sub' } }])
    const flow = await start(registry)
    expect(await registry.completeBrowser('company', completion(flow))).toMatchObject({ subject: 'immutable-user-42', issuer })
  })
  it('exchanges a credential at a fixed admin endpoint and maps custom user data', async () => {
    const identity = await credentials().exchangeCredential('erp', 'existing-system-token')
    expect(identity).toMatchObject({ providerId: 'erp', subject: 'erp-007', name: 'ERP用户',
      userData: { department: 'Engineering', nested: { locale: 'zh-CN' } } })
    expect(lastCredential).toEqual({ credential: 'existing-system-token' })
    expect(JSON.stringify(identity)).not.toContain('do-not-store')
  })
  it('requires explicitly active credentials; caller cannot supply its own subject', async () => {
    await expect(credentials().exchangeCredential('erp', 'forged-credential')).rejects.toThrow('无效')
    expect(credentialCalls).toBe(1)
  })
  it('refuses redirects so third-party credentials cannot be forwarded elsewhere', async () => {
    mode = 'redirect'; await expect(credentials().exchangeCredential('erp', 'existing-system-token')).rejects.toThrow()
    expect(stolenCalls).toBe(0)
  })
  it('bounds untrusted response bytes before parsing user data', async () => {
    mode = 'oversize'; await expect(credentials().exchangeCredential('erp', 'existing-system-token')).rejects.toThrow('过大')
  })
  it('rejects insecure configured endpoints and duplicate identity namespaces', () => {
    expect(() => new AccountProviderRegistry([{ id: 'unsafe', name: 'Unsafe', type: 'credential', verificationUrl: 'http://10.0.0.2/verify', mapping: { subject: 'id' } }])).toThrow('HTTPS')
    expect(() => new AccountProviderRegistry([{ id: 'x', name: 'X', type: 'credential', verificationUrl: `${issuer}/verify`, mapping: { subject: 'id' } },
      { id: 'x', name: 'X2', type: 'credential', verificationUrl: `${issuer}/verify`, mapping: { subject: 'id' } }])).toThrow('重复')
  })
  it('filters prototype and secret keys recursively, bounds object depth and data size', () => {
    expect(sanitizeExternalUserData(JSON.parse('{"__proto__":{"admin":true},"department":"R&D","nested":{"refresh_token":"secret","locale":"zh"}}')))
      .toEqual({ department: 'R&D', nested: { locale: 'zh' } })
    expect(() => sanitizeExternalUserData({ a: { b: { c: { d: { e: { f: { g: 1 } } } } } } })).toThrow('层级')
    expect(() => sanitizeExternalUserData({ a: 'x'.repeat(4096), b: 'x'.repeat(4096), c: 'x'.repeat(4096), d: 'x'.repeat(4096) })).toThrow('16 KiB')
  })
})
