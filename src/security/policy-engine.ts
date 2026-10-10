import { getDb } from '../storage/sqlite/db.js'
import { auditLogStore } from './audit-log.js'

export type PolicyAction = 'allow' | 'ask' | 'deny'

// ─── 安全模式 ──────────────────────────────────────────────────────────────
/**
 * 三种安全模式（会话级别）：
 * - safe:        安全模式。白名单 + 策略引擎完整检查，高危命令 deny/ask。
 * - standard:    标准模式（默认）。普通命令直接执行，策略拒绝项仍需确认；硬性边界继续生效。
 * - full-access: 完全访问模式。跳过策略引擎和白名单检查，所有命令/网络直接放行。仍写审计日志。
 */
export type SecurityMode = 'safe' | 'standard' | 'full-access'

// 会话级安全模式存储（内存 Map；持久化可选）
const sessionSecurityModes = new Map<string, SecurityMode>()

// 会话级命令白名单（用户通过 ask 审批后，存入此集合，单次会话有效）
const approvedCommands = new Set<string>()

function sessionKey(tenantId: string, sessionId: string): string {
  // Encode both components unambiguously; delimiter concatenation collides
  // when either component itself contains the delimiter.
  return JSON.stringify([tenantId, sessionId])
}

function commandKey(tenantId: string, sessionId: string, command: string, args: string[]): string {
  return JSON.stringify([tenantId, sessionId, command, args])
}

export function approveCommand(tenantId: string, sessionId: string, command: string, args: string[] = []): void {
  approvedCommands.add(commandKey(tenantId, sessionId, command, args))
}

export function isCommandApproved(tenantId: string, sessionId: string, command: string, args: string[] = []): boolean {
  return approvedCommands.has(commandKey(tenantId, sessionId, command, args))
}

// 合法安全模式集合（校验 DEFAULT_SECURITY_MODE 配置用）
const VALID_SECURITY_MODES: readonly SecurityMode[] = ['safe', 'standard', 'full-access']

/**
 * 解析默认安全模式。
 * 来源：DEFAULT_SECURITY_MODE 环境变量（可由 .aether/aether.json 的
 * defaultSecurityMode 字段在启动时注入）；未设置采用 'standard'。
 * 显式配置但拼写错误时仍回退 'safe'，避免错误配置悄悄放宽策略。
 */
function resolveDefaultSecurityMode(): SecurityMode {
  const raw = process.env.DEFAULT_SECURITY_MODE
  if (raw === undefined) return 'standard'
  if (raw && (VALID_SECURITY_MODES as readonly string[]).includes(raw)) {
    return raw as SecurityMode
  }
  return 'safe'
}

export function getSecurityMode(tenantId: string, sessionId: string): SecurityMode {
  return sessionSecurityModes.get(sessionKey(tenantId, sessionId)) ?? resolveDefaultSecurityMode()
}

export function setSecurityMode(tenantId: string, sessionId: string, mode: SecurityMode): void {
  sessionSecurityModes.set(sessionKey(tenantId, sessionId), mode)
}

export function clearSecurityMode(tenantId: string, sessionId: string): void {
  sessionSecurityModes.delete(sessionKey(tenantId, sessionId))
}

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
  /** Granted by the persisted pending action for this exact tool call. */
  approved?: boolean
  /** Code execution must not inherit a legacy session-wide approval. */
  ignoreSessionApproval?: boolean
  /** Background interpreter launches require an explicit confirmation even when
   * their arguments contain shell metacharacters; foreground invocations deny. */
  background?: boolean
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
/**
 * 规则语义说明（各模式下的最终行为）：
 *
 *  action  │ safe          │ standard              │ full-access
 * ─────────┼───────────────┼───────────────────────┼─────────────
 *  allow   │ 直接放行      │ 直接放行              │ 直接放行
 *  ask     │ 弹出确认对话框 │ 自动升为 allow（放行）│ 直接放行
 *  deny    │ 硬拒绝报错    │ 降级为 ask（用户确认）│ 直接放行
 *
 * 结论：
 *  - standard 模式：能放行就放行，无法确定的统统交用户点击确认，不会出现硬报错。
 *  - safe 模式：白名单严格检查，高危命令 deny。
 *  - full-access 模式：跳过所有策略，全部放行。
 */
