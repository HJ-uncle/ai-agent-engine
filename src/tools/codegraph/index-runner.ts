/**
 * codegraph 建索引状态机（进程内单例）
 *
 * 产品化「自带 codegraph」的关键：终端用户不接触 CLI，由 IDE 按钮 / Agent 工具
 * 触发本模块完成 init + 首次索引（同进程调用 codegraph 库，不 spawn 子进程）。
 *
 * 设计：
 *   - 同一时刻只允许一个索引任务（全局单例状态，防并发写库）
 *   - 异步执行，调用方立即返回；进度通过 getIndexRunState() 轮询
 *   - 只读查询（codegraph 工具的查询 action）不受影响，索引期间可正常查旧数据
 */
import { loadCodeGraph } from './codegraph-module.js'

export interface IndexRunState {
  root: string
  /** create=首次建索引；rebuild=删库重建后重新索引 */
  mode: 'create' | 'rebuild'
  phase: 'preparing' | 'indexing' | 'complete' | 'failed'
  /** 当前进度（来自 codegraph 的 onProgress：scanning/parsing/storing/resolving/linking） */
  progress: { phase: string; current: number; total: number; currentFile?: string } | null
  startedAt: number
  finishedAt?: number
  error?: string
  filesIndexed?: number
}

let current: IndexRunState | null = null

/** 当前索引任务状态（无任务时返回 null） */
export function getIndexRunState(): IndexRunState | null {
  return current
}

/** 是否正在建索引 */
export function isIndexRunning(): boolean {
  return current != null && (current.phase === 'preparing' || current.phase === 'indexing')
}

export interface StartIndexResult {
  started: boolean
  alreadyRunning?: boolean
  alreadyInitialized?: boolean
  error?: string
}

export interface StartIndexOptions {
  /** true = 删库重建（recreate 后重新索引），用于设置页的「重建索引」 */
  rebuild?: boolean
}

/**
 * 对指定项目根目录发起建索引（init + 首次索引，或 rebuild 时删库重建 + 重新索引）。
 * 异步执行，立即返回；进度/结果通过 getIndexRunState() 轮询。
 */
export async function startIndexing(root: string, options?: StartIndexOptions): Promise<StartIndexResult> {
  const rebuild = options?.rebuild === true
  if (isIndexRunning()) {
    return { started: false, alreadyRunning: true, error: `已有索引任务进行中: ${current!.root}` }
  }
  let CodeGraph
  try {
    CodeGraph = await loadCodeGraph()
  } catch (e: any) {
    return { started: false, error: e?.message ?? String(e) }
  }
  // rebuild 仅对已初始化的项目生效：未初始化时退回首次建索引（recreate 会因未初始化抛错）
  let effectiveRebuild = false
  if (CodeGraph.isInitialized(root)) {
    if (!rebuild) return { started: false, alreadyInitialized: true }
    // 走到这里必然已初始化；仅防打包版本缺方法时给出可读错误
    if (typeof CodeGraph.recreate !== 'function') {
      return { started: false, error: '当前 codegraph 版本不支持重建索引' }
    }
    effectiveRebuild = true
  }

  current = { root, mode: effectiveRebuild ? 'rebuild' : 'create', phase: 'preparing', progress: null, startedAt: Date.now() }
  void run(CodeGraph, root, effectiveRebuild).catch(() => { /* run 内部已兜底，此处防御 */ })
  return { started: true }
}

async function run(CodeGraph: Awaited<ReturnType<typeof loadCodeGraph>>, root: string, rebuild: boolean): Promise<void> {
  const state = current!
  try {
    state.phase = 'indexing'
    const onProgress = (p: { phase: string; current: number; total: number; currentFile?: string }) => {
      if (!current || current.root !== root) return
      current.progress = { phase: p.phase, current: p.current, total: p.total, currentFile: p.currentFile }
    }
    // create：init({index:true}) 一步建库+索引；rebuild：recreate 删库得空实例后再 indexAll
    // 注意 indexAll 在文件锁被占时不抛异常而是返回 success:false，需显式判定
    const cg = rebuild
      ? await CodeGraph.recreate(root).then(async (instance) => {
          const result = await instance.indexAll({ onProgress })
          if (result && result.success === false) {
            throw new Error(result.errors?.[0]?.message ?? '重新索引失败')
          }
          return instance
        })
      : await CodeGraph.init(root, { index: true, onProgress })
    let filesIndexed: number | undefined
    try {
      filesIndexed = cg.getStats().fileCount
    } catch { /* 统计失败不影响索引完成 */ }
    try { cg.close() } catch { /* 忽略关闭异常 */ }
    current = {
      ...state,
      phase: 'complete',
      progress: null,
      finishedAt: Date.now(),
      filesIndexed,
      error: undefined,
    }
  } catch (e: any) {
    current = {
      ...state,
      phase: 'failed',
      progress: null,
      finishedAt: Date.now(),
      error: e?.message ?? String(e),
    }
  }
}
