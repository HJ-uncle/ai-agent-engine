import path from 'node:path'
import type { Tool, AgentContext, ToolResult } from '../../core/agent-context/index.js'
import { workspaceManager } from '../../workspace/index.js'
import { loadCodeGraph } from './codegraph-module.js'
import type { CgInstance, CgNode, CgEdge } from './codegraph-module.js'
import { startIndexing, getIndexRunState, isIndexRunning } from './index-runner.js'

/**
 * 代码图查询工具（codegraph）
 *
 * 让 Agent 具备「查代码知识图谱」的能力：符号搜索、调用方/被调方、
 * 影响面分析、索引文件清单、索引状态，以及触发建索引。
 *
 * 设计约束（见 .trae/documents/p3-codegraph.md 及后续产品化调整）：
 *   - 查询类 action 全部只读；action=index 可触发建索引（产品化要求：
 *     终端用户不接触 CLI，允许用户对 Agent 说「给项目建索引」）
 *   - execute 内动态 import codegraph 包：包缺失时不炸引擎启动，优雅降级
 *   - codegraph 是 CJS、引擎是 ESM：必须用 named import（default import
 *     拿到的是整个 module 对象，openSync 为 undefined——静默陷阱），
 *     断言在 codegraph-module.ts 的 loadCodeGraph 内统一完成
 *   - 图查询（callers/callees/impact）入参是 nodeId 而非符号名，传符号名
 *     会静默返回空 → 两步编排（searchNodes → nodeId → 图查询）封装在本工具内，
 *     LLM 只需传人类可读的符号关键词
 *   - action=index 仅作用于当前工作区（不接受任意路径，防 Agent 乱建）
 */

/** 解析项目根目录：绝对路径直接用；相对路径基于工作区 cwd 解析 */
function resolveProjectRoot(rawPath: string | undefined, ctx: AgentContext): string {
  if (rawPath && path.isAbsolute(rawPath)) return rawPath
  let cwd = process.cwd()
  try {
    cwd = workspaceManager.getWorkingDirectory(ctx)
  } catch {
    // ctx 不完整（如脱离完整 AgentContext 的测试场景）时退回 process.cwd()
  }
  return rawPath ? path.resolve(cwd, rawPath) : cwd
}

/** 截断过长文本 */
function trunc(s: string | null | undefined, max = 120): string {
  if (!s) return ''
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > max ? one.slice(0, max) + '…' : one
}

/** 节点的单行表示：kind + 名称 + 位置（+ 签名） */
function fmtNode(n: CgNode): string {
  const loc = `${n.filePath}${n.startLine != null ? `:${n.startLine}` : ''}`
  const sig = n.signature ? `  ${trunc(n.signature, 100)}` : ''
  return `${n.kind} ${n.name} — ${loc}${sig}`
}

/** 图查询节点解析：优先 nodeId；否则用 query 搜索并要求唯一/让用户挑 */
function resolveNodeId(
  cg: CgInstance,
  nodeId: string | undefined,
  query: string | undefined
): { nodeId?: string; error?: string } {
  if (nodeId) return { nodeId }
  if (!query) return { error: '缺少参数：请传 nodeId，或传 query（符号名/关键词）由工具内部搜索解析' }
  const hits = cg.searchNodes(query, { limit: 10 })
  if (hits.length === 0) {
    return { error: `在代码图中未找到符号「${query}」。可先用 action=search 搜索相近名称` }
  }
  // 精确名匹配优先，其次取最高分；多条同名时列出让 Agent 自己缩小范围
  const exact = hits.filter(h => h.node.name === query)
  if (exact.length === 1) return { nodeId: exact[0].node.id }
  if (hits.length === 1) return { nodeId: hits[0].node.id }
  const candidates = hits.slice(0, 10).map(h => `  - ${fmtNode(h.node)} (nodeId: ${h.node.id})`)
  return {
    error: `符号「${query}」匹配到 ${hits.length} 个节点，请用更精确的名称，或从以下候选中取 nodeId 重试：\n${candidates.join('\n')}`,
  }
}

/** callers/callees 结果格式化 */
function fmtCallList(
  title: string,
  rows: Array<{ node: CgNode; edge: CgEdge }>,
  direction: 'caller' | 'callee',
  limit: number
): string {
  if (rows.length === 0) return `${title}: 无`
  const lines = [`${title}（${rows.length} 条）:`]
  for (const { node, edge } of rows.slice(0, limit)) {
    const via = edge.metadata?.refName ? ` via ${edge.metadata.refName}` : ''
    const at = edge.line != null ? ` @:${edge.line}${edge.column != null ? `:${edge.column}` : ''}` : ''
    const resolved = edge.metadata?.resolvedBy ? ` [${edge.metadata.resolvedBy}]` : ''
    lines.push(`  ${direction === 'caller' ? '←' : '→'} ${node.kind} ${node.name} — ${node.filePath}${at}${via}${resolved}`)
  }
  if (rows.length > limit) lines.push(`  ... 还有 ${rows.length - limit} 条未显示`)
  return lines.join('\n')
}

