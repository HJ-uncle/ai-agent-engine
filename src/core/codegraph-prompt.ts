/**
 * 代码图索引的提示词注入
 *
 * 背景：codegraph 工具此前只做了「工具层」——工具描述里写了适合什么场景，
 * 但 system prompt 里零提及，也没有「索引已就绪」的信号。结果模型几乎想不起来用它，
 * 遇到「X 被谁调用」这类问题仍然去 grep/read 满仓库翻。
 *
 * 这里解决两件事：
 * 1. 让模型知道当前工作区**是否已建索引**（未建时不去调 codegraph，避免无效往返）；
 * 2. 索引可用时，明确给出「符号/调用关系/影响面 → 优先 codegraph」的工具选择策略。
 *
 * 未建索引时不注入任何内容 —— 没有索引却引导模型用它，只会浪费一轮工具调用。
 */

/** 注入区块的标记，便于日志/排查时识别 */
const BLOCK_HEADER = '# 代码图索引（codegraph）'

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
