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
  description: '静态诊断：TypeScript 支持 .ts/.tsx/.mts/.cts；ESLint 支持 .js/.jsx/.ts/.tsx/.mjs/.cjs，需项目安装 ESLint 且配置可用。不支持 HTML、CSS 或 HTML 内联脚本，也不验证浏览器渲染/交互；不要把 unsupported 当作代码错误或验证通过。',
  parameters: {
    type: 'object',
    properties: {
      filePath: { type: 'string', description: '支持的 TypeScript/JavaScript 文件路径（相对 workspace 或绝对路径）；不支持 .html/.css。' },
      content: { type: 'string', description: '可选：未保存的文件内容，传入则优先使用' },
      adapters: { type: 'array', items: { type: 'string', enum: ['typescript', 'eslint'] }, description: '指定适配器；不传时运行支持当前后缀且可用的适配器。ESLint 需要项目配置；指定但不可用时返回 unsupported。' },
    },
    required: ['filePath'],
  },
  async execute(rawArgs: unknown, ctx: AgentContext): Promise<ToolResult> {
    const { filePath, content, adapters } = rawArgs as { filePath: string; content?: string; adapters?: string[] }
    try {
      const abs = typeof workspaceManager.resolveSafePath === 'function'
        ? workspaceManager.resolveSafePath(ctx, filePath)
        : path.resolve(workspaceManager.getWorkingDirectory(ctx), filePath)

      const result = await diagnoseFile(abs, {
        content,
        adapters,
        signal: ctx.signal,
        tenantId: ctx.tenantId,
        sessionId: ctx.sessionId,
      })

      if (result.status === 'unsupported') {
        const isHtml = /\.html?$/i.test(abs)
        return {
          success: false,
          error: 'DIAGNOSTIC_UNSUPPORTED',
          output: [
            `DIAGNOSTIC_UNSUPPORTED: ${result.error ?? '当前文件没有可用的诊断适配器'}`,
            '支持范围：TypeScript (.ts/.tsx/.mts/.cts)；ESLint (.js/.jsx/.ts/.tsx/.mjs/.cjs，需项目安装和配置)。',
            '未执行静态诊断；这不表示代码有误，也不表示检查通过。',
            isHtml
              ? 'HTML/内联脚本请使用项目现有 HTML 检查或构建命令；可提取内联 JavaScript 后使用已确认可用的 Node 做语法检查（需保留脚本的 classic/module 类型）。语法检查不覆盖 DOM、Canvas、布局或交互；这些需要可用的浏览器工具或端到端测试。不要为通过检查盲目改后缀。'
              : '使用项目现有的检查/构建/测试命令；如需 ESLint，先确认项目安装和配置，或选择受支持且可用的适配器。不要反复提交相同的不支持请求。',
          ].join('\n'),
          metadata: { diagnosticStatus: 'unsupported', code: 'DIAGNOSTIC_UNSUPPORTED', validationPerformed: false },
        }
      }

      if (result.status !== 'completed') {
        return {
          success: false,
          output: result.error ?? `诊断未完成: ${result.status}`,
          error: result.error ?? result.status,
          metadata: { diagnosticStatus: result.status },
        }
      }

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