export const codegraphTool: Tool = {
  name: 'codegraph',
  displayName: '代码图查询',
  description:
    '查询代码知识图谱（codegraph 索引）：符号搜索、调用方/被调方、影响面分析、文件清单、索引状态。' +
    '工作区已建索引时，凡是涉及「某符号定义在哪」「X 被谁调用」「X 调用了谁」「改 X 会影响哪些地方」的问题，' +
    '都必须优先用本工具，而不是 grep / 逐个读文件 —— 图谱是已落库的结构化关系，比逐字搜索更快更准。' +
    '纯文本检索（字符串常量、报错信息、注释）才用 grep。' +
    'action=index 可为当前工作区创建索引（异步，用 status 查进度；仅当用户明确要求时调用）。',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['status', 'search', 'callers', 'callees', 'impact', 'files', 'index'],
        description:
          'status=索引统计/建索引进度；search=按关键词搜符号；callers=谁调用了它；callees=它调用了谁；' +
          'impact=改动影响面；files=索引内文件清单；index=为当前工作区创建索引（仅当用户明确要求时调用）',
      },
      query: {
        type: 'string',
        description: '符号名或关键词（search 必填；callers/callees/impact 不传 nodeId 时必填）',
      },
      nodeId: {
        type: 'string',
        description: '可选：图节点 ID（形如 function:xxxx），已知时可直接传入跳过搜索',
      },
      path: {
        type: 'string',
        description: '项目根目录（相对工作区或绝对路径），默认当前工作区',
      },
      limit: { type: 'number', description: '返回条数上限，默认 20' },
      depth: { type: 'number', description: 'impact 的最大调用链深度，默认 3' },
    },
    required: ['action'],
  },
  async execute(rawArgs: unknown, ctx: AgentContext): Promise<ToolResult> {
    const args = rawArgs as {
      action: string
      query?: string
      nodeId?: string
      path?: string
      limit?: number
      depth?: number
    }
    const action = args?.action
    if (!action) {
      return { success: false, output: '❌ 缺少必填参数 action' }
    }
    try {
      const CodeGraph = await loadCodeGraph()
      const root = resolveProjectRoot(args.path, ctx)

      // 建索引 action：只作用于当前工作区（忽略 path 参数，防 Agent 对任意目录建索引）
      if (action === 'index') {
        let wsRoot: string
        try {
          wsRoot = workspaceManager.getWorkingDirectory(ctx)
        } catch {
          return { success: false, output: '❌ 无法确定当前工作区，无法创建索引' }
        }
        const r = await startIndexing(wsRoot)
        if (r.error && !r.started) {
          if (r.alreadyRunning) {
            const s = getIndexRunState()
            return { success: true, output: `⏳ 已有索引任务进行中: ${s?.root}\n可用 action=status 查询进度` }
          }
          return { success: false, output: `❌ 无法创建索引: ${r.error}` }
        }
        if (r.alreadyInitialized) {
          return { success: true, output: `📋 工作区已有代码图索引: ${wsRoot}\n无需重建；如需刷新可用 action=status 查看状态` }
        }
        return {
          success: true,
          output: `🚀 已开始为工作区创建代码图索引: ${wsRoot}\n索引在后台异步执行，请隔一段时间用 action=status 查询进度，完成后即可使用查询功能`,
        }
      }

      // 建索引进度优先展示（索引刚开始时目录可能尚未标记为已初始化）
      if (action === 'status' && (isIndexRunning() || getIndexRunState()?.phase === 'failed')) {
        const s = getIndexRunState()!
        const p = s.progress
        const lines = [
          `⏳ 代码图索引任务 (${s.phase}): ${s.root}`,
          p ? `- 进度: ${p.phase} ${p.current}/${p.total}${p.currentFile ? ` (${p.currentFile})` : ''}` : '- 进度: 准备中...',
        ]
        if (s.phase === 'failed') lines.push(`❌ 失败原因: ${s.error ?? '未知'}`)
        return { success: true, output: lines.join('\n') }
      }

      // 只读查询：索引缺失时提示用户可通过 IDE 按钮或 Agent（action=index）创建
      if (!CodeGraph.isInitialized(root)) {
        return {
          success: true,
          output:
            `📋 目录尚无 codegraph 索引: ${root}\n` +
            `无法执行代码图查询（action=${action}）。\n` +
            `可以：① 请用户在聊天面板点击「创建代码图索引」按钮；` +
            `② 或经用户同意后用 action=index 为当前工作区创建索引（仅限当前工作区）。`,
        }
      }

      const cg = CodeGraph.openSync(root)
      try {
        const limit = Math.max(1, Math.min(args.limit ?? 20, 100))

        switch (action) {
          case 'status': {
            const stats = cg.getStats()
            const state = cg.getIndexState() ?? 'unknown'
            const stale = cg.isIndexStale()
            const lastAt = cg.getLastIndexedAt()
            const lines = [
              `📋 代码图索引状态: ${root}`,
              `- 状态: ${state}${stale ? '（检测到文件变动，建议重建索引）' : ''}`,
              `- 节点: ${stats.nodeCount} / 边: ${stats.edgeCount} / 文件: ${stats.fileCount}`,
            ]
            if (stats.nodesByKind) {
              const kinds = Object.entries(stats.nodesByKind)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 12)
                .map(([k, v]) => `${k}:${v}`)
                .join(', ')
              lines.push(`- 节点类型: ${kinds}`)
            }
            if (stats.filesByLanguage) {
              const langs = Object.entries(stats.filesByLanguage)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 12)
                .map(([k, v]) => `${k}:${v}`)
                .join(', ')
              lines.push(`- 语言分布: ${langs}`)
            }
            if (lastAt) lines.push(`- 最近索引时间: ${new Date(lastAt).toLocaleString()}`)
            return { success: true, output: lines.join('\n') }
          }

          case 'search': {
            if (!args.query) return { success: false, output: '❌ action=search 需要 query 参数' }
            const hits = cg.searchNodes(args.query, { limit: limit + 10 })
            if (hits.length === 0) {
              return { success: true, output: `📋 代码图中未找到与「${args.query}」匹配的符号` }
            }
            const lines = [`📋 符号搜索「${args.query}」（${hits.length} 条）:`]
            for (const { node, score } of hits.slice(0, limit)) {
              lines.push(`  - [${score.toFixed(2)}] ${fmtNode(node)} (nodeId: ${node.id})`)
            }
            if (hits.length > limit) lines.push(`  ... 还有 ${hits.length - limit} 条未显示`)
            return { success: true, output: lines.join('\n') }
          }

          case 'callers':
          case 'callees': {
            const r = resolveNodeId(cg, args.nodeId, args.query)
            if (r.error) return { success: false, output: `❌ ${r.error}` }
            const self = args.nodeId ?? args.query!
            const rows =
              action === 'callers'
                ? cg.getCallers(r.nodeId!)
                : cg.getCallees(r.nodeId!)
            const title =
              action === 'callers'
                ? `📋 「${self}」的调用方`
                : `📋 「${self}」调用的目标`
            const body = fmtCallList(
              title,
              rows,
              action === 'callers' ? 'caller' : 'callee',
              limit
            )
            return { success: true, output: body }
          }

          case 'impact': {
            const r = resolveNodeId(cg, args.nodeId, args.query)
            if (r.error) return { success: false, output: `❌ ${r.error}` }
            const depth = Math.max(1, Math.min(args.depth ?? 3, 10))
            const sub = cg.getImpactRadius(r.nodeId!, depth)
            const nodes = sub.nodes instanceof Map
              ? [...sub.nodes.values()]
              : Object.values(sub.nodes ?? {})
            if (nodes.length === 0) {
              return { success: true, output: `📋 「${args.query ?? args.nodeId}」的影响面: 无上游依赖节点（可能是叶子入口）` }
            }
            const lines = [
              `📋 「${args.query ?? args.nodeId}」改动影响面（深度 ${depth}）:`,
              `- 受影响节点: ${nodes.length} / 关系边: ${sub.edges.length} / 入口: ${sub.roots.length}`,
            ]
            for (const n of nodes.slice(0, limit)) {
              lines.push(`  - ${fmtNode(n)}`)
            }
            if (nodes.length > limit) lines.push(`  ... 还有 ${nodes.length - limit} 个节点未显示`)
            return { success: true, output: lines.join('\n') }
          }

          case 'files': {
            const files = cg.getFiles()
            if (files.length === 0) {
              return { success: true, output: `📋 索引内暂无文件记录: ${root}` }
            }
            const byLang: Record<string, number> = {}
            for (const f of files) byLang[f.language] = (byLang[f.language] ?? 0) + 1
            const langSummary = Object.entries(byLang)
              .sort((a, b) => b[1] - a[1])
              .map(([k, v]) => `${k}:${v}`)
              .join(', ')
            const lines = [
              `📋 索引文件清单: ${root}（共 ${files.length} 个）`,
              `- 语言分布: ${langSummary}`,
            ]
            const q = args.query?.toLowerCase()
            const filtered = q ? files.filter(f => f.path.toLowerCase().includes(q)) : files
            const shown = (q ? filtered : files).slice(0, limit)
            for (const f of shown) {
              lines.push(`  - ${f.path} (${f.language}${f.size ? `, ${(f.size / 1024).toFixed(1)}KB` : ''})`)
            }
            if (q) lines.push(`（按关键词「${args.query}」过滤出 ${filtered.length} 个，显示前 ${shown.length} 个）`)
            else if (files.length > limit) lines.push(`  ... 还有 ${files.length - limit} 个未显示（可用 query 参数按路径过滤）`)
            return { success: true, output: lines.join('\n') }
          }

          default:
            return { success: false, output: `❌ 未知 action: ${action}（可选 status/search/callers/callees/impact/files）` }
        }
      } finally {
        try { cg.close() } catch { /* 忽略关闭异常 */ }
      }
    } catch (e: any) {
      return { success: false, output: `❌ 代码图查询失败: ${e?.message ?? String(e)}` }
    }
  },
}
