import { parentPort, workerData } from 'node:worker_threads'
import { searchWorkspace, type WorkspaceSearchInput } from './core.js'

const input = workerData as { root: string; input: WorkspaceSearchInput; timeoutMs: number }
const controller = new AbortController()
parentPort!.on('message', message => { if (message === 'cancel') controller.abort() })
void searchWorkspace(input.root, input.input, { timeoutMs: input.timeoutMs,
  signal: controller.signal,
  onProgress: result => parentPort!.postMessage({ type: 'progress', result })
}).then(result => parentPort!.postMessage({ type: 'result', result }), error =>
  parentPort!.postMessage({ type: 'error', error: error instanceof Error ? error.message : String(error) }))
