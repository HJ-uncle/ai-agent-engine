/** Isolated real-child/SQLite-process benchmark. Never opens the configured production DB.
 * Run: npx tsx scripts/diagnostics/command-storage-benchmark.ts [--baseline path/to/manager.ts]
 * A supplied baseline must export CommandJobManager with the same public paging contract.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { performance, monitorEventLoopDelay } from 'node:perf_hooks'
import { LocalSqliteProcessClient } from '../../src/storage/sqlite/local-process-client.js'
import type { CommandJobManager } from '../../src/core/command-jobs/manager.js'

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const artifacts = path.join(repository, '.e2e-tmp/command-storage')
const arg = (key: string) => { const i = process.argv.indexOf(key); return i >= 0 ? process.argv[i + 1] : undefined }
const round = (n: number) => Math.round(n * 100) / 100
const size = async (file: string) => { try { return (await fs.stat(file)).size } catch { return 0 } }
async function diskBytes(directory: string): Promise<number> {
  let total = 0
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error('Unexpected link in benchmark fixture')
    const file = path.join(directory, entry.name)
    total += entry.isDirectory() ? await diskBytes(file) : await size(file)
  }
  return total
}

async function worker(modulePath: string, fixture: string, variant: string) {
  assert(path.dirname(fixture) === artifacts && path.basename(fixture).startsWith('run-'))
  await fs.mkdir(fixture, { recursive: true })
  const database = path.join(fixture, 'jobs.db')
  const db = new LocalSqliteProcessClient({ url: pathToFileURL(database).href })
  const counters = { calls: 0, argumentBytes: 0, writeCalls: 0, writeArgumentBytes: 0 }
  const call = db.call.bind(db)
  db.call = (op, args = [], tx) => {
    const serialized = JSON.stringify(args, (_, value) => typeof value === 'bigint' ? String(value) : value)
    const bytes = Buffer.byteLength(serialized)
    counters.calls++; counters.argumentBytes += bytes
    if (['execute', 'batch', 'executeMultiple', 'migrate'].includes(op) && /\b(?:INSERT|UPDATE|DELETE|REPLACE|CREATE|ALTER)\b/i.test(serialized)) {
      counters.writeCalls++; counters.writeArgumentBytes += bytes
    }
    return call(op, args, tx)
  }
  const Constructor = (await import(pathToFileURL(modulePath).href)).CommandJobManager as typeof CommandJobManager
  const manager = new Constructor({ db })
  const delay = monitorEventLoopDelay({ resolution: 10 })
  delay.enable()
  let peakRss = process.memoryUsage().rss, peakHeap = process.memoryUsage().heapUsed
  const sample = setInterval(() => { const m = process.memoryUsage(); peakRss = Math.max(peakRss, m.rss); peakHeap = Math.max(peakHeap, m.heapUsed) }, 20)
  const scope = { tenantId: 'benchmark', sessionId: 'isolated-command-storage' }
  try {
    await manager.initialize()
    const setup = { ...counters }
    // 3 concurrent commands, 8 MiB each, including Unicode and NUL. Backpressure respected.
    // Repeat complete UTF-8 strings to avoid creating artificial invalid child output.
    const payload = Buffer.from('中🙂\u0000line\n'.repeat(1024))
    const requestedMiB = Number(arg('--mib') ?? 8)
    assert(Number.isFinite(requestedMiB) && requestedMiB >= 1 && requestedMiB <= 128, '--mib must be 1..128 per job')
    const count = Math.ceil(requestedMiB * 1024 * 1024 / payload.length)
    const bytesPerJob = count * payload.length
    const expected = createHash('sha256'); for (let i = 0; i < count; i++) expected.update(payload)
    const expectedHash = expected.digest('hex')
    const script = `const b=Buffer.from(${JSON.stringify(payload.toString('base64'))},'base64');let n=${count};function write(){while(n-->0){if(!process.stdout.write(b)){process.stdout.once('drain',write);return}}}write()`
    const start = performance.now()
    const jobs = await Promise.all(Array.from({ length: 3 }, () => manager.start({ ...scope, ownerSessionId: scope.sessionId,
      command: process.execPath, args: ['-e', script], cwd: fixture, env: { ...process.env }, background: true, timeoutMs: 120_000 })))
    const finished = await Promise.all(jobs.map(job => manager.wait(scope, job.jobId)))
    const writeMs = performance.now() - start
    for (const job of finished) assert.equal(job?.status, 'succeeded')
    const writeCounters = Object.fromEntries(Object.entries(counters).map(([key, value]) => [key, value - setup[key as keyof typeof setup]]))
    const bodyRows = await db.execute('SELECT SUM(length(CAST(text AS BLOB))) AS bytes FROM command_job_output')
    const sqliteBodyBytes = Number(bodyRows.rows[0]?.bytes ?? 0)
    if (variant === 'current') assert.equal(sqliteBodyBytes, 0)
    const walBytesBeforeCheckpoint = await size(database + '-wal')
    const hashes: string[] = []
    let pageCount = 0, firstPageMs = 0, fullReadMs = 0
    for (const job of jobs) {
      let cursor = 0, cursorOffset = 0, bytes = 0, first = true
      const hash = createHash('sha256'), began = performance.now()
      do {
        const now = performance.now()
        const page = await manager.output(scope, job.jobId, { cursor, cursorOffset, maxBytes: 65536 })
        assert(page)
        if (first) { firstPageMs += performance.now() - now; first = false }
        const text = page.entries.map(entry => entry.text).join('')
        bytes += Buffer.byteLength(text); hash.update(text); pageCount++
        if (!page.hasMore) break
        assert(page.nextCursor > cursor || (page.nextOffset ?? 0) > cursorOffset, 'Pagination must progress')
        cursor = page.nextCursor; cursorOffset = page.nextOffset ?? 0
      } while (true)
      fullReadMs += performance.now() - began
      assert.equal(bytes, bytesPerJob); const actual = hash.digest('hex'); assert.equal(actual, expectedHash); hashes.push(actual)
    }
    let tailMs: number | null = null
    if (variant === 'current') {
      const began = performance.now()
      for (let i = 0; i < 10; i++) {
        const page = await manager.output(scope, jobs[0].jobId, { tail: true, maxBytes: 65536 })
        assert(page?.tail); assert.equal(page.hasMore, false); assert.equal(page.truncated, false)
        assert(Buffer.byteLength(page.entries.map(entry => entry.text).join('')) <= 65536)
      }
      tailMs = (performance.now() - began) / 10
    }
    // A live but idle child exposes redundant snapshot writes on repeated reads.
    const idle = await manager.start({ ...scope, ownerSessionId: scope.sessionId, command: process.execPath,
      args: ['-e', "process.stdout.write('ready');setInterval(()=>{},1000)"], cwd: fixture, env: { ...process.env }, background: true, timeoutMs: 30000 })
    for (let i = 0; i < 100; i++) { if ((await manager.output(scope, idle.jobId))?.entries.length) break; await new Promise(r => setTimeout(r, 10)) }
    const beforeIdle = counters.writeCalls
    for (let i = 0; i < 20; i++) await manager.output(scope, idle.jobId)
    const idleReadWriteCalls = counters.writeCalls - beforeIdle
    if (variant === 'current') assert.equal(idleReadWriteCalls, 0)
    await manager.cancel(scope, idle.jobId)
    await manager.shutdown('benchmark_complete')
    await db.execute('PRAGMA wal_checkpoint(TRUNCATE)')
    const databaseBytes = await size(database)
    const sidecarBytes = await diskBytes(fixture) - databaseBytes - await size(database + '-wal') - await size(database + '-shm')
    return { variant, payloadBytes: bytesPerJob * 3, jobs: 3, writeMs: round(writeMs), throughputMiBPerSecond: round(bytesPerJob * 3 / 1048576 / (writeMs / 1000)),
      sqliteWrite: writeCounters, sqliteBodyBytes, databaseBytes, walBytesBeforeCheckpoint, sidecarBytes,
      pageCount, firstPageMeanMs: round(firstPageMs / 3), fullHistoryReadMs: round(fullReadMs), recentPageMeanMs: tailMs === null ? null : round(tailMs),
      idleReadWriteCalls, peakHostRssBytes: peakRss, peakHostHeapBytes: peakHeap, eventLoopP99Ms: round(delay.percentile(99) / 1e6),
      integrity: 'all byte counts and SHA-256 match', hashes, note: 'Host memory excludes SQLite/command children; wall-clock samples depend on machine load.' }
  } finally {
    clearInterval(sample); delay.disable()
    await manager.shutdown('benchmark_cleanup')
    const receipt = await db.closeWithReceipt()
    assert(receipt.healthy, JSON.stringify(receipt))
  }
}

await fs.mkdir(artifacts, { recursive: true })
if (arg('--worker')) {
  const result = await worker(path.resolve(arg('--worker')!), path.resolve(arg('--fixture')!), arg('--variant')!)
  await fs.writeFile(path.join(arg('--fixture')!, 'result.json'), JSON.stringify(result, null, 2))
} else {
  const baseline = arg('--baseline'), runId = new Date().toISOString().replace(/[:.]/g, '-')
  const variants = [...(baseline ? [{ name: 'baseline', file: path.resolve(baseline) }] : []), { name: 'current', file: path.join(repository, 'src/core/command-jobs/manager.ts') }]
  const results = []
  for (const variant of variants) {
    const fixture = path.join(artifacts, `run-${runId}-${variant.name}`)
    await fs.mkdir(fixture)
    const log = await fs.open(path.join(fixture, 'worker.log'), 'w')
    try {
      const exit = await new Promise<number | null>((resolve, reject) => {
        const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(import.meta.url), '--worker', variant.file, '--fixture', fixture, '--variant', variant.name, '--mib', arg('--mib') ?? '8'],
          { cwd: repository, windowsHide: true, stdio: ['ignore', log.fd, log.fd] })
        child.once('error', reject); child.once('exit', resolve)
      })
      assert.equal(exit, 0, `Benchmark failed: ${path.join(fixture, 'worker.log')}`)
      results.push(JSON.parse(await fs.readFile(path.join(fixture, 'result.json'), 'utf8')))
    } finally { await log.close() }
  }
  const report = path.join(artifacts, `comparison-${runId}.json`)
  await fs.writeFile(report, JSON.stringify({ capturedAt: new Date().toISOString(), results }, null, 2))
  console.log(JSON.stringify({ report, results }, null, 2))
}
