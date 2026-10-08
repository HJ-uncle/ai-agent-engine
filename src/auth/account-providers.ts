import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from 'jose'
import { z } from 'zod'

const MAX_RESPONSE_BYTES = 256 * 1024
const MAX_USER_DATA_BYTES = 16 * 1024
const SECRET_FIELD = /(?:password|passwd|secret|token|credential|authorization|cookie|private.?key|api.?key|session.?id|code.?verifier)/i
const RESERVED_FIELDS = new Set(['__proto__', 'prototype', 'constructor'])
const mappingSchema = z.object({
  subject: z.string().min(1).max(256).optional(), name: z.string().max(256).optional(),
  email: z.string().max(256).optional(), avatarUrl: z.string().max(256).optional(),
  userData: z.string().max(256).optional(), active: z.string().max(256).optional(),
}).strict()
const common = {
  id: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/), name: z.string().min(1).max(100),
  mapping: mappingSchema.optional(),
}
const browser = {
  clientId: z.string().min(1).max(512), clientSecret: z.string().min(1).max(8192).optional(),
  scopes: z.array(z.string().min(1).max(100)).min(1).max(20).optional(),
  tokenAuthMethod: z.enum(['client_secret_post', 'client_secret_basic', 'none']).optional(),
}
const providerSchema = z.discriminatedUnion('type', [
  z.object({ ...common, ...browser, type: z.literal('oidc'), issuer: z.string().url() }).strict(),
  z.object({ ...common, ...browser, type: z.literal('oauth2'), issuer: z.string().url(),
    authorizationUrl: z.string().url(), tokenUrl: z.string().url(), userInfoUrl: z.string().url(),
    mapping: mappingSchema.extend({ subject: z.string().min(1).max(256) }),
  }).strict(),
  z.object({ ...common, type: z.literal('credential'), verificationUrl: z.string().url(),
    serviceToken: z.string().min(1).max(8192).optional(),
    mapping: mappingSchema.extend({ subject: z.string().min(1).max(256) }),
  }).strict(),
])
export type AccountProviderConfig = z.infer<typeof providerSchema>
export type PublicAccountProvider = { id: string; name: string; type: AccountProviderConfig['type'] }
export interface VerifiedExternalIdentity {
  providerId: string; issuer: string; subject: string; name?: string; email?: string
  avatarUrl?: string; userData: Record<string, unknown>
}
export interface BrowserAuthorization {
  authorizationUrl: string; state: string; nonce: string; codeVerifier: string
}
export interface BrowserCompletion {
  code: string; state: string; expectedState: string; nonce: string; codeVerifier: string; redirectUri: string
}
type JsonObject = Record<string, unknown>
function object(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
export function assertAccountProviderUrl(value: string): URL {
  const url = new URL(value)
  const loopback = ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) || url.username || url.password || url.hash) {
    throw new Error('登录服务地址必须使用 HTTPS（仅 loopback 开发环境允许 HTTP）')
  }
  return url
}
function atPath(value: unknown, path: string | undefined): unknown {
  if (!path) return undefined
  let result: unknown = value
  for (const key of path.split('.')) {
    if (RESERVED_FIELDS.has(key) || !object(result) || !Object.hasOwn(result, key)) return undefined
    result = result[key]
  }
  return result
}
export function sanitizeExternalUserData(value: unknown): Record<string, unknown> {
  let nodes = 0
  const visit = (entry: unknown, depth: number): unknown => {
    if (++nodes > 1024 || depth > 6) throw new Error('第三方用户信息层级或字段数量超出限制')
    if (entry === null || typeof entry === 'boolean') return entry
    if (typeof entry === 'string') return entry.slice(0, 4096)
    if (typeof entry === 'number') return Number.isFinite(entry) ? entry : null
    if (Array.isArray(entry)) {
      if (entry.length > 100) throw new Error('第三方用户信息数组超出限制')
      return entry.map(child => visit(child, depth + 1))
    }
    if (!object(entry)) return undefined
    const result: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(entry)) {
      if (key.length > 128 || SECRET_FIELD.test(key) || RESERVED_FIELDS.has(key)) continue
      result[key] = visit(child, depth + 1)
    }
    return result
  }
  const result = visit(object(value) ? value : {}, 0) as Record<string, unknown>
  if (Buffer.byteLength(JSON.stringify(result)) > MAX_USER_DATA_BYTES) throw new Error('第三方用户信息超过 16 KiB')
  return result
}
async function fetchJson(url: string, options: RequestInit = {}): Promise<JsonObject> {
  assertAccountProviderUrl(url)
  const response = await fetch(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(10_000) })
  if (!response.ok) { await response.body?.cancel(); throw new Error('第三方认证服务拒绝了请求') }
  if (Number(response.headers.get('content-length') ?? 0) > MAX_RESPONSE_BYTES) {
    await response.body?.cancel(); throw new Error('第三方认证响应过大')
  }
  const reader = response.body?.getReader()
  if (!reader) throw new Error('第三方认证响应为空')
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.byteLength
      if (length > MAX_RESPONSE_BYTES) throw new Error('第三方认证响应过大')
      chunks.push(value)
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
  let result: unknown
  try { result = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new Error('第三方认证未返回合法 JSON') }
  if (!object(result)) throw new Error('第三方认证未返回对象')
  return result
}
function constantEqual(left: string, right: string): boolean {
  return timingSafeEqual(createHash('sha256').update(left).digest(), createHash('sha256').update(right).digest())
}
function textField(value: unknown, max: number): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined
}
function identityFrom(provider: AccountProviderConfig, claims: JsonObject, subjectOverride?: string): VerifiedExternalIdentity {
  const mapping = provider.mapping
  const rawSubject = subjectOverride ?? atPath(claims, mapping?.subject ?? 'sub')
  const subject = typeof rawSubject === 'number' && Number.isSafeInteger(rawSubject) ? String(rawSubject) : rawSubject
  if (typeof subject !== 'string' || !subject || subject.length > 512 || /[\u0000-\u001f]/.test(subject)) throw new Error('第三方缺少稳定用户标识')
  const avatar = textField(atPath(claims, mapping?.avatarUrl ?? 'picture'), 2048)
  let avatarUrl: string | undefined
  if (avatar) { try { if (new URL(avatar).protocol === 'https:') avatarUrl = avatar } catch { /* Ignore untrusted image schemes. */ } }
  return {
    providerId: provider.id, issuer: provider.type === 'credential' ? provider.verificationUrl : provider.issuer,
    subject, name: textField(atPath(claims, mapping?.name ?? 'name'), 100),
    email: textField(atPath(claims, mapping?.email ?? 'email'), 320), avatarUrl,
    userData: sanitizeExternalUserData(mapping?.userData ? atPath(claims, mapping.userData) : claims),
  }
}
export class AccountProviderRegistry {
  private readonly providers: Map<string, AccountProviderConfig>
  private readonly metadata = new Map<string, { expires: number; value: JsonObject }>()
  constructor(configs: unknown) {
    const parsed = z.array(providerSchema).max(32).parse(configs)
    this.providers = new Map()
    for (const provider of parsed) {
      if (this.providers.has(provider.id)) throw new Error('第三方登录提供方 ID 重复')
      for (const [key, value] of Object.entries(provider)) {
        if (['issuer', 'authorizationUrl', 'tokenUrl', 'userInfoUrl', 'verificationUrl'].includes(key) && typeof value === 'string') assertAccountProviderUrl(value)
      }
      if (provider.type !== 'credential' && provider.tokenAuthMethod !== 'none' && provider.tokenAuthMethod && !provider.clientSecret) throw new Error('所选第三方客户端认证方式需要 clientSecret')
      this.providers.set(provider.id, provider)
    }
  }
  static fromEnvironment(): AccountProviderRegistry {
    const raw = process.env.AETHER_ACCOUNT_PROVIDERS_JSON ?? '[]'
    if (Buffer.byteLength(raw) > 128 * 1024) throw new Error('第三方登录配置过大')
    return new AccountProviderRegistry(JSON.parse(raw))
  }
  listPublic(): PublicAccountProvider[] {
    return [...this.providers.values()].map(({ id, name, type }) => ({ id, name, type }))
  }
  get(id: string): AccountProviderConfig {
    const provider = this.providers.get(id)
    if (!provider) throw new Error('该第三方登录尚未配置')
    return provider
  }
  private async endpoints(provider: Exclude<AccountProviderConfig, { type: 'credential' }>): Promise<{ authorizationUrl: string; tokenUrl: string; userInfoUrl?: string; jwksUrl?: string }> {
    if (provider.type === 'oauth2') return provider
    let discovery = this.metadata.get(provider.id)
    if (!discovery || discovery.expires < Date.now()) {
      const issuer = assertAccountProviderUrl(provider.issuer)
      if (issuer.search) throw new Error('OIDC issuer 不允许查询参数')
      const value = await fetchJson(`${provider.issuer.replace(/\/$/, '')}/.well-known/openid-configuration`)
      if (value.issuer !== provider.issuer) throw new Error('OIDC issuer 不匹配')
      discovery = { expires: Date.now() + 300_000, value }
      this.metadata.set(provider.id, discovery)
    }
    const required = (key: string): string => {
      const value = discovery.value[key]
      if (typeof value !== 'string') throw new Error('OIDC discovery 缺少必要端点')
      const endpoint = assertAccountProviderUrl(value)
      // Loopback HTTP is only a developer exception; remote discovery cannot downgrade secrets onto it.
      if (new URL(provider.issuer).protocol === 'https:' && endpoint.protocol !== 'https:') throw new Error('OIDC discovery 不允许降低传输安全性')
      return value
    }
    return { authorizationUrl: required('authorization_endpoint'), tokenUrl: required('token_endpoint'),
      jwksUrl: required('jwks_uri'), userInfoUrl: discovery.value.userinfo_endpoint ? required('userinfo_endpoint') : undefined }
  }
  async startBrowser(id: string, redirectUri: string): Promise<BrowserAuthorization> {
    const provider = this.get(id)
    if (provider.type === 'credential') throw new Error('此提供方使用凭证登录')
    assertAccountProviderUrl(redirectUri)
    const { authorizationUrl } = await this.endpoints(provider)
    const state = randomBytes(32).toString('base64url'), nonce = randomBytes(32).toString('base64url')
    const codeVerifier = randomBytes(48).toString('base64url')
    const url = new URL(authorizationUrl)
    const scopes = [...(provider.scopes ?? (provider.type === 'oidc' ? ['openid', 'profile', 'email'] : ['profile']))]
    if (provider.type === 'oidc' && !scopes.includes('openid')) scopes.unshift('openid')
    for (const [key, value] of Object.entries({ response_type: 'code', client_id: provider.clientId,
      redirect_uri: redirectUri, scope: scopes.join(' '), state, nonce,
      code_challenge: createHash('sha256').update(codeVerifier).digest('base64url'), code_challenge_method: 'S256' })) url.searchParams.set(key, value)
    return { authorizationUrl: url.toString(), state, nonce, codeVerifier }
  }
  async completeBrowser(id: string, input: BrowserCompletion): Promise<VerifiedExternalIdentity> {
    if (!input.state || !input.expectedState || !constantEqual(input.state, input.expectedState)) throw new Error('第三方登录 state 校验失败')
    if (!input.code || input.code.length > 8192 || !input.nonce || !/^[A-Za-z0-9_-]{43,128}$/.test(input.codeVerifier)) throw new Error('第三方登录流程参数不完整')
    const provider = this.get(id)
    if (provider.type === 'credential') throw new Error('此提供方使用凭证登录')
    assertAccountProviderUrl(input.redirectUri)
    const endpoints = await this.endpoints(provider)
    const body = new URLSearchParams({ grant_type: 'authorization_code', code: input.code, redirect_uri: input.redirectUri,
      client_id: provider.clientId, code_verifier: input.codeVerifier })
    const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }
    const method = provider.tokenAuthMethod ?? (provider.clientSecret ? 'client_secret_post' : 'none')
    if (method === 'client_secret_basic') headers.Authorization = `Basic ${Buffer.from(`${encodeURIComponent(provider.clientId)}:${encodeURIComponent(provider.clientSecret ?? '')}`).toString('base64')}`
    else if (method === 'client_secret_post') body.set('client_secret', provider.clientSecret ?? '')
    const tokens = await fetchJson(endpoints.tokenUrl, { method: 'POST', headers, body })
    if (tokens.error) throw new Error('第三方授权码交换失败')
    let claims: JsonObject = {}
    let verifiedSubject: string | undefined
    if (provider.type === 'oidc') {
      if (typeof tokens.id_token !== 'string' || tokens.id_token.length > 64 * 1024 || !endpoints.jwksUrl) throw new Error('OIDC 未返回 ID Token')
      const jwks = await fetchJson(endpoints.jwksUrl)
      if (!Array.isArray(jwks.keys) || jwks.keys.length > 50) throw new Error('OIDC JWKS 无效')
      const { payload } = await jwtVerify(tokens.id_token, createLocalJWKSet(jwks as unknown as JSONWebKeySet), {
        issuer: provider.issuer, audience: provider.clientId, algorithms: ['RS256', 'RS384', 'RS512', 'ES256', 'ES384', 'ES512', 'PS256', 'PS384', 'PS512', 'EdDSA'],
        requiredClaims: ['iss', 'sub', 'aud', 'exp', 'iat', 'nonce'], clockTolerance: 5, maxTokenAge: '10m',
      })
      if (payload.nonce !== input.nonce || !payload.sub || (payload.azp !== undefined && payload.azp !== provider.clientId)
        || (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== provider.clientId)) throw new Error('OIDC nonce 或授权客户端不匹配')
      claims = payload; verifiedSubject = payload.sub
    }
    if (endpoints.userInfoUrl) {
      if (typeof tokens.access_token !== 'string' || !tokens.access_token || tokens.access_token.length > 16 * 1024 || /[\r\n]/.test(tokens.access_token)
        || (typeof tokens.token_type === 'string' && tokens.token_type.toLowerCase() !== 'bearer')) throw new Error('第三方未返回可用的访问凭证')
      const info = await fetchJson(endpoints.userInfoUrl, { headers: { Authorization: `Bearer ${tokens.access_token}`, Accept: 'application/json' } })
      if (verifiedSubject && info.sub !== verifiedSubject) throw new Error('OIDC UserInfo 用户与 ID Token 不一致')
      claims = { ...claims, ...info }
    }
    return identityFrom(provider, claims, verifiedSubject)
  }
  async exchangeCredential(id: string, credential: string): Promise<VerifiedExternalIdentity> {
    const provider = this.get(id)
    if (provider.type !== 'credential') throw new Error('此提供方需要浏览器授权')
    if (typeof credential !== 'string' || !credential.trim() || credential.length > 16 * 1024) throw new Error('第三方凭证为空或过长')
    const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json' }
    if (provider.serviceToken) headers.Authorization = `Bearer ${provider.serviceToken}`
    const claims = await fetchJson(provider.verificationUrl, { method: 'POST', headers, body: JSON.stringify({ credential }) })
    if (atPath(claims, provider.mapping.active ?? 'active') !== true) throw new Error('第三方凭证无效或已过期')
    return identityFrom(provider, claims)
  }
}