const DEFAULT_RULES: PolicyRule[] = [
  // ── 高危操作：safe 下 deny，standard 下降为 ask 让用户自决 ──
  { name: 'ask-sudo',     command: 'sudo',     action: 'deny', priority: 5,  enabled: true, description: 'sudo 提权（safe:拒绝 / standard:需确认）' },
  { name: 'ask-shutdown', command: 'shutdown', action: 'deny', priority: 5,  enabled: true, description: '关机命令（safe:拒绝 / standard:需确认）' },
  { name: 'ask-reboot',   command: 'reboot',   action: 'deny', priority: 5,  enabled: true, description: '重启命令（safe:拒绝 / standard:需确认）' },
  { name: 'ask-format',   command: 'format',   action: 'deny', priority: 5,  enabled: true, description: '格式化磁盘（safe:拒绝 / standard:需确认）' },
  { name: 'ask-mkfs',     command: 'mkfs',     action: 'deny', priority: 5,  enabled: true, description: '格式化磁盘（safe:拒绝 / standard:需确认）' },

  // ── 危险但可逆：safe 下 ask，standard 下自动放行 ──
  // 注意：rm/del/erase/rmdir/Remove-Item/git clean 在 evaluate() 顶部被硬拒绝
  // （删除必须走 delete_file 工具），不会走到这里的规则匹配；保留规则仅作文档。
  { name: 'ask-rm',       command: 'rm',       action: 'ask',  priority: 10, enabled: true, description: '删除文件（已被硬拦截取代：删除必须走 delete_file 工具）' },
  { name: 'ask-del',      command: 'del',      action: 'ask',  priority: 10, enabled: true, description: '删除文件 Windows（已被硬拦截取代：删除必须走 delete_file 工具）' },
  { name: 'ask-kill',     command: 'kill',     action: 'ask',  priority: 20, enabled: true, description: '终止进程（safe:需确认 / standard:自动放行）' },
  { name: 'ask-taskkill', command: 'taskkill', action: 'ask',  priority: 20, enabled: true, description: '终止进程 Windows（safe:需确认 / standard:自动放行）' },
  { name: 'ask-chmod',    command: 'chmod',    action: 'ask',  priority: 30, enabled: true, description: '修改权限（safe:需确认 / standard:自动放行）' },
  { name: 'ask-chown',    command: 'chown',    action: 'ask',  priority: 30, enabled: true, description: '修改属主（safe:需确认 / standard:自动放行）' },

  // ── 常用命令：所有模式直接放行 ──
  { name: 'allow-ls',    command: 'ls',    action: 'allow', priority: 200, enabled: true },
  { name: 'allow-dir',   command: 'dir',   action: 'allow', priority: 200, enabled: true },
  { name: 'allow-cat',   command: 'cat',   action: 'allow', priority: 200, enabled: true },
  { name: 'allow-echo',  command: 'echo',  action: 'allow', priority: 200, enabled: true },
  { name: 'allow-grep',  command: 'grep',  action: 'allow', priority: 200, enabled: true },
  { name: 'allow-find',  command: 'find',  action: 'allow', priority: 200, enabled: true },
  // Interpreters can access arbitrary files and sockets from a host process;
  // a working directory is not an operating-system sandbox. Require explicit
  // approval in safe mode before they execute.
  { name: 'confirm-node', command: 'node', action: 'ask', priority: 40, enabled: true, description: '解释器需显式确认' },
  { name: 'confirm-npm',  command: 'npm',  action: 'ask', priority: 40, enabled: true, description: '包管理器需显式确认' },
  { name: 'confirm-npx',  command: 'npx',  action: 'ask', priority: 40, enabled: true, description: '包执行器需显式确认' },

  // ── 兜底：safe 下 ask 确认，standard 下自动升为 allow（陌生命令直接跑） ──
  { name: 'default-ask', command: '*', action: 'ask', priority: 999, enabled: true, description: '兜底：safe=询问用户 / standard=自动放行' },
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

// ─── 文件删除硬拦截 ─────────────────────────────────────────────────────────
/**
 * 删除文件/目录必须走记录式删除工具（delete_file）：它写入文件改动记录并
 * 进入用户确认队列，可撤回。通过 shell/脚本删除（rm/del/Remove-Item/
 * fs.rmSync/os.remove 等）完全绕过该管线——删除不可撤回，改动面板里还会
 * 留下断链的 ⚠ 记录。因此删除类命令在所有安全模式下（含 full-access 与
 * 已审批命令）一律硬拒绝，并引导到 delete_file。
 */
const DELETE_COMMANDS = new Set([
  'rm', 'unlink', 'rmdir', 'shred',                                    // POSIX
  'del', 'erase', 'rd',                                                // cmd
  'remove-item', 'remove-itemproperty', 'ri',                          // PowerShell
])

/** node/python 等解释器参数里内联执行的删除调用（fs.rmSync / os.remove 等） */
const INLINE_DELETE_PATTERNS = [
  /\bfs\s*\.\s*(?:rm|rmSync|rmdir|rmdirSync|unlink|unlinkSync)\s*\(/,
  /\b(?:rmSync|rmdirSync|unlinkSync)\s*\(/,
  /\bos\s*\.\s*(?:remove|unlink|rmdir|removedirs)\s*\(/,
  /\bshutil\s*\.\s*rmtree\s*\(/,
  /\bRemove-Item(?:Property)?\b/i,
]

function inlineDeleteHits(args: string[]): string[] {
  const hits: string[] = []
  for (const a of args) {
    if (typeof a !== 'string' || a.length < 8) continue
    if (INLINE_DELETE_PATTERNS.some(re => re.test(a))) hits.push(a.slice(0, 120))
  }
  return hits
}

export const DELETE_COMMAND_REDIRECT =
  '删除文件必须通过 delete_file 工具完成（它会记录改动并交给用户确认，可撤回）；不允许通过命令行或脚本删除文件。请改用 delete_file。'

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
   *
   * 各模式最终行为：
   *  - safe:        完整策略 + 注入检测 deny；高危命令 deny；未知命令 ask。
   *  - standard:    注入检测降为 ask（让用户自决）；deny 规则降为 ask；ask 规则升为 allow。
   *                 效果：能放行的全放行，不确定的弹确认框，零硬报错。
   *  - full-access: 跳过所有检查，全部放行，仅写审计日志。
   */
  async evaluate(input: PolicyDecisionInput): Promise<PolicyDecision> {
    await seedDefaultsIfEmpty()
    const cmd  = baseName(input.command).toLowerCase()
    const args = input.args ?? []
    const mode = getSecurityMode(input.tenantId ?? 'default', input.sessionId ?? '')

    // -1) 删除类操作硬拦截：所有模式（含 full-access / 已审批命令）一律拒绝。
    //     删除必须走 delete_file 工具进入改动记录与用户确认管线，可撤回。
    //     a) 命令本身即删除命令（剥掉 .exe/.cmd/.bat/.ps1 扩展名后匹配）；
    //     b) git clean 子命令；c) 解释器参数内联删除。
    const cmdBare = cmd.replace(/\.(?:exe|cmd|bat|ps1|com)$/i, '')
    const inlineHits = inlineDeleteHits(args)
    const isGitClean = cmdBare === 'git' && args.some(a => /^clean$/i.test(a))
    if (DELETE_COMMANDS.has(cmdBare) || isGitClean || inlineHits.length > 0) {
      const target = isGitClean ? 'git clean' : inlineHits.length > 0 ? `内联删除调用: ${inlineHits.join(' | ')}` : cmd
      const decision: PolicyDecision = { action: 'deny', reason: DELETE_COMMAND_REDIRECT }
      await auditLogStore.append({
        tenantId: input.tenantId,
        sessionId: input.sessionId,
        category: 'cmd',
        target,
        decision: 'deny',
        reason: decision.reason,
        details: { securityMode: mode, deleteBlocked: true },
      })
      return decision
    }

    // 0) 如果用户已经审批过该命令，直接放行
    if (input.approved || (!input.ignoreSessionApproval && isCommandApproved(input.tenantId ?? 'default', input.sessionId ?? '', input.command, input.args))) {
      const decision: PolicyDecision = {
        action: 'allow',
        reason: input.approved ? '用户已审批通过当前工具调用' : '用户已在当前会话中审批通过该命令',
      }
      await auditLogStore.append({
        tenantId: input.tenantId,
        sessionId: input.sessionId,
        category: 'cmd',
        target: [cmd, ...args].join(' '),
        decision: 'allow',
        reason: decision.reason,
        details: { securityMode: mode, approvedByAsk: true },
      })
      return decision
    }

    // ── full-access 模式：全部放行，仅记审计 ──
    if (mode === 'full-access') {
      const decision: PolicyDecision = {
        action: 'allow',
        reason: '安全模式: full-access，跳过策略检查',
      }
      await auditLogStore.append({
        tenantId: input.tenantId,
        sessionId: input.sessionId,
        category: 'cmd',
        target: [cmd, ...args].join(' '),
        decision: 'allow',
        reason: decision.reason,
        details: { securityMode: 'full-access' },
      })
      return decision
    }

    // 1) 注入检测
    //    safe 模式：直接 deny（硬拒绝）
    //    standard 模式：降级为 ask，让用户自行判断是否继续
    const injections = detectInjection(args)
    if (injections.length > 0) {
      const action: PolicyAction = mode === 'standard' || (input.background === true && isHostInterpreter(cmd)) ? 'ask' : 'deny'
      const decision: PolicyDecision = {
        action,
        reason: `检测到 shell 元字符/命令注入: ${injections.join(' | ')}`,
        injectionMatches: injections,
      }
      await auditLogStore.append({
        tenantId: input.tenantId,
        sessionId: input.sessionId,
        category: 'cmd',
        target: [cmd, ...args].join(' '),
        decision: action,
        reason: decision.reason,
        details: { injections, securityMode: mode },
      })
      return decision
    }

    // Safe mode cannot make an arbitrary interpreter safe through a command
    // name allow-list. Keep the command available behind the normal approval
    // flow (handled above) and require confirmation for every new invocation.
    // This runs after injection detection so `node -e '...;...'` is denied,
    // rather than downgraded to a mere confirmation request.
    if (mode === 'safe' && isHostInterpreter(cmd)) {
      const decision: PolicyDecision = {
        action: 'ask',
        reason: '解释器/包执行器可访问工作区外文件和网络，安全模式需要逐次确认',
      }
      await auditLogStore.append({
        tenantId: input.tenantId,
        sessionId: input.sessionId,
        category: 'cmd',
        target: [cmd, ...args].join(' '),
        decision: 'ask',
        reason: decision.reason,
        details: { securityMode: mode, hostInterpreter: true },
      })
      return decision
    }

    // 2) 路径穿越检测
    //    safe 模式：ask 确认
    //    standard 模式：直接放行（用户自己承担风险）
    const traversal = detectPathTraversal(args)
    if (traversal.length > 0) {
      const action: PolicyAction = mode === 'standard' ? 'allow' : 'ask'
      const decision: PolicyDecision = {
        action,
        reason: `参数疑似路径穿越: ${traversal.join(' | ')}`,
      }
      await auditLogStore.append({
        tenantId: input.tenantId,
        sessionId: input.sessionId,
        category: 'cmd',
        target: [cmd, ...args].join(' '),
        decision: action,
        reason: decision.reason,
        details: { traversal, securityMode: mode },
      })
      return decision
    }

    // 3) 按 priority 升序匹配规则
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

      let finalAction = r.action
      if (mode === 'standard') {
        // standard 模式：
        //   deny  → ask  （不硬报错，交用户确认）
        //   ask   → allow（常规操作自动放行）
        if (finalAction === 'deny') finalAction = 'ask'
        else if (finalAction === 'ask') finalAction = 'allow'
      }

      let reasonSuffix = ''
      if (mode === 'standard' && r.action !== finalAction) {
        reasonSuffix = ` (standard: ${r.action}→${finalAction})`
      }

      const decision: PolicyDecision = {
        action: finalAction,
        ruleId: r.id,
        ruleName: r.name,
        reason: `命中规则 #${r.id} ${r.name}${reasonSuffix}`,
      }
      await auditLogStore.append({
        tenantId: input.tenantId,
        sessionId: input.sessionId,
        category: 'cmd',
        target: [cmd, ...args].join(' '),
        decision: finalAction,
        ruleId: r.id ?? null,
        reason: decision.reason,
        details: { securityMode: mode },
      })
      return decision
    }

    // 4) 无规则兜底（DEFAULT_RULES 已注入 default-ask，正常不会到达）
    //    standard 下直接放行，safe 下 ask
    const fallbackAction: PolicyAction = mode === 'standard' ? 'allow' : 'ask'
    const decision: PolicyDecision = { action: fallbackAction, reason: `未命中任何策略，${mode === 'standard' ? '自动放行' : '默认询问'}` }
    await auditLogStore.append({
      tenantId: input.tenantId,
      sessionId: input.sessionId,
      category: 'cmd',
      target: [cmd, ...args].join(' '),
      decision: fallbackAction,
      reason: decision.reason,
    })
    return decision
  }
}

function baseName(cmd: string): string {
  return cmd.split(/[/\\]/).pop() ?? cmd
}

function isHostInterpreter(command: string): boolean {
  return new Set([
    'node', 'node.exe', 'npm', 'npm.cmd', 'npx', 'npx.cmd', 'python', 'python.exe',
    'python3', 'python3.exe', 'powershell', 'powershell.exe', 'pwsh', 'pwsh.exe',
    'cmd', 'cmd.exe', 'bash', 'bash.exe', 'sh', 'zsh', 'wsl', 'wsl.exe',
    'ruby', 'perl', 'java', 'dotnet', 'deno', 'bun', 'go'
  ]).has(command.toLowerCase())
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
