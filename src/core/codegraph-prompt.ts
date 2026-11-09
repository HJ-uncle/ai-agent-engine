import type { AgentContext } from './agent-context/types.js'
import { workspaceManager } from '../workspace/index.js'
import { canonicalFilePathSync } from '../shared/file-version.js'
import { projectDataPath } from './project-storage.js'
import { captureSubagentWorkspace, workspaceContains } from '../tools/subagent/workspace-scope.js'

/**
 * 代码图索引的请求上下文
 *
 * 主 Agent、子代理和恢复执行都在 ReAct 的请求边界重新发现当前授权工作区中的索引。
 * 已有索引时提供受当前注册表权限约束的查询定义，并返回项目调研与调用关系查询指引。
 * 只探测索引是否存在，不打开数据库、不建图，也不将文件存在视为完整或最新的证明。
 *
 * 动态指引放在历史之后的 requestContext 尾部，不写入会话历史或静态 system 前缀；
 * ReAct 在工具被收尾策略移除时同步丢弃指引，避免要求模型调用不可用工具。
 *
 * 无索引、无工具或探测失败时返回空串。下方保留旧提示词构造接口供兼容调用方使用。
 */

/** 注入区块的标记，便于日志/排查时识别 */
const BLOCK_HEADER = '# 代码图索引（codegraph）'

/** Discover only the current authorized roots. An existing index justifies
 * exposing its query schema; it does not prove completeness or freshness.
 * Kept request-local so child/resumed runs cannot inherit a stale root hint. */
export async function prepareCodegraphRequestContext(ctx: AgentContext): Promise<string> {
  try {
    if (!ctx.tools.has?.('codegraph')) return ''
    const scope = captureSubagentWorkspace(ctx)
    const authorizedRoot = (root: string): string => {
      scope.assertCurrent()
      const resolved = canonicalFilePathSync(workspaceManager.resolveSafePathForSnapshot(ctx, scope.snapshot, root))
      if (!scope.roots.some(allowed => workspaceContains(allowed, resolved))) throw new Error('Codegraph root outside workspace')
      for (const entry of ['', 'codegraph.db', 'codegraph.db-wal', 'codegraph.db-shm', 'codegraph.db-journal']) {
        if (!workspaceContains(resolved, projectDataPath(resolved, entry))) throw new Error('Codegraph storage outside project')
      }
      return resolved
    }
    const { loadCodeGraph } = await import('../tools/codegraph/codegraph-module.js')
    const codegraph = await loadCodeGraph()
    scope.assertCurrent()
    const indexedRoots = scope.roots.flatMap(root => {
      try {
        const resolved = authorizedRoot(root)
        return codegraph.isInitialized(resolved) && authorizedRoot(root) === resolved ? [resolved] : []
      } catch { return [] }
    })
    scope.assertCurrent()
    if (!indexedRoots.length || !ctx.tools.has('codegraph')) return ''
    const offered = () => (ctx.tools.listForRequest?.() ?? ctx.tools.listForModel?.() ?? ctx.tools.list())
      .some(tool => tool.name === 'codegraph')
    if (!offered()) {
      if (ctx.tools.hasModelToolLoader?.() !== true || !ctx.tools.loadForModel) return ''
      ctx.tools.loadForModel(['codegraph'])
    }
    scope.assertCurrent()
    if (!ctx.tools.has('codegraph') || !offered()) return ''
    return `${BLOCK_HEADER}\n`
      + '当前授权工作区发现已有索引文件，codegraph 查询定义已提供；尚未验证索引是否完整、最新或可查询。\n'
      + '每次查询显式传入以下目标项目的绝对 path，不能将默认临时目录当作目标：\n'
      + indexedRoots.map(root => '- ' + JSON.stringify(root)).join('\n')
      + '\n项目架构梳理、整体/深度调研：先读取适用且尚未提供的 AGENTS.md/项目规则与必要入口说明，再优先用 codegraph status/files 获取覆盖范围和文件概览；按入口或模块符号用 search，再用 callers/callees 验证关键关系，避免用命令逐层枚举整个源码树。\n'
      + '定位定义、调用关系、依赖或修改影响面时，优先 search/callers/callees/impact；纯文本、错误字符串和注释仍用 grep。用 read_file 按相关范围核对当前源码，代码图不能替代实现、运行行为或测试证据。\n'
      + 'status 报 partial/failed/stale、缺失或查询失败时，明确覆盖限制并用 grep/read_file 继续，不循环重试，不把空结果当作不存在。不要仅为调研自动创建/重建索引；index 仍须用户明确要求且当前角色允许。普通聊天或与项目结构无关的任务无需调用代码图。'
  } catch { return '' }
}

