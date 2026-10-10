import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'
import { isMainThread } from 'node:worker_threads'
import { constants, monitorEventLoopDelay, performance, PerformanceObserver } from 'node:perf_hooks'

// Opt-in test-process preload. It never reads application data, credentials or DBs.
// Inherited --import arguments in SQLite workers are intentionally inert.
const ownFile = fileURLToPath(import.meta.url)
const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === ownFile
if (isMainThread && invokedDirectly && process.argv.includes('--self-test')) {
  await selfTest()
} else if (isMainThread && process.env.PRESSURE_RUNTIME_METRICS_FILE) {
  // fork() inherits --import and environment. Only the original instrumented
  // process owns this file; a console helper is also a main thread.
  const owner = process.env.PRESSURE_RUNTIME_METRICS_OWNER_PID
  if (!owner || owner === String(process.pid)) {
    process.env.PRESSURE_RUNTIME_METRICS_OWNER_PID = String(process.pid)
    installProbe(process.env.PRESSURE_RUNTIME_METRICS_FILE)
  }
}

function installProbe(file) {
  if (!path.isAbsolute(file)) return
  const intervalMs = 2000
  const started = performance.now()
  const startedAt = new Date().toISOString()
  let previousSampleAt = started
  let previousElu = performance.eventLoopUtilization()
  let sequence = 0, stopped = false, writeErrors = 0
  let writes = fs.mkdir(path.dirname(file), { recursive: true }).catch(() => { writeErrors++ })
  const append = record => {
    const line = JSON.stringify(record) + '\n'
    writes = writes.then(() => fs.appendFile(file, line, 'utf8')).catch(() => { writeErrors++ })
  }
  const histogram = monitorEventLoopDelay({ resolution: 10 })
  histogram.enable()
  const freshGc = () => ({ count: 0, durationMs: 0, byKind: {} })
  let gc = freshGc()
  const gcKinds = new Map([
    [constants.NODE_PERFORMANCE_GC_MAJOR, 'major'],
    [constants.NODE_PERFORMANCE_GC_MINOR, 'minor'],
    [constants.NODE_PERFORMANCE_GC_INCREMENTAL, 'incremental'],
    [constants.NODE_PERFORMANCE_GC_WEAKCB, 'weakCallback'],
  ])
  const observer = new PerformanceObserver(list => {
    for (const entry of list.getEntries()) {
      if (entry.entryType !== 'gc') continue
      const kind = gcKinds.get(entry.detail?.kind) ?? 'unknown'
      gc.count++
      gc.durationMs += entry.duration
      const bucket = gc.byKind[kind] ??= { count: 0, durationMs: 0 }
      bucket.count++
      bucket.durationMs += entry.duration
    }
  })
  observer.observe({ entryTypes: ['gc'] })
  append({ type: 'runtime-start', at: startedAt, pid: process.pid, intervalMs, delayResolutionMs: 10, scope: 'main-thread-only', version: 1 })
  function sample(type) {
    const now = performance.now()
    const intervalElapsedMs = now - previousSampleAt
    const currentElu = performance.eventLoopUtilization()
    const elu = performance.eventLoopUtilization(currentElu, previousElu)
    previousElu = currentElu
    const count = Number(histogram.count)
    const milliseconds = value => Number.isFinite(value) ? value / 1e6 : null
    const delayMs = count > 0 ? {
      count, min: milliseconds(histogram.min), max: milliseconds(histogram.max),
      mean: milliseconds(histogram.mean), stddev: milliseconds(histogram.stddev),
      p50: milliseconds(histogram.percentile(50)), p95: milliseconds(histogram.percentile(95)), p99: milliseconds(histogram.percentile(99)),
    } : { count: 0, min: null, max: null, mean: null, stddev: null, p50: null, p95: null, p99: null }
    const memory = process.memoryUsage()
    append({ type, at: new Date().toISOString(), pid: process.pid, sequence: sequence++, elapsedMs: now - started,
      intervalElapsedMs, intervalOverrunMs: type === 'runtime-sample' ? Math.max(0, intervalElapsedMs - intervalMs) : null,
      delayMs, eventLoop: { activeMs: elu.active, idleMs: elu.idle, utilization: elu.utilization }, gc,
      memory: { rssBytes: memory.rss, heapUsedBytes: memory.heapUsed, heapTotalBytes: memory.heapTotal, externalBytes: memory.external, arrayBuffersBytes: memory.arrayBuffers },
      writeErrors,
    })
    previousSampleAt = now
    histogram.reset()
    gc = freshGc()
  }
  const timer = setInterval(() => sample('runtime-sample'), intervalMs)
  timer.unref()
  // No signal/uncaught-exception handler is installed. App shutdown semantics stay
  // intact; this one-shot final asynchronous write cannot create a beforeExit loop.
  process.once('beforeExit', () => {
    if (stopped) return
    stopped = true
    clearInterval(timer)
    sample('runtime-stop')
    histogram.disable()
    observer.disconnect()
  })
}

