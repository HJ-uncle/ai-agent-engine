/**
 * codegraph 模块加载器（共享）
 *
 * 把 named-import 静默陷阱变成显式报错：
 * codegraph 是 CJS、引擎是 ESM，default import 拿到的是整个 module 对象
 * （openSync 为 undefined），必须用 named import 并断言关键方法存在。
 */

/** codegraph 实例的最小类型面（避免依赖其内部 .d.ts 的具体形态） */
export interface CgNode {
  id: string
  kind: string
  name: string
  qualifiedName?: string
  filePath: string
  language?: string
  startLine?: number
  endLine?: number
  signature?: string | null
}

export interface CgEdge {
  source: string
  target: string
  kind?: string
  line?: number | null
  column?: number | null
  metadata?: { confidence?: number; resolvedBy?: string; refName?: string }
}

export interface CgInstance {
  searchNodes(query: string, options?: { limit?: number }): Array<{ node: CgNode; score: number }>
  getCallers(nodeId: string, maxDepth?: number): Array<{ node: CgNode; edge: CgEdge }>
  getCallees(nodeId: string, maxDepth?: number): Array<{ node: CgNode; edge: CgEdge }>
  getImpactRadius(nodeId: string, maxDepth?: number): {
    nodes: Map<string, CgNode> | Record<string, CgNode>
    edges: CgEdge[]
    roots: string[]
  }
  getFiles(): Array<{ path: string; language: string; size: number }>
  getStats(): {
    nodeCount: number
    edgeCount: number
    fileCount: number
    nodesByKind?: Record<string, number>
    edgesByKind?: Record<string, number>
    filesByLanguage?: Record<string, number>
    dbSizeBytes?: number
  }
  getIndexState(): 'indexing' | 'complete' | 'partial' | 'failed' | null
  isIndexStale(): boolean
  getLastIndexedAt(): number | null
  /** 全量索引（recreate 后的空实例上调用）；文件锁被占时返回 success:false 而非抛异常 */
  indexAll(options?: {
    onProgress?: (progress: { phase: string; current: number; total: number; currentFile?: string }) => void
  }): Promise<{ success: boolean; errors?: Array<{ message: string; severity: string }> }>
  close(): void
}

export interface CgStatic {
  isInitialized(dir: string): boolean
  openSync(dir: string): CgInstance
  /** 创建 .codegraph 目录 + 数据库，index:true 时同步完成首次索引（异步方法） */
  init(projectRoot: string, options?: {
    index?: boolean
    onProgress?: (progress: { phase: string; current: number; total: number; currentFile?: string }) => void
  }): Promise<CgInstance>
  /** 删库重建出空实例（丢弃旧 .codegraph/codegraph.db 再建新库）；要求已初始化（异步方法） */
  recreate(projectRoot: string): Promise<CgInstance>
}

/** 动态加载并断言 codegraph 模块（包缺失时不炸引擎启动，调用时才报错） */
export async function loadCodeGraph(): Promise<CgStatic> {
  const mod = (await import('@colbymchenry/codegraph')) as unknown as { CodeGraph?: CgStatic }
  const CodeGraph = mod?.CodeGraph
  if (!CodeGraph || typeof CodeGraph.openSync !== 'function' || typeof CodeGraph.isInitialized !== 'function') {
    throw new Error(
      'codegraph 模块加载异常：CodeGraph.openSync 不可用（可能以 default import 拿到了整个 module 对象，或包未正确安装）'
    )
  }
  return CodeGraph
}
