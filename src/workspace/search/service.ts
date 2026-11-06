import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { Worker } from 'node:worker_threads'
import type { WorkspaceSearchInput, WorkspaceSearchResult } from './core.js'

const require = createRequire(import.meta.url)
interface Job { owner: string; abort(): void }
const jobs = new Map<string, Job>()
const cancelled = new Map<string, number>()
const keyOf = (owner: string, requestId: string): string => JSON.stringify([owner, requestId])
function abortError(): Error { return Object.assign(new Error('工作区搜索已取消'), { name: 'AbortError' }) }

export function cancelWorkspaceSearch(owner: string, requestId: string): boolean {
  // HTTP cancellation can overtake a request still queued for dispatch.
  for (const [key, expires] of cancelled) if (expires < Date.now()) cancelled.delete(key)
  cancelled.set(keyOf(owner, requestId), Date.now() + 30_000)
  if (cancelled.size > 1024) cancelled.delete(cancelled.keys().next().value!)
  const job = jobs.get(keyOf(owner, requestId))
  if (!job) return false
  job.abort()
  return true
}

/** Filesystem traversal and potentially expensive regexes never run on the
 * HTTP event loop. Worker termination also interrupts a non-yielding regex. */
export async function runWorkspaceSearch(owner: string, requestId: string, root: string, input: WorkspaceSearchInput,
  assertCurrent: () => void, options: { timeoutMs?: number } = {}): Promise<WorkspaceSearchResult> {
  assertCurrent()
  if ((cancelled.get(keyOf(owner, requestId)) ?? 0) >= Date.now()) throw abortError()
  const key = keyOf(owner, requestId)
  jobs.get(key)?.abort()
  if (jobs.size >= 8 && !jobs.has(key)) throw new Error('搜索任务繁忙，请稍后重试')
  const source = new URL('./worker.js', import.meta.url)
  if (import.meta.url.endsWith('.ts')) source.pathname = source.pathname.replace(/worker\.js$/, 'worker.ts')
  const timeoutMs = options.timeoutMs ?? 30_000
  const bootstrap = `const {workerData,parentPort}=require('node:worker_threads');
    (async()=>{if(workerData.tsxUrl){const {register}=await import(workerData.tsxUrl);register();}await import(workerData.moduleUrl);})()
    .catch(error=>parentPort.postMessage({type:'error',error:error instanceof Error?error.message:String(error)}));`
  const worker = new Worker(bootstrap, { eval: true, execArgv: [], stdout: true, stderr: true,
    workerData: { root, input, timeoutMs, moduleUrl: source.href,
      tsxUrl: import.meta.url.endsWith('.ts') ? pathToFileURL(require.resolve('tsx/esm/api')).href : undefined },
    resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 } })
  worker.stdout.resume(); worker.stderr.resume()
  let job: Job | undefined
  try {
    return await new Promise<WorkspaceSearchResult>((resolve, reject) => {
      let finished = false, latest: WorkspaceSearchResult = { hits: [], truncated: false, strategy: 'scan' }
      const settle = (error?: Error, result?: WorkspaceSearchResult): void => {
        if (finished) return
        finished = true
        clearTimeout(timer); clearInterval(bindingTimer)
        if (error) reject(error)
        else { try { assertCurrent(); resolve(result!) } catch (cause) { reject(cause) } }
      }
      const timer = setTimeout(() => settle(undefined, { ...latest, truncated: true,
        error: '搜索达到时间上限，已保留当前结果；可缩小范围后继续搜索' }), timeoutMs + 1000)
      const bindingTimer = setInterval(() => { try { assertCurrent() } catch (error) { settle(error instanceof Error ? error : new Error(String(error))) } }, 200)
      job = { owner, abort: () => settle(abortError()) }
      jobs.set(key, job)
      worker.on('message', (message: { type: string; result?: WorkspaceSearchResult; error?: string }) => {
        if (finished) return
        try { assertCurrent() } catch (error) { settle(error instanceof Error ? error : new Error(String(error))); return }
        if (message.type === 'error') settle(new Error(message.error ?? '搜索执行失败'))
        else if (message.result && Array.isArray(message.result.hits)) {
          latest = message.result
          if (message.type === 'result') settle(undefined, latest)
        }
      })
      worker.once('error', error => settle(error))
      worker.once('exit', code => settle(new Error(`搜索进程已退出（${code}），请重试`)))
    })
  } finally {
    if (jobs.get(key) === job) jobs.delete(key)
    // Let AbortSignal terminate an active git child before the hard worker
    // stop. A stuck regex still cannot delay cancellation beyond this grace.
    try { worker.postMessage('cancel') } catch { /* A failed worker may already be gone. */ }
    await new Promise<void>(resolve => setTimeout(resolve, 50))
    await worker.terminate()
  }
}

export function disposeWorkspaceSearches(owners?: ReadonlySet<string>): void {
  for (const job of jobs.values()) if (!owners || owners.has(job.owner)) job.abort()
}
