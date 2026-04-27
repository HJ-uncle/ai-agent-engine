import type { Tool, AgentContext, ToolResult } from '../../core/agent-context/index.js'
import { exec } from 'child_process'
import { promisify } from 'util'
import path from 'path'
import fs from 'fs'

const execAsync = promisify(exec)

/**
 * Install Package 工具
 *
 * 在工作区目录安装 npm 包，带有安全确认机制
 */
export const installPackageTool: Tool = {
  name: 'install_package',
  displayName: '安装 npm 包',
  description: '在工作区目录安装 npm 包，支持指定版本和全局安装。出于安全考虑，执行前需要用户确认。',
  parameters: {
    type: 'object',
    properties: {
      packageName: {
        type: 'string',
        description: '要安装的包名（必填），如 "lodash" 或 "lodash@4.17.21"'
      },
      version: {
        type: 'string',
        description: '指定版本，如 "4.17.21"，与 packageName 中的版本互斥'
      },
      global: {
        type: 'boolean',
        description: '是否全局安装，默认 false'
      },
      saveDev: {
        type: 'boolean',
        description: '是否作为开发依赖安装（--save-dev），默认 false'
      },
      installPath: {
        type: 'string',
        description: '安装路径，默认为当前工作区目录'
      },
      confirm: {
        type: 'boolean',
        description: '是否已确认安装（安全机制），默认 false。首次调用时工具会返回确认信息，用户确认后设置为 true 再调用以执行安装'
      }
    },
    required: ['packageName']
  },
  async execute(rawArgs: unknown, ctx: AgentContext): Promise<ToolResult> {
    const { packageName, version, global = false, saveDev = false, installPath, confirm = false } = rawArgs as any

    try {
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

      // 用户已确认，执行安装
      let command: string
      if (global) {
        command = `npm install -g ${fullPackageName}`
      } else {
        command = `cd "${targetPath}" && npm install ${saveDev ? '--save-dev ' : ''}${fullPackageName}`
      }

      ctx.logger.info(`[install_package] Installing ${fullPackageName} to ${targetPath}`)

      const timeout = 120000

      try {
        const { stdout, stderr } = await execAsync(command, { timeout, cwd: targetPath })

        const successOutput = [
          `✅ 包安装成功！`,
          ``,
          `**安装信息**`,
          `- 包名: ${fullPackageName}`,
          `- 安装路径: ${global ? '全局' : targetPath}`,
          `- 作为开发依赖: ${saveDev ? '是' : '否'}`,
          ``,
        ]

        if (stdout) {
          successOutput.push(`**安装日志**`)
          successOutput.push('```')
          successOutput.push(stdout.slice(-1000))
          successOutput.push('```')
        }

        if (stderr && !stderr.includes('npm warn')) {
          successOutput.push(`**警告**`)
          successOutput.push('```')
          successOutput.push(stderr.slice(-500))
          successOutput.push('```')
        }

        ctx.logger.info(`[install_package] Successfully installed ${fullPackageName}`)

        return {
          success: true,
          output: successOutput.join('\n')
        }
      } catch (execErr: any) {
        const errorMessage = execErr.message || ''

        if (errorMessage.includes('ENOTEMPTY') || errorMessage.includes('ETIMEDOUT') || execErr.code === 'ETIMEDOUT') {
          return {
            success: false,
            output: `❌ 包安装超时（超过 ${timeout / 1000} 秒）\n\n可能的原因：\n- 网络连接缓慢\n- 包体积较大\n- npm 仓库响应慢\n\n建议：\n1. 稍后重试\n2. 检查网络连接\n3. 尝试使用国内镜像：npm install ${fullPackageName} --registry=https://registry.npmmirror.com`
          }
        }

        if (errorMessage.includes('E404') || errorMessage.includes('404 Not Found')) {
          return {
            success: false,
            output: `❌ 包未找到: ${fullPackageName}\n\n请检查：\n1. 包名拼写是否正确\n2. 包是否已发布到 npm\n3. 是否使用了私有包（需要配置 .npmrc）`
          }
        }

        if (errorMessage.includes('EACCES')) {
          return {
            success: false,
            output: `❌ 权限被拒绝\n\n无法在 ${targetPath} 写入文件。\n\n解决方案：\n1. 检查目录权限\n2. 使用全局安装: install_package({ packageName: "${fullPackageName}", global: true, confirm: true })\n3. 使用 sudo（不推荐）`
          }
        }

        if (errorMessage.includes('ENOENT')) {
          return {
            success: false,
            output: `❌ 目录不存在: ${targetPath}\n\n请确保工作区目录存在，或指定正确的 installPath`
          }
        }

        throw execErr
      }
    } catch (err: any) {
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
