/**
 * codegraph 模块加载器（共享）
 *
 * npm SDK 通过 module.exports = require(platformBundle) 转出 CJS 对象。
 * 原生 Node ESM 不一定能推断出命名导出；default 则是整个 CJS exports，
 * CodeGraph 类位于其 CodeGraph 属性中。两种入口均校验实际所需 API。
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

/** Resolve native ESM and CJS namespace shapes without treating the module object as the class. */
export function resolveCodeGraphModule(module: unknown): CgStatic {
  const property = (value: unknown, key: string): unknown =>
    value !== null && (typeof value === 'object' || typeof value === 'function')
      ? Reflect.get(value, key) : undefined
  const candidates = [property(module, 'CodeGraph'), property(property(module, 'default'), 'CodeGraph')]
  const required = ['openSync', 'isInitialized', 'init', 'recreate'] as const
  for (const candidate of candidates) {
    if (candidate && required.every(method => typeof property(candidate, method) === 'function')) {
      return candidate as CgStatic
    }
  }
  throw new Error('代码图组件接口不兼容：缺少 CodeGraph.openSync/isInitialized/init/recreate。请更新配套引擎运行时；无需修改项目或连接令牌。')
}

/** Load lazily: an unavailable optional component must not prevent engine startup. */
export async function loadCodeGraph(): Promise<CgStatic> {
  return resolveCodeGraphModule(await import('@colbymchenry/codegraph'))
}
