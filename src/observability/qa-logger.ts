import fs from 'node:fs'
import path from 'node:path'

// ── QA 日志截断开关 ────────────────────────────────────────────────────────────
// 设为 true  → 各内容节超出限制时自动截断，适合日常观察
// 设为 false → 完整记录所有内容，适合精准分析（文件体积会更大）
const QA_LOG_TRUNCATE = false

// 各内容节截断长度（仅在 QA_LOG_TRUNCATE = true 时生效）
const TRUNCATE_LIMITS = {
  systemPrompt:  2000,
  ragContent:    2000,
  skillPrompt:   2000,
  builtinTools:  3000,
  mcpTools:      3000,
  historyMsg:    500,
  toolOutput:    1000,
} as const

/** 根据开关决定是否截断文本 */
function maybeTruncate(text: string, limit: number): string {
  if (!QA_LOG_TRUNCATE || text.length <= limit) return text
  return text.slice(0, limit) + '\n...(内容过长已截断)'
}

export interface QALogEntry {
  sessionId: string
  conversationId: string
  requestId: string
  tenantId: string
  userMessage: string
  assistantResponse: string
  reasoningContent?: string
  /** 系统提示词原文（不含 RAG / Skill 注入部分）*/
  systemPromptContent?: string
  /** RAG 知识库注入内容 */
  ragContent?: string
  /** 技能 Prompt 内容 */
  skillPromptContent?: string
  /** 内置工具定义文本 */
  builtinToolsContent?: string
  /** MCP 工具定义文本 */
  mcpToolsContent?: string
  toolCalls?: Array<{
    name: string
    arguments: any
    output: string
    success: boolean
  }>
  history?: Array<{
    role: string
    content: string
    tokens?: number
  }>
  usage?: {
    systemPromptTokens: number
    systemToolsTokens: number
    messagesTokens: number
    skillTokens: number
    promptTokens: number
    completionTokens: number
    totalTokens: number
    ragTokens?: number
    builtinToolsTokens?: number
    mcpToolsTokens?: number
    toolResultsTokens?: number
    cacheHitTokens?: number
    cacheMissTokens?: number
    reasoningTokens?: number
  }
  createdAt: number
}

/**
 * QALogger handles recording of full Q&A pairs to local Markdown files.
 * This is useful for analysis and optimization of the agent's performance.
 */
export class QALogger {
  private static instance: QALogger
  private logDir: string
  private enabled: boolean

  private constructor() {
    // Load configuration from environment variables
    this.enabled = process.env.QA_LOG_ENABLED === 'true'
    this.logDir = process.env.QA_LOG_DIR ?? path.resolve(process.cwd(), 'logs/qa')
    
    // Ensure log directory exists if enabled
    if (this.enabled && !fs.existsSync(this.logDir)) {
      try {
        fs.mkdirSync(this.logDir, { recursive: true })
      } catch (err) {
        console.error('Failed to create QA log directory:', err)
      }
    }
  }

  public static getInstance(): QALogger {
    if (!QALogger.instance) {
      QALogger.instance = new QALogger()
    }
    return QALogger.instance
  }

  /**
   * Refreshes the enabled state and log directory from environment variables.
   * Useful when settings are updated dynamically.
   */
  public refreshConfig() {
    this.enabled = process.env.QA_LOG_ENABLED === 'true'
    this.logDir = process.env.QA_LOG_DIR ?? path.resolve(process.cwd(), 'logs/qa')
    
    if (this.enabled && !fs.existsSync(this.logDir)) {
      try {
        fs.mkdirSync(this.logDir, { recursive: true })
      } catch (err) {
        console.error('Failed to create QA log directory during refresh:', err)
      }
    }
  }

