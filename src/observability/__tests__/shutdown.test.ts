import { Writable } from 'node:stream'
import Fastify from 'fastify'
import { pino } from 'pino'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { observeShutdownStage, type ShutdownStage } from '../shutdown.js'

function logs() {
  const sink = { info: vi.fn(), warn: vi.fn() }
  const logger = { info: vi.fn(), warn: vi.fn(), child: vi.fn(() => sink) }
  const records = () => [...sink.info.mock.calls, ...sink.warn.mock.calls].map(call => call[0])
  return { logger, sink, records }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
afterEach(() => vi.useRealTimers())

describe('shutdown stage observation', () => {
  it('records start/end and returns the exact fulfilled result without inferring resource health', async () => {
    const { logger, sink, records } = logs()
    const receipt = Object.freeze({ healthy: false, errors: ['private native details'] })
    const operation = vi.fn(() => receipt)
    expect(await observeShutdownStage(logger, 'sqlite.main.close', operation)).toBe(receipt)
    expect(operation).toHaveBeenCalledOnce()
    expect(logger.child).toHaveBeenCalledWith({}, { level: 'info' })
    expect(records()).toEqual([
      { event: 'shutdown.stage', schemaVersion: 1, stage: 'sqlite.main.close', phase: 'start', elapsedMs: 0 },
      { event: 'shutdown.stage', schemaVersion: 1, stage: 'sqlite.main.close', phase: 'end', elapsedMs: expect.any(Number), outcome: 'fulfilled' },
    ])
    expect(sink.warn).not.toHaveBeenCalled()
    expect(JSON.stringify(records())).not.toContain('private native details')
    expect(records().every(record => !Object.hasOwn(record, 'healthy'))).toBe(true)
  })

  it('keeps an unhealthy SQLite receipt unchanged and logs only verified lifecycle scalars and error counts', async () => {
    const { logger, sink, records } = logs()
    const epoch = Object.freeze({ sourceEpoch: 7, pid: 41234, requested: true, acknowledged: false,
      nativeClosed: false, exited: true, stdioClosed: true, exitCode: null, signal: 'SIGTERM',
      forcedKill: true, pendingOperationsAtRequest: 2, transactionsAtRequest: 1, healthy: false,
      errors: Object.freeze(['private native connection detail']), privateField: 'private credential' })
    const receipt = Object.freeze({ healthy: false, receipts: Object.freeze([epoch]),
      errors: Object.freeze(['private aggregate detail']), privateField: 'private workspace path' })
    expect(await observeShutdownStage(logger, 'sqlite.main.close', () => receipt)).toBe(receipt)
    expect(sink.warn).toHaveBeenCalledOnce()
    expect(sink.warn.mock.calls[0][0]).toEqual({ event: 'shutdown.sqlite.close', schemaVersion: 1,
      stage: 'sqlite.main.close', healthy: false, errorCount: 1, receiptCount: 1,
      receipts: [{ sourceEpoch: 7, pid: 41234, requested: true, acknowledged: false, nativeClosed: false,
        exited: true, stdioClosed: true, exitCode: null, forcedKill: true, pendingOperationsAtRequest: 2,
        transactionsAtRequest: 1, healthy: false, errorCount: 1 }] })
    expect(sink.info.mock.calls.at(-1)?.[0]).toMatchObject({ phase: 'end', outcome: 'fulfilled' })
    expect(JSON.stringify(records())).not.toContain('private')
    expect(epoch.errors).toEqual(['private native connection detail'])
    expect(receipt.healthy).toBe(false)
  })

  it('warns while pending without settling, cancelling or repeating the original operation', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
    const { logger, sink, records } = logs()
    const held = deferred<string>(), operation = vi.fn(() => held.promise)
    let settled = false
    const closing = observeShutdownStage(logger, 'http.server.close', operation, { pendingAfterMs: 100 }).finally(() => { settled = true })
    await vi.advanceTimersByTimeAsync(350)
    expect(settled).toBe(false)
    expect(operation).toHaveBeenCalledOnce()
    expect(sink.warn).toHaveBeenCalledOnce()
    expect(sink.warn.mock.calls[0][0]).toEqual({ event: 'shutdown.stage', schemaVersion: 1,
      stage: 'http.server.close', phase: 'pending', elapsedMs: 100 })
    expect(records().some(record => record.phase === 'end')).toBe(false)
    held.resolve('closed by its owner')
    await expect(closing).resolves.toBe('closed by its owner')
    expect(sink.info.mock.calls.at(-1)?.[0]).toMatchObject({ phase: 'end', elapsedMs: 350, outcome: 'fulfilled' })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('preserves the exact rejection without logging error messages, properties or arguments', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
    const { logger, sink, records } = logs()
    const secret = Object.assign(new Error('private request body and credential'), { code: 'private-secret-code' })
    const held = deferred<void>()
    const closing = observeShutdownStage(logger, 'maintenance.audit.stop', () => held.promise, { pendingAfterMs: 100 })
    const failed = expect(closing).rejects.toBe(secret)
    await vi.advanceTimersByTimeAsync(25)
    held.reject(secret)
    await failed
    expect(sink.info.mock.calls.at(-1)?.[0]).toMatchObject({ phase: 'end', elapsedMs: 25, outcome: 'rejected' })
    expect(JSON.stringify(records())).not.toContain('private')
    await vi.advanceTimersByTimeAsync(500)
    expect(sink.warn).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('observes a synchronous throw without converting it into a fulfilled close', async () => {
    const { logger, sink } = logs()
    const reason = new Error('do not log me')
    await expect(observeShutdownStage(logger, 'engine.skills.stop', () => { throw reason })).rejects.toBe(reason)
    expect(sink.info.mock.calls.at(-1)?.[0]).toMatchObject({ phase: 'end', outcome: 'rejected' })
  })

  it('keeps logger construction and log-write failures from altering the cleanup operation', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
    const failing = () => { throw new Error('logging failed') }
    const logger = { info: vi.fn(failing), warn: vi.fn(failing), child: vi.fn(failing) }
    const held = deferred<number>(), operation = vi.fn(() => held.promise)
    const closing = observeShutdownStage(logger, 'sqlite.memory.close', operation, { pendingAfterMs: 100 })
    await vi.advanceTimersByTimeAsync(100)
    held.resolve(42)
    await expect(closing).resolves.toBe(42)
    expect(operation).toHaveBeenCalledOnce()
    expect(logger.info).toHaveBeenCalledTimes(2)
    expect(logger.warn).toHaveBeenCalledOnce()
  })

  it('rejects a non-allowlisted stage before invoking the operation or emitting its value', async () => {
    const { logger, records } = logs(), operation = vi.fn()
    const invalid = 'private path or task data' as ShutdownStage
    await expect(observeShutdownStage(logger, invalid, operation)).rejects.toThrow('Unknown shutdown stage')
    expect(operation).not.toHaveBeenCalled()
    expect(records()).toEqual([])
  })

  it('retains start/end evidence with a real warn-level logger without changing its level', async () => {
    let output = ''
    const stream = new Writable({ write(chunk, _encoding, callback) { output += String(chunk); callback() } })
    const logger = pino({ level: 'warn' }, stream)
    logger.info({ marker: 'ordinary info remains suppressed' }, 'not a shutdown record')
    await observeShutdownStage(logger, 'engine.shutdown', () => undefined)
    const records = output.trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
    expect(logger.level).toBe('warn')
    expect(records).toHaveLength(2)
    expect(records.map(record => record.phase)).toEqual(['start', 'end'])
    expect(records.every(record => record.level === 30 && record.event === 'shutdown.stage')).toBe(true)
    expect(output).not.toContain('ordinary info remains suppressed')
    stream.end()
  })

  it('keeps Fastify close pending until preClose drains, then observes the real onClose work', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
    const { logger, sink } = logs(), held = deferred<void>()
    const app = Fastify()
    const effects: string[] = []
    app.addHook('preClose', () => observeShutdownStage(logger, 'http.owned.stop', async () => {
      effects.push('owner-stop-started')
      await held.promise
      effects.push('owner-stop-finished')
    }, { pendingAfterMs: 100 }))
    app.addHook('onClose', () => observeShutdownStage(logger, 'sqlite.knowledge.close', () => { effects.push('database-closed') }))
    await app.ready()
    let settled = false
    const closing = observeShutdownStage(logger, 'http.server.close', () => app.close(), { pendingAfterMs: 100 }).finally(() => { settled = true })
    try {
      await vi.advanceTimersByTimeAsync(250)
      expect(settled).toBe(false)
      expect(effects).toEqual(['owner-stop-started'])
      expect(sink.warn.mock.calls.map(call => call[0].stage).sort()).toEqual(['http.owned.stop', 'http.server.close'])
    } finally { held.resolve(); await closing }
    expect(effects).toEqual(['owner-stop-started', 'owner-stop-finished', 'database-closed'])
    expect(sink.info.mock.calls.filter(call => call[0].phase === 'end').map(call => call[0].stage))
      .toEqual(['http.owned.stop', 'sqlite.knowledge.close', 'http.server.close'])
    expect(vi.getTimerCount()).toBe(0)
  })
})
