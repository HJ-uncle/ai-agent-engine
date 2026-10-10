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

import { spawn } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import type { Tool, ToolResult } from '../../core/agent-context/index.js'
import { extensionPolicy } from '../../security/tool-policy.js'
import { globalSkillsRoot } from '../../skills/import-pipeline.js'
import { projectSkillRoots } from '../../skills/project-skills.js'
import { projectDataPath } from '../../core/project-storage.js'
import { stopCommandProcessTree } from '../../core/command-jobs/process-tree.js'
import { MAX_OPERATION_TIMEOUT_MS, validateOperationTimeout } from '../../core/utils/operation-timeout.js'

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
        type: 'integer', minimum: 0, maximum: MAX_OPERATION_TIMEOUT_MS,
        description: '执行超时时间（毫秒，默认 60000；0 表示不限时）。用户停止会话时仍会取消脚本。',
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
    try { validateOperationTimeout(timeoutMs) } catch (error) {
      return { success: false, status: 'failed', output: String(error instanceof Error ? error.message : error) }
    }
    if (typeof command !== 'string' || !command.trim()) return { success: false, status: 'failed', output: 'command must be a non-empty string' }
    if (ctx.signal?.aborted) return { success: false, status: 'cancelled', output: 'Skill script cancelled before start', error: 'Cancelled' }

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
      // A dedicated process group lets cancellation terminate only this
      // invocation, including scripts that launch their own child processes.
      const child = spawn(bashPath, ['-c', resolvedCommand], {
          cwd: skillsRoot,
          detached: !isWindows,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
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
        })
      // Drain both streams continuously. A verbose script must not die from
      // exec's maxBuffer; keep a bounded preview and disclose any truncation.
      const outputLimit = 10 * 1024 * 1024
      const chunks: string[] = []
      let outputBytes = 0
      let outputTruncated = false
      let archive: fs.WriteStream | undefined
      let outputArchivePath: string | undefined
      let outputArchiveError: string | undefined
      try {
        outputArchivePath = projectDataPath(ctx.projectRoot ?? process.cwd(), 'skill-runs', `${randomUUID()}.log`)
        fs.mkdirSync(path.dirname(outputArchivePath), { recursive: true })
        archive = fs.createWriteStream(outputArchivePath, { flags: 'wx' })
        archive.on('drain', () => { child.stdout.resume(); child.stderr.resume() })
        archive.on('error', error => {
          outputArchiveError = error.message
          child.stdout.resume(); child.stderr.resume()
        })
      } catch (error) { outputArchiveError = error instanceof Error ? error.message : String(error) }
      const capture = (text: string) => {
        if (archive && !archive.destroyed && !archive.write(text)) { child.stdout.pause(); child.stderr.pause() }
        chunks.push(text); outputBytes += Buffer.byteLength(text)
        while (outputBytes > outputLimit && chunks.length) {
          outputBytes -= Buffer.byteLength(chunks.shift()!)
          outputTruncated = true
        }
      }
      child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8')
      child.stdout.on('data', capture); child.stderr.on('data', capture)
      let settled = false
      let reason: 'cancelled' | 'timeout' | undefined
      let cleanupError: string | undefined
      let stopping: Promise<void> | undefined
      let timer: ReturnType<typeof setTimeout> | undefined
      const abort = () => stop('cancelled')
      const finish = async (code: number | null, signal: NodeJS.Signals | null, error?: Error) => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        ctx.signal?.removeEventListener('abort', abort)
        await stopping
        if (archive && !archive.destroyed) await new Promise<void>(done => {
          archive!.once('error', () => done())
          archive!.end(() => done())
        })
        const status = cleanupError ? 'interrupted' : reason === 'cancelled' ? 'cancelled' : reason === 'timeout' || error || code !== 0 ? 'failed' : 'succeeded'
        const diagnostic = cleanupError ? `Skill process cleanup failed: ${cleanupError}`
          : reason === 'cancelled' ? 'Skill script cancelled by user'
            : reason === 'timeout' ? `Command timed out after ${timeoutMs}ms`
              : error ? `Error: ${error.message}` : code !== 0 ? `Command exited with ${signal ?? code}` : ''
        resolve({ success: status === 'succeeded', status,
          output: [diagnostic,
            outputTruncated ? outputArchiveError ? 'Output preview truncated; full output archive unavailable.' : `Output preview truncated; full output: ${outputArchivePath}` : '',
            outputArchiveError ? `Output archive error: ${outputArchiveError}` : '',
            chunks.join('').trim()].filter(Boolean).join('\n') || 'Command completed with no output',
          ...(reason === 'cancelled' ? { error: 'Cancelled' } : reason === 'timeout' ? { error: 'TimedOut' } : {}),
          durationMs: Date.now() - startTime,
          metadata: { exitCode: code, signal, timeoutMs, outputTruncated,
            ...(!outputArchiveError ? { outputArchivePath } : { outputArchiveError }),
            ...(cleanupError ? { processCleanupError: cleanupError } : {}) },
        })
      }
      const stop = (value: 'cancelled' | 'timeout') => {
        if (settled || stopping) return
        reason = value
        stopping = stopCommandProcessTree(child, startTime).catch(error => {
          cleanupError = error instanceof Error ? error.message : String(error)
          // Preserve an honest interrupted outcome when tree cleanup could not
          // be established; never report a successful cancellation here.
          child.kill()
        })
      }
      child.once('error', error => { void finish(null, null, error) })
      child.once('close', (code, signal) => { void finish(code, signal) })
      if (timeoutMs > 0) timer = setTimeout(() => stop('timeout'), timeoutMs)
      ctx.signal?.addEventListener('abort', abort, { once: true })
      if (ctx.signal?.aborted) abort()
    })
  },
}
