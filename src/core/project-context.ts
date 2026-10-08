/**
 * 项目上下文（AE.md）加载器
 *
 * AE.md 是注入 system prompt 的项目说明文件（对标 Claude Code 的 CLAUDE.md、
 * Codex 的 AGENTS.md），用于告诉 Agent 本项目的技术栈、约定与注意事项。
 *
 * 查找顺序（全局上下文与项目上下文拼接，新位置优先）：
 *   1. ~/.aether/AE.md       用户级全局上下文
 *   2. <project>/.ae/AE.md      项目级（推荐位置）
 *   3. .ae/AE.md 不存在时兼容 .aether/AE.md 与根目录 AE.md
 *
 * 每次请求实时读取（文件通常很小），无缓存，改完即生效。
 */

import fs from 'node:fs'
import path from 'node:path'
import { getUserAetherDir } from './aether-config.js'
import { legacyProjectDataPath, projectDataPath } from './project-storage.js'

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
export function getProjectContextBlock(projectRoot: string = process.cwd()): string {
  const canonical = projectDataPath(projectRoot, 'AE.md')
  // Once migrated, old instructions must not be injected twice or reappear after an intentional clear.
  const projectFiles = fs.existsSync(canonical)
    ? [{ file: canonical, label: 'project' }]
    : [
        { file: legacyProjectDataPath(projectRoot, 'AE.md'), label: 'project' },
        { file: path.resolve(projectRoot, 'AE.md'), label: 'root' },
      ]
  const candidates: Array<{ file: string; label: string }> = [
    { file: path.join(getUserAetherDir(), 'AE.md'), label: 'user' },
    ...projectFiles,
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
