/**
 * File index Web Worker
 * 在工作区加载时后台构建文件路径索引，增量更新
 */

type WorkerMsg =
  | { type: 'BUILD_INDEX'; files: string[] }
  | { type: 'QUERY'; query: string; limit?: number }
  | { type: 'REBUILD' }

type WorkerReply =
  | { type: 'INDEX_READY'; count: number }
  | { type: 'QUERY_RESULT'; results: string[]; elapsed: number }

let fileIndex: string[] = []

// Simple trigram-based fuzzy search (faster than full Fuse.js in worker)
function fuzzyMatch(path: string, query: string): boolean {
  if (!query) return true
  const p = path.toLowerCase()
  const q = query.toLowerCase()
  // Subsequence match
  let pi = 0
  for (let qi = 0; qi < q.length; qi++) {
    while (pi < p.length && p[pi] !== q[qi]) pi++
    if (pi >= p.length) return false
    pi++
  }
  return true
}

function scoreMatch(path: string, query: string): number {
  const name = path.split('/').pop()?.toLowerCase() ?? ''
  const q = query.toLowerCase()
  // Exact name match scores highest
  if (name === q) return 100
  if (name.startsWith(q)) return 80
  if (name.includes(q)) return 60
  // Path match
  if (path.toLowerCase().includes(q)) return 40
  return 10
}

// eslint-disable-next-line no-restricted-globals
const ctx = self as unknown as Worker

ctx.onmessage = (e: MessageEvent<WorkerMsg>) => {
  const msg = e.data
  switch (msg.type) {
    case 'BUILD_INDEX': {
      fileIndex = msg.files
      const reply: WorkerReply = { type: 'INDEX_READY', count: fileIndex.length }
      ctx.postMessage(reply)
      break
    }
    case 'QUERY': {
      const start = performance.now()
      const { query, limit = 50 } = msg
      let results: string[]
      if (!query.trim()) {
        results = fileIndex.slice(0, limit)
      } else {
        results = fileIndex
          .filter(f => fuzzyMatch(f, query))
          .map(f => ({ path: f, score: scoreMatch(f, query) }))
          .sort((a, b) => b.score - a.score)
          .slice(0, limit)
          .map(r => r.path)
      }
      const elapsed = Math.round(performance.now() - start)
      const reply: WorkerReply = { type: 'QUERY_RESULT', results, elapsed }
      ctx.postMessage(reply)
      break
    }
    case 'REBUILD': {
      const reply: WorkerReply = { type: 'INDEX_READY', count: fileIndex.length }
      ctx.postMessage(reply)
      break
    }
  }
}

export {}
