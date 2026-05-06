import { getDb } from '../storage/sqlite/db.js'
import { auditLogStore } from './audit-log.js'

export type PolicyAction = 'allow' | 'ask' | 'deny'

export interface PolicyRule {
  id?: number
  name: string
  /** 命令名（basename），大小写不敏感；支持 "*" 通配所有命令 */
  command: string
  /** 可选：匹配"整个参数序列"（以空格 join 后的字符串）的正则 */
  argPattern?: string | null
  action: PolicyAction
  /** 数字越小越优先命中（默认 100） */
  priority: number
  enabled: boolean
  description?: string | null
  createdAt?: number
  updatedAt?: number
}

export interface PolicyDecisionInput {
  command: string
  args?: string[]
  tenantId?: string
  sessionId?: string
}

export interface PolicyDecision {
  action: PolicyAction
  ruleId?: number
  ruleName?: string
  reason: string
  /** 触发了参数注入检测时，给出具体匹配片段 */
  injectionMatches?: string[]
}

// ─── 内置规则（落库前作为默认策略，用户可覆盖） ───────────────────────────
const DEFAULT_RULES: PolicyRule[] = [
  // 高危命令直接 ask 确认
  { name: 'ask-rm', command: 'rm', action: 'ask', priority: 10, enabled: true, description: '删除文件需确认' },
  { name: 'ask-del', command: 'del', action: 'ask', priority: 10, enabled: true, description: '删除文件（Windows）需确认' },
  { name: 'ask-sudo', command: 'sudo', action: 'deny', priority: 5, enabled: true, description: '禁止 sudo 提权' },
  { name: 'ask-shutdown', command: 'shutdown', action: 'deny', priority: 5, enabled: true, description: '禁止关机' },
  { name: 'ask-reboot', command: 'reboot', action: 'deny', priority: 5, enabled: true, description: '禁止重启' },
  { name: 'ask-kill', command: 'kill', action: 'ask', priority: 20, enabled: true, description: '终止进程需确认' },
  { name: 'ask-taskkill', command: 'taskkill', action: 'ask', priority: 20, enabled: true, description: '终止进程需确认（Windows）' },
  { name: 'ask-format', command: 'format', action: 'deny', priority: 5, enabled: true, description: '禁止格式化磁盘' },
  { name: 'ask-mkfs', command: 'mkfs', action: 'deny', priority: 5, enabled: true, description: '禁止格式化磁盘' },
  { name: 'ask-chmod', command: 'chmod', action: 'ask', priority: 30, enabled: true, description: '修改权限需确认' },
  { name: 'ask-chown', command: 'chown', action: 'ask', priority: 30, enabled: true, description: '修改属主需确认' },

  // 常用命令默认放行（在白名单内的）
  { name: 'allow-ls',    command: 'ls',    action: 'allow', priority: 200, enabled: true },
  { name: 'allow-dir',   command: 'dir',   action: 'allow', priority: 200, enabled: true },
  { name: 'allow-cat',   command: 'cat',   action: 'allow', priority: 200, enabled: true },
  { name: 'allow-echo',  command: 'echo',  action: 'allow', priority: 200, enabled: true },
  { name: 'allow-grep',  command: 'grep',  action: 'allow', priority: 200, enabled: true },
  { name: 'allow-find',  command: 'find',  action: 'allow', priority: 200, enabled: true },
  { name: 'allow-node',  command: 'node',  action: 'allow', priority: 200, enabled: true },
  { name: 'allow-npm',   command: 'npm',   action: 'allow', priority: 200, enabled: true },
  { name: 'allow-npx',   command: 'npx',   action: 'allow', priority: 200, enabled: true },

  // 兜底：未知命令统一 ask
  { name: 'default-ask', command: '*', action: 'ask', priority: 999, enabled: true, description: '未匹配任何规则时，默认询问用户' },
]

// ─── 命令注入 / 路径穿越 静态检测 ─────────────────────────────────────────
/**
 * 静态扫描参数中是否存在命令注入特征。
 * 由于 cmd-tool 已经使用 shell:false，这些字符只是字面量而不会被 shell 解释，
 * 但很多命令（如 sh -c、bash -c、npm run ... -- "cmd"）会再开一层子 shell，
 * 所以我们在最底层也做一次检测，并记录审计日志。
 */
export function detectInjection(args: string[]): string[] {
  const hits: string[] = []
  // 典型 shell metacharacter（只要出现在单个 arg 里就高度可疑）
  const SHELL_METAS = [
    /[\;\&\|]/,           // ; & |
    /`/,                  // backtick
    /\$\(/,               // $(
    /\$\{/,               // ${
    />\s*[^\s]/,          // > redirect
    /<\s*[^\s]/,          // < redirect
    /\|\|/,               // ||
    /\n|\r/,              // newline injection
  ]
  for (const a of args) {
    if (typeof a !== 'string') continue
    for (const re of SHELL_METAS) {
      if (re.test(a)) { hits.push(a); break }
    }
  }
  return hits
}

/** 路径穿越：.. 或 绝对路径到敏感目录 */
export function detectPathTraversal(args: string[]): string[] {
  const hits: string[] = []
  const SENSITIVE = [
    /(^|[\\\/])\.\.([\\\/]|$)/,     // ../ 或 /..
    /^\/etc\//i,
    /^\/root\//i,
    /C:\\Windows\\System32/i,
  ]
  for (const a of args) {
    if (typeof a !== 'string') continue
    for (const re of SENSITIVE) {
      if (re.test(a)) { hits.push(a); break }
    }
  }
  return hits
}

// ─── 规则存储 ─────────────────────────────────────────────────────────────

let defaultsSeeded = false

async function seedDefaultsIfEmpty(): Promise<void> {
  if (defaultsSeeded) return
  defaultsSeeded = true
  const db = getDb()
  const cnt = await db.execute('SELECT COUNT(*) AS c FROM security_policies')
  if (Number(cnt.rows[0]?.c ?? 0) > 0) return
  for (const r of DEFAULT_RULES) {
    await db.execute({
      sql: `INSERT INTO security_policies (name, command, arg_pattern, action, priority, enabled, description)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: [r.name, r.command.toLowerCase(), r.argPattern ?? null, r.action, r.priority, r.enabled ? 1 : 0, r.description ?? null],
    })
  }
}

