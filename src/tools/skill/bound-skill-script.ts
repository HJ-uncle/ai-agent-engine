import fs from 'node:fs'
import path from 'node:path'
import type { Tool, ToolResult } from '../../core/agent-context/types.js'
import type { ExternalSkill } from '../../skills/external-loader.js'
import { runSkillScript, runSkillScriptTool, resolveSkillRoot } from './run-skill-script.js'
import { invocationTokens } from './script-invocation.js'

const interpreters = new Set(['bash', 'sh', 'node', 'python', 'python3', 'ruby', 'perl'])

/** A custom-Agent binding authorizes selected scripts, not arbitrary shell commands or other installed skills. */
export function createBoundSkillScriptTool(skills: readonly ExternalSkill[]): Tool & { source: string } {
  const blocked = (reason: string): ToolResult => ({ success: false, output: reason,
    metadata: { blocked: true, code: 'SKILL_BINDING_REQUIRED' } })
  return {
    ...runSkillScriptTool,
    description: '执行此 Agent 已绑定技能中的实际脚本。使用单条 bash/sh/node/python/python3/ruby/perl + 脚本路径 + 参数调用；路径使用绝对路径或 $SKILLS_ROOT/技能目录/...，脚本必须在已绑定技能目录内。不接受管道、重定向、命令拼接或解释器 -c/-e。',
    async execute(raw, ctx) {
      const args = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
      const command = typeof args.command === 'string' ? args.command : ''
      const tokens = invocationTokens(command)
      if (!tokens || tokens.length < 2 || !interpreters.has(tokens[0]) || tokens[1].startsWith('-')) {
        return blocked('请选择已绑定技能中的脚本，使用单条「解释器 脚本路径 参数」调用。通用命令应使用 execute_cmd。')
      }
      const rawPath = tokens[1].replace(/\$SKILLS_ROOT/g, () => resolveSkillRoot(command, ctx.projectRoot))
      let scriptPath: string
      try { scriptPath = fs.realpathSync(path.resolve(rawPath)) }
      catch { return blocked('技能脚本不存在，未启动任何进程。') }
      const allowed = skills.some(skill => {
        if (!skill.skillMdPath) return false
        try {
          const root = fs.realpathSync(path.dirname(skill.skillMdPath))
          const relative = path.relative(root, scriptPath)
          return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)
        } catch { return false }
      })
      if (!allowed || !fs.statSync(scriptPath).isFile()) return blocked('此脚本不属于当前 Agent 已绑定的技能，未启动任何进程。')
      return runSkillScript(args, ctx, [tokens[0], scriptPath.replace(/\\/g, '/'), ...tokens.slice(2)])
    },
  }
}