async function selfTest() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'aether-runtime-probe-'))
  const cases = []
  const run = (name, source, timeoutMs = 7000) => new Promise((resolve, reject) => {
    const file = path.join(directory, `${name}.jsonl`)
    const started = performance.now()
    const env = { ...process.env, PRESSURE_RUNTIME_METRICS_FILE: file }
    delete env.PRESSURE_RUNTIME_METRICS_OWNER_PID
    const child = spawn(process.execPath, ['--expose-gc', '--import', pathToFileURL(ownFile).href, '--input-type=module', '-e', source], {
      env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', chunk => { stderr += chunk })
    const timeout = setTimeout(() => { child.kill(); reject(new Error(`Self-test child did not exit: ${name}`)) }, timeoutMs)
    child.once('error', error => { clearTimeout(timeout); reject(error) })
    child.once('exit', async code => {
      clearTimeout(timeout)
      if (code !== 0) return reject(new Error(`Self-test child failed: ${name}; exit=${code}; stderrBytes=${stderr.length}`))
      try {
        const rows = (await fs.readFile(file, 'utf8')).trim().split(/\r?\n/).map(JSON.parse)
        resolve({ name, durationMs: performance.now() - started, rows })
      } catch (error) { reject(error) }
    })
  })
  try {
    const [busy, idle] = await Promise.all([
      run('busy', "setTimeout(()=>{const end=performance.now()+550;while(performance.now()<end){};global.gc?.()},1700);await new Promise(r=>setTimeout(r,2700));"),
      run('async-wait', "setTimeout(()=>global.gc?.(),1700);await new Promise(r=>setTimeout(r,2700));"),
    ])
    const exit = await run('exit', 'void 0', 1500)
    const workerCode = `import(${JSON.stringify(pathToFileURL(ownFile).href)})`
    const worker = await run('worker-guard', `import {Worker} from 'node:worker_threads';const worker=new Worker(${JSON.stringify(workerCode)},{eval:true});await new Promise((resolve,reject)=>{worker.once('exit',code=>code?reject(new Error('worker exit')):resolve());worker.once('error',reject)});`)
    const forkFile = path.join(directory, 'fork-child.mjs')
    await fs.writeFile(forkFile, "await new Promise(resolve=>setTimeout(resolve,2300));process.send?.({pid:process.pid,imported:process.execArgv.includes('--import'),owner:process.env.PRESSURE_RUNTIME_METRICS_OWNER_PID});process.disconnect?.();")
    const fork = await run('fork-guard', `import {fork} from 'node:child_process';const child=fork(${JSON.stringify(forkFile)},{execArgv:['--expose-gc','--import',${JSON.stringify(pathToFileURL(ownFile).href)}],windowsHide:true,stdio:['ignore','ignore','pipe','ipc']});let proof;child.on('message',value=>proof=value);await new Promise((resolve,reject)=>{child.once('exit',code=>code?reject(new Error('fork exit')):resolve());child.once('error',reject)});if(!proof?.imported||proof.pid===process.pid||proof.owner!==String(process.pid))throw new Error('fork did not exercise inherited preload ownership');`)
    const samples = result => result.rows.filter(row => row.type !== 'runtime-start')
    const peakLag = result => Math.max(...samples(result).map(row => row.delayMs?.max ?? 0))
    if (peakLag(busy) < 300) throw new Error('Probe missed intentional main-thread blocking')
    if (peakLag(idle) >= 300) throw new Error('Idle control has excessive host latency; synthetic comparison inconclusive')
    if (!busy.rows.some(row => row.type === 'runtime-sample')) throw new Error('Two-second sample not emitted')
    if (samples(busy).some(row => row.writeErrors !== 0)) throw new Error('Probe metrics writes failed')
    if (worker.rows.filter(row => row.type === 'runtime-start').length !== 1) throw new Error('Worker inherited preload emitted duplicate metrics')
    if (fork.rows.filter(row => row.type === 'runtime-start').length !== 1 || new Set(fork.rows.map(row=>row.pid)).size !== 1) throw new Error('Fork inherited preload contaminated owner metrics')
    if (!fork.rows.some(row=>row.type === 'runtime-sample')) throw new Error('Fork guard did not span a sample interval')
    for (const result of [busy, idle, exit, worker, fork]) cases.push({ name: result.name, durationMs: result.durationMs, mainThreadPids: [...new Set(result.rows.map(row => row.pid))].length, samples: samples(result).length, maxDelayMs: peakLag(result), gcCount: samples(result).reduce((total, row) => total + (row.gc?.count ?? 0), 0) })
    console.log(JSON.stringify({ selfTest: 'passed', cases, guarantees: ['intentional blocking observed', 'asynchronous wait control responsive', 'unref timer does not keep process alive', 'worker preload is inert', 'fork preload is inert', 'metrics writes successful'] }, null, 2))
  } finally {
    // Only remove the exact files created by this test in its unique temp folder.
    for (const name of ['busy', 'async-wait', 'exit', 'worker-guard', 'fork-guard']) await fs.unlink(path.join(directory, `${name}.jsonl`)).catch(() => {})
    await fs.unlink(path.join(directory, 'fork-child.mjs')).catch(() => {})
    await fs.rmdir(directory).catch(() => {})
  }
}