export class PolicyEngine {
  async listRules(): Promise<PolicyRule[]> {
    await seedDefaultsIfEmpty()
    const db = getDb()
    const res = await db.execute(
      `SELECT * FROM security_policies ORDER BY priority ASC, id ASC`,
    )
    return res.rows.map(rowToRule)
  }

  async upsertRule(rule: PolicyRule): Promise<PolicyRule> {
    const db = getDb()
    if (rule.id) {
      await db.execute({
        sql: `UPDATE security_policies
              SET name=?, command=?, arg_pattern=?, action=?, priority=?, enabled=?, description=?, updated_at=unixepoch()
              WHERE id=?`,
        args: [
          rule.name, rule.command.toLowerCase(), rule.argPattern ?? null, rule.action,
          rule.priority, rule.enabled ? 1 : 0, rule.description ?? null, rule.id,
        ],
      })
      return { ...rule }
    }
    const res = await db.execute({
      sql: `INSERT INTO security_policies (name, command, arg_pattern, action, priority, enabled, description)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: [
        rule.name, rule.command.toLowerCase(), rule.argPattern ?? null, rule.action,
        rule.priority, rule.enabled ? 1 : 0, rule.description ?? null,
      ],
    })
    return { ...rule, id: Number((res as any).lastInsertRowid ?? 0) }
  }

  async deleteRule(id: number): Promise<void> {
    const db = getDb()
    await db.execute({ sql: 'DELETE FROM security_policies WHERE id = ?', args: [id] })
  }

  async resetDefaults(): Promise<void> {
    const db = getDb()
    await db.execute('DELETE FROM security_policies')
    defaultsSeeded = false
    await seedDefaultsIfEmpty()
  }

  /**
   * 核心：评估一次命令调用，返回 allow/ask/deny。
   * - 命中注入模式直接拒绝并审计
   * - 否则按 priority 升序匹配第一条规则
   */
  async evaluate(input: PolicyDecisionInput): Promise<PolicyDecision> {
    await seedDefaultsIfEmpty()
    const cmd  = baseName(input.command).toLowerCase()
    const args = input.args ?? []

    // 1) 注入检测（最高优先级，直接 deny）
    const injections = detectInjection(args)
    if (injections.length > 0) {
      const decision: PolicyDecision = {
        action: 'deny',
        reason: `检测到 shell 元字符/命令注入: ${injections.join(' | ')}`,
        injectionMatches: injections,
      }
      await auditLogStore.append({
        tenantId: input.tenantId,
        sessionId: input.sessionId,
        category: 'cmd',
        target: [cmd, ...args].join(' '),
        decision: 'deny',
        reason: decision.reason,
        details: { injections },
      })
      return decision
    }
    const traversal = detectPathTraversal(args)
    if (traversal.length > 0) {
      const decision: PolicyDecision = {
        action: 'ask',
        reason: `参数疑似路径穿越: ${traversal.join(' | ')}`,
      }
      await auditLogStore.append({
        tenantId: input.tenantId,
        sessionId: input.sessionId,
        category: 'cmd',
        target: [cmd, ...args].join(' '),
        decision: 'ask',
        reason: decision.reason,
        details: { traversal },
      })
      return decision
    }

    // 2) 按 priority 匹配规则
    const rules = await this.listRules()
    const argStr = args.join(' ')
    for (const r of rules) {
      if (!r.enabled) continue
      if (r.command !== '*' && r.command !== cmd) continue
      if (r.argPattern) {
        try {
          const re = new RegExp(r.argPattern)
          if (!re.test(argStr)) continue
        } catch {
          // 无效正则：跳过
          continue
        }
      }
      const decision: PolicyDecision = {
        action: r.action,
        ruleId: r.id,
        ruleName: r.name,
        reason: `命中规则 #${r.id} ${r.name}`,
      }
      await auditLogStore.append({
        tenantId: input.tenantId,
        sessionId: input.sessionId,
        category: 'cmd',
        target: [cmd, ...args].join(' '),
        decision: r.action,
        ruleId: r.id ?? null,
        reason: decision.reason,
      })
      return decision
    }

    // 3) 无规则兜底（实际 DEFAULT_RULES 已经注入 "default-ask"，这里基本不会到达）
    const decision: PolicyDecision = { action: 'ask', reason: '未命中任何策略，默认询问' }
    await auditLogStore.append({
      tenantId: input.tenantId,
      sessionId: input.sessionId,
      category: 'cmd',
      target: [cmd, ...args].join(' '),
      decision: 'ask',
      reason: decision.reason,
    })
    return decision
  }
}

function baseName(cmd: string): string {
  return cmd.split(/[/\\]/).pop() ?? cmd
}

function rowToRule(r: any): PolicyRule {
  return {
    id: Number(r.id),
    name: r.name as string,
    command: r.command as string,
    argPattern: (r.arg_pattern as string) ?? null,
    action: r.action as PolicyAction,
    priority: Number(r.priority),
    enabled: Boolean(r.enabled),
    description: (r.description as string) ?? null,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  }
}

export const policyEngine = new PolicyEngine()
