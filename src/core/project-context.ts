/**
 * 项目上下文（AE.md）加载器
 *
 * AE.md 是注入 system prompt 的项目说明文件（对标 Claude Code 的 CLAUDE.md、
 * Codex 的 AGENTS.md），用于告诉 Agent 本项目的技术栈、约定与注意事项。
 *
 * 查找顺序（均可存在，内容依次拼接）：
 *   1. ~/.aether/AE.md       用户级全局上下文
 *   2. <project>/.aether/AE.md  项目级（推荐位置）
 *   3. <project>/AE.md          项目根目录（兼容直觉写法）
 *
 * 每次请求实时读取（文件通常很小），无缓存，改完即生效。
 */

import fs from 'node:fs'
import path from 'node:path'
import { getUserAetherDir, getProjectAetherDir } from './aether-config.js'

const MAX_CONTEXT_CHARS = 32 * 1024

function readIfExist(file: string): string | null {
  try {
    if (!fs.existsSync(file)) return null
    const content = fs.readFileSync(file, 'utf-8').trim()
    return content || null
  } catch {
    return null
  }
}

/**
 * 读取并拼接所有 AE.md 上下文，返回可直接追加到 system prompt 的段落。
 * 无任何 AE.md 时返回空字符串。
 */
export function getProjectContextBlock(): string {
  const candidates: Array<{ file: string; label: string }> = [
    { file: path.join(getUserAetherDir(), 'AE.md'), label: 'user' },
    { file: path.join(getProjectAetherDir(), 'AE.md'), label: 'project' },
    { file: path.resolve(process.cwd(), 'AE.md'), label: 'root' },
  ]

  const sections: string[] = []
  for (const { file, label } of candidates) {
    const content = readIfExist(file)
    if (content) {
      sections.push(
        `### 项目上下文 (${label}: ${path.basename(path.dirname(file))}/AE.md)\n${content.slice(0, MAX_CONTEXT_CHARS)}`,
      )
    }
  }

  if (sections.length === 0) return ''
  return `## 项目上下文（AE.md）\n以下是本项目/本用户的说明上下文，回答与执行任务时请遵循其中的约定：\n\n${sections.join('\n\n')}`
}