/**
 * 工作区索引状态探测结果
 */
export interface CodegraphAvailability {
  /** 已建索引的工作区根路径 */
  indexedRoots: string[]
}

/**
 * 探测哪些工作区已建索引
 *
 * 探测失败（包未安装等）一律当"没有索引"处理：提示词里少一段无伤大雅，
 * 但因此让整轮对话报错是不可接受的。
 */
export async function detectCodegraphAvailability(
  workspacePaths: string[]
): Promise<CodegraphAvailability> {
  if (workspacePaths.length === 0) return { indexedRoots: [] }

  try {
    const { loadCodeGraph } = await import('../tools/codegraph/codegraph-module.js')
    const CodeGraph = await loadCodeGraph()
    const indexedRoots = workspacePaths.filter((root) => {
      try {
        return CodeGraph.isInitialized(root)
      } catch {
        return false
      }
    })
    return { indexedRoots }
  } catch {
    return { indexedRoots: [] }
  }
}

/**
 * 生成注入到 system prompt 的代码图说明块
 *
 * @param availability 已探测到的索引可用性；无已建索引时返回空串
 * @param primaryRoot  主工作区路径，用于把工具的默认作用域说清楚
 */
export function buildCodegraphPromptBlock(
  availability: CodegraphAvailability,
  primaryRoot?: string
): string {
  const { indexedRoots } = availability
  if (indexedRoots.length === 0) return ''

  const scope =
    indexedRoots.length === 1
      ? `当前工作区（${indexedRoots[0]}）已建好代码图索引`
      : `以下工作区已建好代码图索引：\n${indexedRoots.map((p) => `  - ${p}`).join('\n')}`

  const defaultScope = primaryRoot ? `\n不传 path 时默认查询：${primaryRoot}` : ''

  return `

---
${BLOCK_HEADER}

${scope}。${defaultScope}

**这是已落库的结构化符号/调用关系数据，比在文件里逐字搜索更快也更准。**
遇到下列问题时，必须先查代码图，不要一上来就 grep / 通读文件：

| 你想知道 | 用哪个 action |
| --- | --- |
| 某个函数/类/方法定义在哪 | \`search\` |
| X 被谁调用（谁依赖它） | \`callers\` |
| X 调用了谁（它依赖什么） | \`callees\` |
| 改 X 会影响哪些地方（范围评估） | \`impact\` |
| 索引里有哪些文件 | \`files\` |
| 索引统计（节点/边/文件数） | \`status\` |

使用要点：
- 一次调用只传一个 \`action\`，符号名放 \`query\`；\`callers\`/\`callees\` 已返回节点 ID 时，
  后续可直接传 \`nodeId\` 跳过再次搜索。
- **改代码前先 \`impact\`**：确认改动波及面，再决定要不要连带修改调用方。
- 代码图是静态索引，可能落后于刚写入的文件；若结果与当前文件明显不符，
  用 \`grep\`/\`smart_read\` 交叉验证，而不是直接相信索引。
- 纯文本检索（找字符串常量、报错信息、注释）仍用 \`grep\`，代码图不擅长这类查询。
- 索引缺失时才用 \`action=index\` 建，且**仅在用户明确要求时**调用。
`
}
