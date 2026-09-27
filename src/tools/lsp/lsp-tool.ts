import path from 'node:path'
import type { Tool, AgentContext, ToolResult } from '../../core/agent-context/index.js'
import { diagnoseFile } from '../../lsp/index.js'
import { workspaceManager } from '../../workspace/index.js'

/**
 * LSP 诊断工具
 *
 * 对单个文件（或传入未保存内容）执行静态分析，返回诊断列表：
 *   - TypeScript 类型/语法错误（内置 tsc API）
 *   - ESLint 代码规范错误（如本地安装了 eslint）
 *
 * AI 可以在"写入代码 → 调用本工具 → 根据诊断自动修复"的闭环中，显著提升代码质量。
 */
export const lspDiagnoseTool: Tool = {
  name: 'code_diagnose',
  displayName: '代码诊断',
  description: '对代码文件执行静态分析（TypeScript / ESLint 等），返回错误 / 警告列表，可用于自动修复循环',
  parameters: {
    type: 'object',
    properties: {
      filePath: { type: 'string', description: '文件路径（相对 workspace 或绝对路径）' },
      content: { type: 'string', description: '可选：未保存的文件内容，传入则优先使用' },
      adapters: { type: 'array', items: { type: 'string' }, description: '指定 adapter（typescript/eslint），不传则全跑' },
    },
    required: ['filePath'],
  },
  async execute(rawArgs: unknown, ctx: AgentContext): Promise<ToolResult> {
    const { filePath, content, adapters } = rawArgs as { filePath: string; content?: string; adapters?: string[] }
    try {
      const cwd = workspaceManager.init(ctx)
      const abs = path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath)

      const result = await diagnoseFile(abs, {
        content,
        adapters,
        signal: ctx.signal,
        tenantId: ctx.tenantId,
        sessionId: ctx.sessionId,
      })

      if (result.diagnostics.length === 0) {
        return {
          success: true,
          output: `✅ 诊断通过（${result.adapter}${result.fromCache ? ', 缓存' : ''}）: ${filePath}`,
        }
      }

      const lines = [
        `📋 诊断结果: ${filePath}`,
        `- 语言: ${result.language}`,
        `- 适配器: ${result.adapter}${result.fromCache ? ' (cache)' : ''}`,
        `- 耗时: ${result.durationMs}ms`,
        `- 问题数: ${result.diagnostics.length}`,
        ``,
      ]
      for (const d of result.diagnostics.slice(0, 200)) {
        const icon = d.severity === 'error' ? '❌' : d.severity === 'warning' ? '⚠️' : 'ℹ️'
        const code = d.code ? ` [${d.code}]` : ''
        lines.push(`${icon} ${d.line}:${d.column} (${d.source}${code}) ${d.message}`)
      }
      if (result.diagnostics.length > 200) {
        lines.push(`... 还有 ${result.diagnostics.length - 200} 条未显示`)
      }
      return { success: true, output: lines.join('\n') }
    } catch (e: any) {
      return { success: false, output: `❌ 诊断失败: ${e.message}` }
    }
  },
}
