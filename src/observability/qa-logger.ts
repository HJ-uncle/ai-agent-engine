import fs from 'node:fs'
import path from 'node:path'

export interface QALogEntry {
  sessionId: string
  conversationId: string
  requestId: string
  tenantId: string
  userMessage: string
  assistantResponse: string
  reasoningContent?: string
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
    
    md += `#### 👤 用户问题 (User)\n\`\`\`text\n${entry.userMessage}\n\`\`\`\n`
    
    if (entry.history && entry.history.length > 0) {
      md += `\n#### 📜 历史上下文详情 (History Details)\n`
      md += `<details>\n<summary>点击展开查看 ${entry.history.length} 条历史消息</summary>\n\n`
      entry.history.forEach((msg, idx) => {
        const roleIcon = msg.role === 'user' ? '👤' : msg.role === 'assistant' ? '🤖' : '🛠️'
        md += `**[${idx + 1}] ${roleIcon} ${msg.role.toUpperCase()}** (${msg.tokens || 0} tokens)\n`
        md += `\`\`\`text\n${msg.content.slice(0, 500)}${msg.content.length > 500 ? '...' : ''}\n\`\`\`\n`
      })
      md += `</details>\n`
    }

    if (entry.reasoningContent) {
      md += `\n#### 🧠 思考过程 (Reasoning)\n> ${entry.reasoningContent.split('\n').join('\n> ')}\n`
    }

    if (entry.toolCalls && entry.toolCalls.length > 0) {
      md += `\n#### 🛠️ 工具调用 (Tool Calls)\n`
      entry.toolCalls.forEach((tool, index) => {
        const status = tool.success ? '✅' : '❌'
        md += `**${index + 1}. ${tool.name}** ${status}\n`
        md += `- **参数**: \`${JSON.stringify(tool.arguments)}\`\n`
        md += `- **输出**: \n\`\`\`text\n${String(tool.output).slice(0, 1000)}${String(tool.output).length > 1000 ? '...' : ''}\n\`\`\`\n`
      })
    }

    md += `\n#### 🤖 助手回答 (Assistant)\n${entry.assistantResponse}\n`
    
    if (entry.usage) {
      const u = entry.usage
      md += `\n#### ⚡ Token 详情\n`
      md += `| 类别 | 消耗 (Tokens) |\n`
      md += `| :--- | :--- |\n`
      md += `| � 系统提示词 | ${u.systemPromptTokens} |\n`
      md += `| 🔵 历史消息 | ${u.messagesTokens} |\n`
      md += `| 🟣 技能/工具 | ${u.skillTokens} |\n`
      md += `| 🟡 系统工具 | ${u.systemToolsTokens} |\n`
      md += `| 🔴 生成内容 | ${u.completionTokens} |\n`
      md += `| **输入 (Prompt)** | **${u.promptTokens}** |\n`
      md += `| **输出 (Completion)** | **${u.completionTokens}** |\n`
      md += `| **总计** | **${u.totalTokens}** |\n`
    }

    return md
  }
}
