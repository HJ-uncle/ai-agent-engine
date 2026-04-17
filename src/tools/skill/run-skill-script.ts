/**
 * run_skill_script 工具
 *
 * 专为外部 Skill 脚本设计：
 *  - 自动注入 SKILLS_ROOT 环境变量
 *  - 支持 shell 展开（$SKILLS_ROOT、管道、重定向等）
 *  - cwd 设置为 SKILLS_ROOT，而非受限的 workspace 沙箱
 *  - 继承宿主机完整 PATH（Playwright、Node、Python 等）
 *
 * 与 execute_cmd 的区别：
 *  - execute_cmd 面向通用沙箱命令（白名单保护）
 *  - run_skill_script 面向可信技能脚本（SKILLS_ROOT 内的脚本）
 */

import { exec } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'
import type { Tool, ToolResult } from '../../core/agent-context/index.js'

const DEFAULT_TIMEOUT_MS = 60_000  // 技能脚本可能需要较长时间（如浏览器操作）

export const runSkillScriptTool: Tool = {
  name: 'run_skill_script',
  description:
    'Execute a skill script (bash/shell command) from the skills directory. ' +
    'Use this tool when a skill\'s SKILL.md instructs you to run a bash command ' +
    'like `bash "$SKILLS_ROOT/web-search/scripts/search.sh" "query"`. ' +
    'The SKILLS_ROOT environment variable is automatically injected.',
  parameters: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description:
          'The full shell command to execute, exactly as shown in SKILL.md. ' +
          'Example: `bash "$SKILLS_ROOT/web-search/scripts/search.sh" "TypeScript 5 features" 10`',
      },
      timeoutMs: {
        type: 'number',
        description: 'Timeout in milliseconds (default 60000). Increase for browser-based skills.',
      },
    },
    required: ['command'],
  },

  async execute(rawArgs): Promise<ToolResult> {
    const { command, timeoutMs = DEFAULT_TIMEOUT_MS } = rawArgs as {
      command: string
      timeoutMs?: number
    }

    // 解析 SKILLS_ROOT 路径
    const rawRoot = process.env.SKILLS_ROOT ?? './skills'
    const skillsRoot = path.resolve(process.cwd(), rawRoot)

    if (!fs.existsSync(skillsRoot)) {
      return {
        success: false,
        output: `SKILLS_ROOT directory not found: ${skillsRoot}`,
      }
    }

    const startTime = Date.now()
    const normalizedRoot = skillsRoot.replace(/\\/g, '/')
    const isWindows = process.platform === 'win32'
    const bashPath = process.env.BASH_PATH ?? (isWindows ? 'bash' : '/bin/bash')

    // 替换 $SKILLS_ROOT → 绝对路径（Git Bash 支持正斜杠路径）
    let resolvedCommand = command
      .replace(/\$SKILLS_ROOT/g, normalizedRoot.replace(/ /g, '\\ '))  // 空格转义

    // 检测命令中是否有非 ASCII 字符（中文/日文等）
    // 若有，将查询内容写入临时文件，用 @file 方式传入，避免 shell 编码问题
    const hasNonAscii = /[^\x00-\x7F]/.test(resolvedCommand)
    let tmpFile: string | null = null

    if (hasNonAscii && isWindows) {
      // 提取查询字符串（通常是第一个带引号的参数）
      const queryMatch = resolvedCommand.match(/["']([^"']*[^\x00-\x7F][^"']*)["']/)
      if (queryMatch) {
        const query = queryMatch[1]
        tmpFile = path.join(skillsRoot, `.tmp_query_${Date.now()}.txt`)
        fs.writeFileSync(tmpFile, query, 'utf-8')
        // 替换引号参数为 @文件路径（SKILL.md 规定的非 ASCII 输入方式）
        const tmpFileUnix = tmpFile.replace(/\\/g, '/')
        resolvedCommand = resolvedCommand.replace(queryMatch[0], `@${tmpFileUnix}`)
      }
    }

    return new Promise((resolve) => {
      exec(
        resolvedCommand,
        {
          cwd: skillsRoot,
          timeout: timeoutMs,
          maxBuffer: 10 * 1024 * 1024,
          env: {
            ...process.env,
            SKILLS_ROOT: normalizedRoot,
            BASH_PATH: bashPath,
          },
          shell: bashPath,
        },
        (err, stdout, stderr) => {
          // 清理临时文件
          if (tmpFile && fs.existsSync(tmpFile)) {
            try { fs.unlinkSync(tmpFile) } catch { /* ignore */ }
          }

          const durationMs = Date.now() - startTime
          const output = [stdout, stderr].filter(Boolean).join('\n').trim()

          if (err && err.killed) {
            resolve({ success: false, output: `Command timed out after ${timeoutMs}ms`, durationMs })
            return
          }

          resolve({
            success: !err,
            output: output || (err ? `Error: ${err.message}` : 'Command completed with no output'),
            durationMs,
          })
        },
      )
    })
  },
}
