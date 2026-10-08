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
 *
 *  - Windows 下声明 PYTHONUTF8=1 / PYTHONIOENCODING=utf-8 / LANG=C.UTF-8
 *    让 bash 拉起的 python 子进程默认按 UTF-8 编解码，避免 GBK 乱码
 *    fromfile_prefix_chars='@'，但多数 skill 脚本，
 *    会把 @path 当成普通参数导致解析错误
 */

import { exec } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'
import type { Tool, ToolResult } from '../../core/agent-context/index.js'
import { extensionPolicy } from '../../security/tool-policy.js'
import { globalSkillsRoot } from '../../skills/import-pipeline.js'
import { projectSkillRoots } from '../../skills/project-skills.js'
import { projectDataPath } from '../../core/project-storage.js'

const DEFAULT_TIMEOUT_MS = 60_000 // 技能脚本可能需要较长时间（如浏览器操作）

/** Resolve the layer containing the skill named in a `$SKILLS_ROOT/...` path. */
export function resolveSkillRoot(command: string, projectRoot?: string): string {
  const candidates = [
    ...projectSkillRoots(projectRoot ?? process.cwd()),
    process.env.SKILLS_ROOT ? path.resolve(process.cwd(), process.env.SKILLS_ROOT) : '',
    globalSkillsRoot(),
  ].filter((candidate, index, all): candidate is string => Boolean(candidate) && all.indexOf(candidate) === index)
  const skillMatch = command.match(/\$SKILLS_ROOT[\\/]([^\s/\\"']+)/)
  const matchingRoot = skillMatch
    ? candidates.find((candidate) => fs.existsSync(path.join(candidate, skillMatch[1])))
    : undefined
  return matchingRoot ?? candidates.find((candidate) => fs.existsSync(candidate)) ?? projectDataPath(projectRoot ?? process.cwd(), 'skills')
}

export const runSkillScriptTool: Tool & { source: string } = {
  name: 'run_skill_script',
  displayName: '运行技能脚本',
  description:
    '执行技能目录中的 bash/shell 脚本。' +
    '当 SKILL.md 指示运行 bash 命令（如 `bash "$SKILLS_ROOT/web-search/scripts/search.sh" "query"`）时使用。' +
    '工具会自动注入 SKILLS_ROOT 环境变量。',
  source: 'skill',
  preflight: async (_args, ctx) => extensionPolicy(ctx),
  parameters: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description:
          '要执行的完整 Shell 命令，必须与 SKILL.md 中展示的格式完全一致。' +
          '示例：`bash "$SKILLS_ROOT/web-search/scripts/search.sh" "TypeScript 5 features" 10`',
      },
      timeoutMs: {
        type: 'number',
        description: '执行超时时间（毫秒，默认 60000）。对于基于浏览器的长时任务可以调大此值。',
      },
    },
    required: ['command'],
  },

  async execute(rawArgs, ctx): Promise<ToolResult> {
    const blocked = extensionPolicy(ctx)
    if (blocked) return blocked
    const { command, timeoutMs = DEFAULT_TIMEOUT_MS } = rawArgs as {
      command: string
      timeoutMs?: number
    }

    // Resolve the skill layer that actually contains the requested script. A
    // process may have deployment built-ins in SKILLS_ROOT plus project/global
    // user skills; always using env SKILLS_ROOT made imported skills invisible
    // to run_skill_script.
    const skillsRoot = resolveSkillRoot(command, ctx.projectRoot)

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
    // 不转义空格：命令里的 $SKILLS_ROOT 通常在引号内（"$SKILLS_ROOT/..."），
    // bash 引号会正确处理空格，\ 转义反而会被当成字面量导致路径错误
    const resolvedCommand = command.replace(/\$SKILLS_ROOT/g, normalizedRoot)

    return new Promise((resolve) => {
      exec(
        resolvedCommand,
        {
          cwd: skillsRoot,
          timeout: timeoutMs,
          maxBuffer: 10 * 1024 * 1024,
          encoding: 'utf8',
          env: {
            ...process.env,
            SKILLS_ROOT: normalizedRoot,
            BASH_PATH: bashPath,
            // Windows 编码：参考 CodexAppServerManager，让 bash 拉起的 python 子进程按 UTF-8 编解码
            ...(isWindows
              ? {
                  PYTHONUTF8: '1',
                  PYTHONIOENCODING: 'utf-8',
                  LANG: process.env.LANG ?? 'C.UTF-8',
                  LC_ALL: process.env.LC_ALL ?? 'C.UTF-8',
                }
              : {}),
          },
          shell: bashPath,
        },
        (err, stdout, stderr) => {
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
