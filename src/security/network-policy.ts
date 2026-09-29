import dns from 'node:dns/promises'
import net from 'node:net'
import { getDb } from '../storage/sqlite/db.js'
import { auditLogStore } from './audit-log.js'
import { getSecurityMode } from './policy-engine.js'

export interface NetworkPolicy {
  /** 允许的协议列表，如 ['https:', 'http:'] */
  allowedProtocols: string[]
  /** 是否启用黑名单（domain / ip） */
  denyListEnabled: boolean
  /** 域名黑名单（精确 or 后缀匹配） */
  denyDomains: string[]
  /** IP 段黑名单（CIDR） */
  denyCidrs: string[]
  /** 是否启用白名单 */
  allowListEnabled: boolean
  allowDomains: string[]
  /** 是否禁止访问私有/保留 IP（SSRF 防护） */
  blockPrivateIP: boolean
  /** DNS 解析结果缓存时间（秒） */
  dnsCacheTtl: number
  /** 响应最大字节数（0 表示不限制） */
  maxResponseBytes: number
  /** 请求超时（毫秒） */
  timeoutMs: number
}

export const DEFAULT_NETWORK_POLICY: NetworkPolicy = {
  allowedProtocols: ['https:', 'http:'],
  denyListEnabled: true,
  denyDomains: ['metadata.google.internal', 'metadata.aws.internal'],
  denyCidrs: [],
  allowListEnabled: false,
  allowDomains: [],
  blockPrivateIP: true,
  dnsCacheTtl: 300,
  maxResponseBytes: 5 * 1024 * 1024, // 5MB
  timeoutMs: 30000,
}

// ─── 私有 / 保留 IP 段（IPv4 + IPv6） ────────────────────────────────────
const PRIVATE_V4_CIDRS: Array<[bigint, number]> = [
  v4ToCidr('10.0.0.0', 8),
  v4ToCidr('172.16.0.0', 12),
  v4ToCidr('192.168.0.0', 16),
  v4ToCidr('127.0.0.0', 8),           // loopback
  v4ToCidr('169.254.0.0', 16),        // link-local (含云 metadata 169.254.169.254)
  v4ToCidr('0.0.0.0', 8),
  v4ToCidr('100.64.0.0', 10),         // CGNAT
  v4ToCidr('224.0.0.0', 4),           // multicast
  v4ToCidr('240.0.0.0', 4),           // reserved
]

function v4ToBigInt(ip: string): bigint {
  const parts = ip.split('.').map((n) => BigInt(parseInt(n, 10)))
  return (parts[0] << 24n) | (parts[1] << 16n) | (parts[2] << 8n) | parts[3]
}
function v4ToCidr(ip: string, prefix: number): [bigint, number] {
  return [v4ToBigInt(ip), prefix]
}
function v4InCidr(ip: string, cidr: [bigint, number]): boolean {
  const ipN = v4ToBigInt(ip)
  const mask = (0xffffffffn << BigInt(32 - cidr[1])) & 0xffffffffn
  return (ipN & mask) === (cidr[0] & mask)
}

function v6IsPrivate(ip: string): boolean {
  // 简化：::1 本地回环, fe80::/10 link-local, fc00::/7 ULA
  const lower = ip.toLowerCase()
  if (lower === '::1' || lower === '::') return true
  if (lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) return true
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true
  return false
}

export function isPrivateIP(ip: string): boolean {
  if (net.isIPv4(ip)) {
    return PRIVATE_V4_CIDRS.some((c) => v4InCidr(ip, c))
  }
  if (net.isIPv6(ip)) {
    // IPv4-mapped (::ffff:a.b.c.d)
    const m = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i)
    if (m) return PRIVATE_V4_CIDRS.some((c) => v4InCidr(m[1], c))
    return v6IsPrivate(ip)
  }
  return false
}

export function parseCidr(cidr: string): [bigint, number] | null {
  const [ip, prefixStr] = cidr.split('/')
  const prefix = parseInt(prefixStr, 10)
  if (!net.isIPv4(ip) || isNaN(prefix) || prefix < 0 || prefix > 32) return null
  return v4ToCidr(ip, prefix)
}

// ─── DNS 缓存 ───────────────────────────────────────────────────────────
interface DnsCacheEntry {
  addrs: string[]
  expireAt: number
}
const dnsCache = new Map<string, DnsCacheEntry>()

async function resolveHost(hostname: string, ttl: number): Promise<string[]> {
  // 如果 hostname 本身就是 IP，不需要解析
  if (net.isIP(hostname)) return [hostname]

  const now = Date.now()
  const cached = dnsCache.get(hostname)
  if (cached && cached.expireAt > now) return cached.addrs

  const addrs = await dns.lookup(hostname, { all: true })
  const ips = addrs.map((a) => a.address)
  dnsCache.set(hostname, { addrs: ips, expireAt: now + ttl * 1000 })
  return ips
}