  /**
   * Logs a Q&A entry to a Markdown file.
   */
  public log(entry: QALogEntry) {
    // Always check the current environment variable to allow dynamic switching
    const isEnabled = process.env.QA_LOG_ENABLED === 'true'
    if (!isEnabled) return

    // Ensure log directory exists (in case it was deleted or config changed)
    if (!fs.existsSync(this.logDir)) {
      try {
        fs.mkdirSync(this.logDir, { recursive: true })
      } catch (err) {
        return
      }
    }

    const date = new Date(entry.createdAt).toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const filename = `qa-${date}-${entry.requestId.slice(0, 8)}.md`
    const filePath = path.join(this.logDir, filename)

    const content = this.formatEntry(entry)
    
    try {
      fs.writeFileSync(filePath, content)
    } catch (err) {
      console.error('Failed to write QA log:', err)
    }
  }

  /**
   * Formats the log entry into a readable Markdown block.
   */
  private formatEntry(entry: QALogEntry): string {
    const time = new Date(entry.createdAt).toLocaleString()
    let md = `### 📝 会话记录 - ${time}\n`
    md += `> **Session ID**: \`${entry.sessionId}\` | **Request ID**: \`${entry.requestId}\` | **Tenant ID**: \`${entry.tenantId}\`\n\n`

    // ── 用户问题 ──────────────────────────────────────────────────────────────
    md += `#### 👤 用户问题 (User)\n\`\`\`text\n${entry.userMessage}\n\`\`\`\n`

    // ── 系统提示词 ────────────────────────────────────────────────────────────
    const sysTokens = entry.usage?.systemPromptTokens ?? 0
    if (entry.systemPromptContent) {
      md += `\n#### 🟣 系统提示词 (System Prompt) — ${sysTokens} tokens\n`
      md += `<details>\n<summary>点击展开查看系统提示词内容</summary>\n\n`
      md += `\`\`\`text\n${maybeTruncate(entry.systemPromptContent, TRUNCATE_LIMITS.systemPrompt)}\n\`\`\`\n`
      md += `</details>\n`
    }

    // ── 知识库 RAG ────────────────────────────────────────────────────────────
    const ragTokens = entry.usage?.ragTokens ?? 0
    if (entry.ragContent && entry.ragContent.trim()) {
      md += `\n#### 🟢 知识库 RAG (Knowledge Base) — ${ragTokens} tokens\n`
      md += `<details>\n<summary>点击展开查看 RAG 注入内容</summary>\n\n`
      md += `\`\`\`text\n${maybeTruncate(entry.ragContent, TRUNCATE_LIMITS.ragContent)}\n\`\`\`\n`
      md += `</details>\n`
    } else if (ragTokens > 0) {
      md += `\n#### 🟢 知识库 RAG (Knowledge Base) — ${ragTokens} tokens\n> (内容未记录)\n`
    }

    // ── 技能 Prompt ───────────────────────────────────────────────────────────
    const skillTokens = entry.usage?.skillTokens ?? 0
    if (entry.skillPromptContent && entry.skillPromptContent.trim()) {
      md += `\n#### 🟣 技能 Prompt (Skill Prompt) — ${skillTokens} tokens\n`
      md += `<details>\n<summary>点击展开查看技能 Prompt 内容</summary>\n\n`
      md += `\`\`\`text\n${maybeTruncate(entry.skillPromptContent, TRUNCATE_LIMITS.skillPrompt)}\n\`\`\`\n`
      md += `</details>\n`
    }

    // ── 内置工具定义 ──────────────────────────────────────────────────────────
    const builtinTokens = entry.usage?.builtinToolsTokens ?? 0
    if (entry.builtinToolsContent && entry.builtinToolsContent.trim()) {
      md += `\n#### 🟡 内置工具 (Builtin Tools) — ${builtinTokens} tokens\n`
      md += `<details>\n<summary>点击展开查看内置工具定义</summary>\n\n`
      md += `\`\`\`text\n${maybeTruncate(entry.builtinToolsContent, TRUNCATE_LIMITS.builtinTools)}\n\`\`\`\n`
      md += `</details>\n`
    }

    // ── MCP 工具定义 ──────────────────────────────────────────────────────────
    const mcpTokens = entry.usage?.mcpToolsTokens ?? 0
    if (entry.mcpToolsContent && entry.mcpToolsContent.trim()) {
      md += `\n#### 🟠 MCP 工具 (MCP Tools) — ${mcpTokens} tokens\n`
      md += `<details>\n<summary>点击展开查看 MCP 工具定义</summary>\n\n`
      md += `\`\`\`text\n${maybeTruncate(entry.mcpToolsContent, TRUNCATE_LIMITS.mcpTools)}\n\`\`\`\n`
      md += `</details>\n`
    }

    // ── 历史上下文 ────────────────────────────────────────────────────────────
    if (entry.history && entry.history.length > 0) {
      md += `\n#### 📜 历史上下文详情 (History Details)\n`
      md += `<details>\n<summary>点击展开查看 ${entry.history.length} 条历史消息</summary>\n\n`
      entry.history.forEach((msg, idx) => {
        const roleIcon = msg.role === 'user' ? '👤' : msg.role === 'assistant' ? '🤖' : '🛠️'
        md += `**[${idx + 1}] ${roleIcon} ${msg.role.toUpperCase()}** (${msg.tokens || 0} tokens)\n`
        md += `\`\`\`text\n${maybeTruncate(msg.content, TRUNCATE_LIMITS.historyMsg)}\n\`\`\`\n`
      })
      md += `</details>\n`
    }

    // ── 思考过程 ──────────────────────────────────────────────────────────────
    if (entry.reasoningContent) {
      md += `\n#### 🧠 思考过程 (Reasoning)\n> ${entry.reasoningContent.split('\n').join('\n> ')}\n`
    }

    // ── 工具调用 ──────────────────────────────────────────────────────────────
    if (entry.toolCalls && entry.toolCalls.length > 0) {
      md += `\n#### 🛠️ 工具调用 (Tool Calls)\n`
      entry.toolCalls.forEach((tool, index) => {
        const status = tool.success ? '✅' : '❌'
        md += `**${index + 1}. ${tool.name}** ${status}\n`
        md += `- **参数**: \`${JSON.stringify(tool.arguments)}\`\n`
        md += `- **输出**: \n\`\`\`text\n${maybeTruncate(String(tool.output), TRUNCATE_LIMITS.toolOutput)}\n\`\`\`\n`
      })
    }

    // ── 助手回答 ──────────────────────────────────────────────────────────────
    md += `\n#### 🤖 助手回答 (Assistant)\n${entry.assistantResponse}\n`
    
    // ── Token 统计 ────────────────────────────────────────────────────────────
    if (entry.usage) {
      const u = entry.usage
      md += `\n#### ⚡ Token 详情\n`
      md += `| 类别 | 消耗 (Tokens) |\n`
      md += `| :--- | :--- |\n`
      md += `| 🟣 系统提示词 | ${u.systemPromptTokens} |\n`
      md += `| 🟢 知识库(RAG) | ${u.ragTokens ?? 0} |\n`
      md += `| 🟣 技能 Prompt | ${u.skillTokens} |\n`
      md += `| 🟡 内置工具 | ${u.builtinToolsTokens ?? 0} |\n`
      md += `| 🟠 MCP 工具 | ${u.mcpToolsTokens ?? 0} |\n`
      md += `| 🔵 历史消息 | ${u.messagesTokens} |\n`
      md += `| 🟣 工具调用结果 | ${u.toolResultsTokens ?? 0} |\n`
      md += `| 🔴 生成内容 | ${u.completionTokens} |\n`
      md += `| **输入 (Prompt)** | **${u.promptTokens}** |\n`
      if (u.cacheHitTokens !== undefined) md += `| &nbsp;&nbsp; └─ 🟢 命中缓存 | ${u.cacheHitTokens} |\n`
      if (u.cacheMissTokens !== undefined) md += `| &nbsp;&nbsp; └─ 🟠 未命中 | ${u.cacheMissTokens} |\n`
      md += `| **输出 (Completion)** | **${u.completionTokens}** |\n`
      if (u.reasoningTokens !== undefined) md += `| &nbsp;&nbsp; └─ 🧠 其中推理 | ${u.reasoningTokens} |\n`
      md += `| **总计** | **${u.totalTokens}** |\n`
    }

    return md
  }
}
