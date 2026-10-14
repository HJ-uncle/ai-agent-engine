import type { Tool, AgentContext, ToolResult } from '../../core/agent-context/index.js'
import path from 'path'
import fs from 'fs'
import { cmdTool } from '../cmd/execute-command.js'

/**
 * Install Package 工具
 *
 * 在工作区目录安装 npm 包，带有安全确认机制
 */
export const installPackageTool: Tool = {
  name: 'install_package',
  displayName: '安装 npm 包',
  description: '安装 npm 包。首次调用返回确认信息，confirm=true 时执行安装',
  parameters: {
    type: 'object',
    properties: {
      packageName: { type: 'string', description: '包名，如 lodash 或 lodash@4.17.21' },
      version: { type: 'string' },
      global: { type: 'boolean' },
      saveDev: { type: 'boolean', description: '--save-dev' },
      installPath: { type: 'string' },
      timeoutMs: { type: 'integer', minimum: 0, description: '可选安装超时毫秒数；省略或 0 表示直到完成或取消' },
      confirm: { type: 'boolean', description: '确认后设为 true 执行' }
    },
    required: ['packageName']
  },
  async execute(rawArgs: unknown, ctx: AgentContext): Promise<ToolResult> {
    const { packageName, version, global = false, saveDev = false, installPath, timeoutMs, confirm = false } = rawArgs as any

    try {
      if (typeof packageName !== 'string' || !packageName.trim() || packageName.includes('\0')
        || (version !== undefined && (typeof version !== 'string' || version.includes('\0')))
        || (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0))) {
        return { success: false, error: 'INSTALL_INVALID_ARGUMENTS', output: '安装参数无效：packageName 必填，timeoutMs 必须是非负整数。' }
      }
      let fullPackageName = packageName
      if (version && !packageName.includes('@')) {
        fullPackageName = `${packageName}@${version}`
      }

      const targetPath = installPath || ctx.workspaceDir

      if (!fs.existsSync(targetPath)) {
        return {
          success: false,
          output: `❌ 安装路径不存在: ${targetPath}`
        }
      }

      // 安全确认机制
      if (!confirm) {
        const commandPreview = global
          ? `npm install -g ${fullPackageName}`
          : `cd "${targetPath}" && npm install ${saveDev ? '--save-dev ' : ''}${fullPackageName}`

        const warning = global ? '⚠️ 注意：全局安装需要管理员权限，可能会影响系统环境' : ''

        const confirmationMessage = [
          `⚠️ **安全确认**`,
          ``,
          `你即将执行以下 npm 安装操作：`,
          ``,
          `**操作详情**`,
          `- 包名: \`${fullPackageName}\``,
          `- 安装位置: ${global ? '全局' : targetPath}`,
          `- 类型: ${saveDev ? '开发依赖' : '生产依赖'}`,
          ``,
          `**执行命令**`,
          `\`\`\``,
          commandPreview,
          `\`\`\``,
          ``,
          warning,
          ``,
          `**确认安装**`,
          `请确认是否继续安装此包。为了安全，请确保你信任该包及其来源。`,
          ``,
          `如需继续，请调用：`,
          `\`\`\``,
          `install_package({ packageName: "${fullPackageName}", confirm: true })`,
          `\`\`\``,
        ].filter(Boolean).join('\n')

        ctx.logger.info(`[install_package] Awaiting confirmation for ${fullPackageName}`)

        return {
          success: false,
          output: confirmationMessage
        }
      }

      ctx.logger.info(`[install_package] Installing ${fullPackageName} to ${targetPath}`)

      const timeout = typeof timeoutMs === 'number' && timeoutMs > 0 ? Math.floor(timeoutMs) : undefined
      const args = ['install', ...(global ? ['-g'] : []), ...(saveDev ? ['--save-dev'] : []), fullPackageName]
      const result = await cmdTool.execute({ command: 'npm', args, cwd: targetPath, ...(timeout !== undefined ? { timeoutMs: timeout } : {}), background: false }, ctx)
      if (ctx.signal?.aborted) throw ctx.signal.reason ?? new Error('Installation cancelled')
      if (!result.success) return { ...result, output: `❌ 安装失败：${result.output ?? result.error ?? 'npm install failed'}` }
      ctx.logger.info(`[install_package] Successfully installed ${fullPackageName}`)
      return { success: true, output: [`✅ 包安装成功！`, ``, `**安装信息**`, `- 包名: ${fullPackageName}`, `- 安装路径: ${global ? '全局' : targetPath}`, `- 作为开发依赖: ${saveDev ? '是' : '否'}`, ``, result.output ?? ''].join('\n') }
    } catch (err: any) {
      if (ctx.signal?.aborted) throw ctx.signal.reason ?? err
      ctx.logger.error(`[install_package] Failed to install ${packageName}: ${err.message}`)
      return {
        success: false,
        output: `❌ 安装失败: ${err.message}`
      }
    }
  }
}

export const listPackagesTool: Tool = {
  name: 'list_packages',
  displayName: '列出已安装的包',
  description: '列出工作区已安装的 npm 包',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: '工作区路径，默认为当前工作区目录'
      },
      global: {
        type: 'boolean',
        description: '是否列出全局安装的包，默认 false'
      }
    },
    required: []
  },
  async execute(rawArgs: unknown, ctx: AgentContext): Promise<ToolResult> {
    const { path: pkgPath, global = false } = rawArgs as any

    try {
      const targetPath = pkgPath || ctx.workspaceDir

      if (!fs.existsSync(targetPath)) {
        return {
          success: false,
          output: `❌ 目录不存在: ${targetPath}`
        }
      }

      const packageJsonPath = path.join(targetPath, 'package.json')

      if (!fs.existsSync(packageJsonPath)) {
        return {
          success: false,
          output: `❌ package.json 不存在: ${packageJsonPath}\n\n请先在工作区初始化 npm: cd "${targetPath}" && npm init`
        }
      }

      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'))

      const output: string[] = [
        `## 📦 已安装的包`,
        ``,
        `**目录**: ${targetPath}`,
        ``,
      ]

      if (packageJson.dependencies) {
        const deps = Object.entries(packageJson.dependencies)
        if (deps.length > 0) {
          output.push(`### 生产依赖 (${deps.length} 个)`)
          output.push(`| 包名 | 版本 |`)
          output.push(`|------|------|`)
          for (const [name, ver] of deps) {
            output.push(`| ${name} | ${ver} |`)
          }
          output.push('')
        }
      }

      if (packageJson.devDependencies) {
        const devDeps = Object.entries(packageJson.devDependencies)
        if (devDeps.length > 0) {
          output.push(`### 开发依赖 (${devDeps.length} 个)`)
          output.push(`| 包名 | 版本 |`)
          output.push(`|------|------|`)
          for (const [name, ver] of devDeps) {
            output.push(`| ${name} | ${ver} |`)
          }
          output.push('')
        }
      }

      if (!packageJson.dependencies && !packageJson.devDependencies) {
        output.push(`暂无已安装的包`)
      }

      return {
        success: true,
        output: output.join('\n')
      }
    } catch (err: any) {
      ctx.logger.error(`[list_packages] Failed to list packages: ${err.message}`)
      return {
        success: false,
        output: `❌ 列出包失败: ${err.message}`
      }
    }
  }
}