// ─── 持久化策略 ─────────────────────────────────────────────────────────
export async function loadNetworkPolicy(): Promise<NetworkPolicy> {
  try {
    const db = getDb()
    const res = await db.execute('SELECT config FROM network_policies WHERE id = 1')
    if (res.rows.length > 0) {
      const cfg = JSON.parse(res.rows[0].config as string)
      return { ...DEFAULT_NETWORK_POLICY, ...cfg }
    }
  } catch { /* 表不存在或其他错误，退回默认 */ }
  return { ...DEFAULT_NETWORK_POLICY }
}

export async function saveNetworkPolicy(policy: NetworkPolicy): Promise<void> {
  const db = getDb()
  const json = JSON.stringify(policy)
  await db.execute({
    sql: `INSERT INTO network_policies (id, config, updated_at) VALUES (1, ?, unixepoch())
          ON CONFLICT(id) DO UPDATE SET config = excluded.config, updated_at = unixepoch()`,
    args: [json],
  })
}

// ─── 核心检查 ───────────────────────────────────────────────────────────
export interface NetworkCheckInput {
  url: string
  tenantId?: string
  sessionId?: string
  /** 为 audit log 记录使用场景，如 "web_fetch" / "http_request" */
  source?: string
}

export interface NetworkCheckResult {
  allowed: boolean
  reason?: string
  resolvedIp?: string
  /** 对外可暴露的策略关键字段（供工具回显） */
  maxResponseBytes: number
  timeoutMs: number
}

export async function checkNetworkAccess(input: NetworkCheckInput): Promise<NetworkCheckResult> {
  const policy = await loadNetworkPolicy()
  const base = { maxResponseBytes: policy.maxResponseBytes, timeoutMs: policy.timeoutMs }
  const mode = getSecurityMode(input.tenantId ?? 'default', input.sessionId ?? '')

  const audit = async (allowed: boolean, reason: string, resolvedIp?: string) => {
    await auditLogStore.append({
      tenantId: input.tenantId,
      sessionId: input.sessionId,
      category: 'network',
      target: input.url,
      decision: allowed ? 'allow' : 'deny',
      reason,
      details: { source: input.source, resolvedIp, securityMode: mode },
    })
  }

  // ── full-access 模式：跳过所有网络检查，仅审计 ──
  if (mode === 'full-access') {
    await audit(true, '安全模式: full-access，跳过网络策略检查')
    return { allowed: true, ...base }
  }

  let parsed: URL
  try {
    parsed = new URL(input.url)
  } catch {
    await audit(false, 'invalid url')
    return { allowed: false, reason: '无效的 URL 格式', ...base }
  }

  // 协议
  if (!policy.allowedProtocols.includes(parsed.protocol)) {
    const reason = `协议 ${parsed.protocol} 不允许`
    await audit(false, reason)
    return { allowed: false, reason, ...base }
  }

  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '')

  // 白名单模式（优先）
  if (policy.allowListEnabled && policy.allowDomains.length > 0) {
    const matched = policy.allowDomains.some((h) => {
      const hl = h.toLowerCase()
      return hostname === hl || hostname.endsWith('.' + hl)
    })
    if (!matched) {
      const reason = `域名 ${hostname} 不在白名单中`
      await audit(false, reason)
      return { allowed: false, reason, ...base }
    }
  }

  // 黑名单
  if (policy.denyListEnabled) {
    for (const d of policy.denyDomains) {
      const dl = d.toLowerCase()
      if (hostname === dl || hostname.endsWith('.' + dl) || hostname.startsWith(dl)) {
        const reason = `域名 ${hostname} 在黑名单中（规则: ${d}）`
        await audit(false, reason)
        return { allowed: false, reason, ...base }
      }
    }
  }

  // DNS 解析 + 私有 IP 检查（SSRF 核心防护）
  let ips: string[] = []
  try {
    ips = await resolveHost(hostname, policy.dnsCacheTtl)
  } catch (e: any) {
    const reason = `DNS 解析失败: ${e.message ?? 'unknown'}`
    await audit(false, reason)
    return { allowed: false, reason, ...base }
  }
  if (ips.length === 0) {
    const reason = 'DNS 解析返回空'
    await audit(false, reason)
    return { allowed: false, reason, ...base }
  }

  if (policy.blockPrivateIP && mode !== 'standard') {
    for (const ip of ips) {
      if (isPrivateIP(ip)) {
        const reason = `目标 IP ${ip} 属于私有/保留网段（SSRF 防护）`
        await audit(false, reason, ip)
        return { allowed: false, reason, resolvedIp: ip, ...base }
      }
    }
  }

  // CIDR 黑名单
  if (policy.denyListEnabled && policy.denyCidrs.length > 0) {
    for (const ip of ips) {
      if (!net.isIPv4(ip)) continue
      for (const cidrStr of policy.denyCidrs) {
        const cidr = parseCidr(cidrStr)
        if (cidr && v4InCidr(ip, cidr)) {
          const reason = `IP ${ip} 命中黑名单网段 ${cidrStr}`
          await audit(false, reason, ip)
          return { allowed: false, reason, resolvedIp: ip, ...base }
        }
      }
    }
  }

  await audit(true, 'policy-passed', ips[0])
  return { allowed: true, resolvedIp: ips[0], ...base }
}

/** 清除 DNS 缓存（测试用） */
export function clearDnsCache(): void { dnsCache.clear() }
