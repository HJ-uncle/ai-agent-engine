/** Held evidence/commit/ACK barriers and real isolated WAL verify publication order, budgets and executor isolation. */
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BoundedPublicationQueue } from '../publication-queue.js'
import { busToIterable, StreamBus, type StreamBusOptions } from '../stream-bus.js'
import { LocalSqliteProcessClient } from '../../../storage/sqlite/local-process-client.js'
import { SubagentStore } from '../../subagent/store.js'
import { ParentPublicationAuthority } from '../../subagent/parent-publication.js'
import type { CreateSubagentRun } from '../../subagent/types.js'
import type { Transaction } from '@libsql/client'

function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
const frame = (name: string, value: unknown) => '\x00__' + name + '__' + JSON.stringify(value)
const basicHooks = (): NonNullable<StreamBusOptions['publication']> => ({ beforeAppend: async () => {}, beforeTerminal: async () => {} })
const captured = <T>(promise: Promise<T>) => promise.then(value => ({ value, error: undefined }), error => ({ value: undefined, error }))

describe('bounded serial publication and actual StreamBus', () => {
  it('isolates throwing data viewers, preserving committed cursor, other readers and future publications', async () => {
    const controller = new AbortController(), bus = new StreamBus(controller, { publication: basicHooks() })
    const faulty = vi.fn(() => { throw new Error('synthetic-viewer-data') })
    bus.emitter.on('data', faulty)
    const reader = busToIterable(bus), read = reader.next()
    const first = await bus.publish('first')
    expect(await read).toEqual({ done: false, value: first })
    expect(bus.snapshot()).toMatchObject({ eventId: bus.streamId + ':1', observerFailures: { data: 1, end: 0, error: 0, lifecycle: 0 } })
    expect(bus.snapshot().publicationRecovery).toBeUndefined()
    expect(controller.signal.aborted).toBe(false)
    await bus.publish('second'); expect(faulty).toHaveBeenCalledTimes(1)
    expect((await reader.next()).value?.chunk).toBe('second')
    await bus.endOrdered(); expect((await reader.next()).done).toBe(true)
  })
  it('isolates throwing end callbacks and preserves once removal and listener receiver', async () => {
    const bus = new StreamBus(new AbortController(), { publication: basicHooks() })
    const seen: unknown[] = []
    bus.emitter.on('end', () => { throw new Error('synthetic-viewer-end') })
    bus.emitter.once('end', function (this: typeof bus.emitter) { seen.push(this) })
    const reader = busToIterable(bus), read = reader.next()
    await expect(bus.endOrdered()).resolves.toBeUndefined()
    expect(await read).toEqual({ done: true, value: undefined })
    expect(seen).toEqual([bus.emitter]); expect(bus.emitter.listenerCount('end')).toBe(0)
    expect(bus.snapshot().observerFailures).toEqual({ data: 0, end: 1, error: 0, lifecycle: 0 })
    expect(bus.snapshot().publicationRecovery).toBeUndefined()
  })
  it('isolates throwing error callbacks after evidence failure without unhandled rejection or skipped readers', async () => {
    const controller = new AbortController(), bus = new StreamBus(controller, { publication: {
      beforeAppend: async () => { throw new Error('synthetic-evidence-failure') }, beforeTerminal: async () => {}
    } })
    bus.emitter.on('error', () => { throw new Error('synthetic-viewer-error') })
    const reader = busToIterable(bus), read = captured(reader.next())
    await expect(bus.publish('failed evidence')).rejects.toMatchObject({ reason: 'evidence_unavailable' })
    expect((await read).error).toMatchObject({ reason: 'evidence_unavailable' })
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(bus.finished).toBe(true); expect(controller.signal.aborted).toBe(false)
    expect(bus.snapshot().observerFailures).toEqual({ data: 0, end: 0, error: 1, lifecycle: 0 })
    expect(bus.snapshot().publicationRecovery?.lastConfirmedEventId).toBe(bus.streamId + ':0')
  })
  it.each(['data','end','error'] as const)('captures rejected %s callback promises without aborting or poisoning evidence', async event => {
    const controller = new AbortController(), bus = new StreamBus(controller, { publication: basicHooks() })
    bus.emitter.on(event, async () => { throw new Error('synthetic-async-viewer-' + event) })
    const seen = vi.fn(); bus.emitter.on(event, seen)
    if (event === 'data') await bus.publish('healthy data')
    else if (event === 'end') await bus.endOrdered()
    else await bus.errorOrdered(new Error('actual execution error'))
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(bus.snapshot().observerFailures?.[event]).toBe(1)
    expect(seen).toHaveBeenCalledTimes(1); expect(controller.signal.aborted).toBe(false)
    expect(bus.snapshot().publicationRecovery).toBeUndefined()
    if (event === 'data') { await bus.publish('next data'); await bus.endOrdered(); expect(seen).toHaveBeenCalledTimes(2) }
  })
  it('contains hostile thenable getters without changing a successful publication', async () => {
    const bus = new StreamBus(new AbortController(), { publication: basicHooks() })
    const faulty = vi.fn(() => ({ get then() { throw new Error('synthetic-thenable-getter') } }))
    bus.emitter.on('data', faulty)
    await expect(bus.publish('healthy')).resolves.toMatchObject({ chunk: 'healthy' })
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(bus.snapshot().observerFailures?.data).toBe(1)
    expect(bus.snapshot().publicationRecovery).toBeUndefined()
    await bus.publish('later'); expect(faulty).toHaveBeenCalledTimes(1); await bus.endOrdered()
  })
  it('applies the same isolation to legacy synchronous streams', () => {
    const bus = new StreamBus(new AbortController())
    bus.emitter.on('data', () => { throw new Error('legacy observer') })
    const seen = vi.fn(); bus.emitter.on('data', seen)
    expect(bus.push('legacy')?.id).toBe(bus.streamId + ':1'); expect(seen).toHaveBeenCalledTimes(1)
    bus.end(); expect(bus.snapshot().observerFailures?.data).toBe(1)
  })
  it.each(['sync','async'] as const)('contains %s data failure when removeListener observers also throw', async mode => {
    const bus = new StreamBus(new AbortController(), { publication: basicHooks() })
    bus.emitter.on('removeListener', event => { if (event === 'data') throw new Error('synthetic-remove-observer') })
    if (mode === 'sync') bus.emitter.on('data', () => { throw new Error('synthetic-reader') })
    else bus.emitter.on('data', async () => { throw new Error('synthetic-reader') })
    const reader = busToIterable(bus), read = reader.next()
    await expect(bus.publish('committed')).resolves.toMatchObject({ id: bus.streamId + ':1' })
    expect((await read).value?.chunk).toBe('committed')
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(bus.snapshot().observerFailures).toEqual({ data: 1, end: 0, error: 0, lifecycle: 1 })
    expect(bus.snapshot().publicationRecovery).toBeUndefined()
    await bus.publish('later'); expect((await reader.next()).value?.chunk).toBe('later')
    await bus.endOrdered(); expect((await reader.next()).done).toBe(true)
  })
  it.each(['end','error'] as const)('preserves once %s readers when their removeListener meta callback throws', async event => {
    const bus = new StreamBus(new AbortController(), { publication: basicHooks() })
    bus.emitter.on('removeListener', removed => { if (removed === event) throw new Error('synthetic-once-meta') })
    let called = 0
    bus.emitter.once(event, function (this: typeof bus.emitter) { expect(this).toBe(bus.emitter); called++ })
    const reader = busToIterable(bus), read = captured(reader.next())
    if (event === 'end') await bus.endOrdered(); else await bus.errorOrdered(new Error('actual-error'))
    const result = await read
    expect(called).toBe(1); expect(bus.emitter.listenerCount(event)).toBe(0)
    expect(bus.snapshot().observerFailures?.lifecycle).toBe(1)
    expect(bus.snapshot().publicationRecovery).toBeUndefined()
    if (event === 'end') expect(result.value?.done).toBe(true); else expect(result.error).toMatchObject({ message: 'actual-error' })
  })
  it.each(['sync','async'] as const)('contains %s newListener observer failure while admitting a healthy reader', async mode => {
    const bus = new StreamBus(new AbortController(), { publication: basicHooks() })
    if (mode === 'sync') bus.emitter.on('newListener', () => { throw new Error('synthetic-new-meta') })
    else bus.emitter.on('newListener', async () => { throw new Error('synthetic-new-meta') })
    let called = 0
    bus.emitter.on('data', () => { called++ })
    await new Promise<void>(resolve => setImmediate(resolve))
    await bus.publish('healthy'); expect(called).toBe(1)
    expect(bus.snapshot().observerFailures?.lifecycle).toBe(1)
    expect(bus.snapshot().publicationRecovery).toBeUndefined(); await bus.endOrdered()
  })
  it('holds an active slot until its promise settles and rejects overflowing work before invoking it', async () => {
    const queue = new BoundedPublicationQueue(2, 6), gate = deferred(), entered = deferred(), order: number[] = []
    const first = queue.run(3, async () => { entered.resolve(); await gate.promise; order.push(1); return 1 })
    await entered.promise
    const second = queue.run(3, async () => { order.push(2); return 2 })
    let invoked = false
    await expect(queue.run(0, async () => { invoked = true })).rejects.toMatchObject({ reason: 'queue_full' })
    expect(invoked).toBe(false)
    expect(queue.stats).toMatchObject({ pendingEvents: 2, pendingBytes: 6, highWaterEvents: 2, maxInFlight: 1 })
    gate.resolve(); expect(await Promise.all([first, second])).toEqual([1, 2]); await queue.join()
    expect(order).toEqual([1, 2]); expect(queue.stats.pendingBytes).toBe(0); expect(queue.stats.pendingEvents).toBe(0)
  })
  it('measures actual UTF8 and rejects a single oversized frame instead of truncating its identity', async () => {
    const bus = new StreamBus(new AbortController(), { publication: { ...basicHooks(), maxBytes: 5 } })
    await expect(bus.publish('中文')).rejects.toMatchObject({ reason: 'oversized_frame' })
    expect(bus.events).toEqual([]); expect(bus.snapshot().publicationRecovery?.reason).toBe('oversized_frame')
    expect(bus.publicationStats.highWaterBytes).toBe(0)
  })
  it('puts text, thinking, tool state and terminal behind the same held child evidence commit', async () => {
    const gate = deferred(), entered = deferred(), trace: string[] = []
    const bus = new StreamBus(new AbortController(), { publication: {
      beforeAppend: async (seq, chunk) => { if (chunk === 'child') { entered.resolve(); await gate.promise }; trace.push('evidence:' + seq) },
      beforeTerminal: async seq => { trace.push('terminal:' + seq) }
    } })
    bus.emitter.on('data', payload => { trace.push('visible:' + payload.id.split(':').at(-1)) })
    bus.emitter.on('end', () => { trace.push('end') })
    const child = bus.publish('child'); await entered.promise
    const text = bus.publish('text'), thinking = bus.publish(frame('thinking', 'thinking')),
      tool = bus.publish(frame('tool_end', { toolCallId: 'tool', status: 'succeeded' })), end = bus.endOrdered()
    expect(bus.finished).toBe(false); expect(bus.events).toEqual([])
    expect(await bus.publish('after terminal gate')).toBeUndefined()
    gate.resolve(); await Promise.all([child, text, thinking, tool, end])
    expect(trace).toEqual(['evidence:1','visible:1','evidence:2','visible:2','evidence:3','visible:3','evidence:4','visible:4','terminal:4','end'])
    expect(bus.events.map(item => item.id)).toEqual([1, 2, 3, 4].map(seq => bus.streamId + ':' + seq))
    expect(bus.finished).toBe(true); expect(bus.publicationStats.pendingEvents).toBe(0)
  })
  it('forbids every synchronous write entry point on a modern stream', async () => {
    const bus = new StreamBus(new AbortController(), { publication: basicHooks() })
    expect(() => bus.push('text')).toThrow('awaited ordered')
    expect(() => bus.publishRunState({ runId: 'r', version: 2 })).toThrow('awaited ordered')
    expect(() => bus.end()).toThrow('awaited ordered'); expect(() => bus.error(new Error('fault'))).toThrow('awaited ordered')
    await bus.endOrdered(); expect(bus.finished).toBe(true)
  })
  it('does not let synchronous legacy calls jump an in-flight async publication', async () => {
    const gate = deferred(), bus = new StreamBus(new AbortController())
    const held = bus.atPublicationFence(async () => { await gate.promise })
    expect(() => bus.push('jump')).toThrow('awaited ordered')
    gate.resolve(); await held
    expect(bus.push('after')?.id).toBe(bus.streamId + ':1'); bus.end()
  })
  it('pins a read inside queue order while later admitted text waits for the actual read completion', async () => {
    const bus = new StreamBus(new AbortController(), { publication: basicHooks() }), gate = deferred(), entered = deferred()
    await bus.publish('before')
    const read = bus.atPublicationFence(async snapshot => { entered.resolve(); await gate.promise; return snapshot })
    await entered.promise
    const after = bus.publish('after')
    expect(bus.lastEventId).toBe(bus.streamId + ':1'); expect(bus.publicationStats.pendingEvents).toBe(2)
    gate.resolve(); const snapshot = await read; await after
    expect(snapshot.eventId).toBe(bus.streamId + ':1'); expect(snapshot.projection).toEqual([{ content: 'before' }])
    expect(bus.snapshot().projection).toEqual([{ content: 'beforeafter' }]); await bus.endOrdered()
  })
  it('does not poison the running executor when a viewer read fails or a read-only queue request is full', async () => {
    const bus = new StreamBus(new AbortController(), { publication: { ...basicHooks(), maxEvents: 1 } }), gate = deferred(), entered = deferred()
    await expect(bus.atPublicationFence(async () => { throw new Error('expired viewer token') })).rejects.toThrow('expired viewer token')
    const read = bus.atPublicationFence(async () => { entered.resolve(); await gate.promise })
    await entered.promise
    await expect(bus.atPublicationFence(async () => 'overflow read')).rejects.toMatchObject({ reason: 'queue_full' })
    expect(bus.snapshot().publicationRecovery).toBeUndefined(); expect(bus.finished).toBe(false)
    gate.resolve(); await read; expect((await bus.publish('healthy'))?.chunk).toBe('healthy'); await bus.endOrdered()
  })
  it('joins held evidence on overflow, publishes explicit recovery and never aborts executor or sibling stream', async () => {
    const gate = deferred(), entered = deferred(), controller = new AbortController()
    const bus = new StreamBus(controller, { publication: { beforeAppend: async () => { entered.resolve(); await gate.promise }, beforeTerminal: async () => {}, maxEvents: 1 } })
    const held = captured(bus.publish('held')); await entered.promise
    await expect(bus.publish('overflow')).rejects.toMatchObject({ reason: 'queue_full' })
    expect(bus.finished).toBe(false); expect(bus.publicationStats.pendingEvents).toBe(1); expect(controller.signal.aborted).toBe(false)
    const sibling = new StreamBus(new AbortController(), { publication: basicHooks() })
    expect((await sibling.publish('peer work'))?.chunk).toBe('peer work'); await sibling.endOrdered()
    gate.resolve(); expect((await held).error).toMatchObject({ reason: 'queue_full' })
    await vi.waitFor(() => expect(bus.finished).toBe(true))
    expect(bus.events).toEqual([]); expect(bus.publicationStats.pendingEvents).toBe(0)
    expect(bus.snapshot().publicationRecovery?.lastConfirmedEventId).toBe(bus.streamId + ':0')
  })
  it('does not notify end before a held terminal evidence write commits', async () => {
    const gate = deferred(), entered = deferred(), bus = new StreamBus(new AbortController(), { publication: {
      beforeAppend: async () => {}, beforeTerminal: async () => { entered.resolve(); await gate.promise }
    } })
    await bus.publish('body'); const end = bus.endOrdered(); await entered.promise
    expect(bus.finished).toBe(false); expect(bus.endOrdered()).toBe(end)
    gate.resolve(); await end; expect(bus.finished).toBe(true)
  })
  it('checks run-state identity/version inside order and can update a durable ended waiting run', async () => {
    const bus = new StreamBus(new AbortController(), { publication: basicHooks() })
    await bus.publish(frame('run', { runId: 'owned', version: 2, status: 'waiting' })); await bus.endOrdered()
    const late = bus.publishRunStateOrdered({ runId: 'owned', version: 1 })
    const wrong = bus.publishRunStateOrdered({ runId: 'other', version: 99 })
    expect(await late).toBeUndefined(); expect(await wrong).toBeUndefined()
    const cancelled = { runId: 'owned', version: 3, status: 'cancelled' }
    expect((await bus.publishRunStateOrdered(cancelled))?.id).toBe(bus.streamId + ':2')
    expect(bus.finished).toBe(true); expect(bus.snapshot().projection).toEqual([{ run: cancelled }])
  })
  it('rejects unadmitted seed watermarks rather than claiming a new stream published old children', () => {
    expect(() => new StreamBus(new AbortController(), { publication: basicHooks(), initialSubagentWatermarks: [{ runId: 'old', seq: 2 }] })).toThrow('unadmitted child evidence')
    const bus = new StreamBus(new AbortController(), { publication: basicHooks() })
    expect(() => bus.seedProjection([], [{ runId: 'old', seq: 2 }])).toThrow('unadmitted child evidence')
    expect(bus.snapshot().subagentWatermarks).toBeUndefined()
  })
})

describe('parent publisher and signed lease against actual SQLite WAL', () => {
  let directory: string, a: LocalSqliteProcessClient, b: LocalSqliteProcessClient, store: SubagentStore,
    authority: ParentPublicationAuthority, bus: StreamBus
  const parent = { tenantId: 'synthetic-publication', parentSessionId: 'parent', rootSessionId: 'root', parentTurnId: 'turn', rootRunId: 'root-run', attemptId: 'attempt' }
  const fixtureRoot = path.resolve(process.cwd(), 'publication-fixtures')
  const fixtureReceipts: Array<{ directory: string; closed: boolean; removed: boolean }> = []
  async function child(id: string, tokens = 80) {
    const input: CreateSubagentRun = { ...parent, runId: id, parentConversationId: parent.parentTurnId, parentMessageId: 'message-' + id,
      parentToolCallId: 'tool-' + id, childSessionId: 'child-' + id, modelId: 'synthetic-no-model', task: 'Publication contract', description: 'No model call' }
    await store.createRunDelta(input)
    const mutation = await store.recordUsageDelta(parent.tenantId, id, { invocationId: 'initial-' + id, promptTokens: tokens, completionTokens: 0 })
    if (!mutation) throw new Error('Missing child fixture')
    return mutation
  }
  const markCount = async () => Number((await b.execute('SELECT count(*) AS count FROM parent_publication_marks')).rows[0].count)
  beforeEach(async () => {
    fs.mkdirSync(fixtureRoot, { recursive: true }); directory = fs.mkdtempSync(path.join(fixtureRoot, 'owned-'))
    fixtureReceipts.push({ directory, closed: false, removed: false })
    const url = 'file:' + path.join(directory, 'fixture.db').replaceAll('\\', '/')
    a = new LocalSqliteProcessClient({ url }); await a.execute('PRAGMA journal_mode=WAL')
    store = new SubagentStore(a); await store.captureChildUsage(parent.tenantId, parent.parentSessionId)
    b = new LocalSqliteProcessClient({ url })
    authority = new ParentPublicationAuthority(a, parent); bus = new StreamBus(new AbortController(), { publication: authority.hooks })
    await bus.atPublicationFence(async () => {})
  })
  afterEach(async () => {
    vi.restoreAllMocks(); a.close(); b.close(); await Promise.all([a.whenClosed(), b.whenClosed()])
    fixtureReceipts.at(-1)!.closed = true
    const target = path.resolve(directory)
    if (path.dirname(target) !== fixtureRoot || !path.basename(target).startsWith('owned-')) throw new Error('Unsafe fixture cleanup')
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    fixtureReceipts.at(-1)!.removed = !fs.existsSync(target)
    fs.writeFileSync(path.resolve(process.cwd(), 'publication-fixture-receipts.json'), JSON.stringify(fixtureReceipts, null, 2) + '\n')
  })
  it('does not commit one ordinary SQLite transaction per text token and snapshots exact parent E', async () => {
    const spy = vi.spyOn(a, 'transaction')
    for (let index = 0; index < 50; index++) await bus.publish('a')
    expect(spy).toHaveBeenCalledTimes(0)
    const lease = await authority.capture(bus)
    expect(lease.data.fence.eventSequence).toBe(50); expect(lease.data.totalPublishedCount).toBe(0)
    expect(lease.data.usage.totalTokens).toBe(0); expect(bus.snapshot().projection).toEqual([{ content: 'a'.repeat(50) }])
    await bus.endOrdered()
  })
  it('holds child projection, normal text and end until actual committed evidence ACK is received', async () => {
    const mutation = await child('one'), committed = deferred(), gate = deferred()
    const original = a.transaction.bind(a)
    let hold = true
    vi.spyOn(a, 'transaction').mockImplementation(async mode => {
      const tx = await original(mode)
      if (mode === 'write' && hold) { hold = false; const commit = tx.commit.bind(tx)
        tx.commit = async () => { await commit(); committed.resolve(); await gate.promise }
      }
      return tx
    })
    const published = bus.publish(frame('subagent_event', mutation.event)); await committed.promise
    expect(await markCount()).toBe(1); expect(bus.events).toEqual([]); expect(bus.snapshot().subagentWatermarks).toBeUndefined()
    const text = bus.publish('after child'), end = bus.endOrdered()
    expect(bus.finished).toBe(false)
    gate.resolve(); await Promise.all([published, text, end])
    expect(bus.events.map(item => item.id)).toEqual([1, 2].map(seq => bus.streamId + ':' + seq))
    expect(bus.snapshot().subagentWatermarks).toEqual([{ runId: 'one', seq: mutation.header.lastSeq }])
  })
  it('freezes exact E/R/U during queued lease issuance while another WAL connection advances future child usage', async () => {
    const first = await child('one', 80), second = await child('two', 20)
    await bus.publish(frame('subagent_event', first.event)); await bus.publish(frame('subagent_event', second.event))
    const committed = deferred(), gate = deferred(), original = authority.leases.issue.bind(authority.leases)
    vi.spyOn(authority.leases, 'issue').mockImplementation(async (...args) => { const lease = await original(...args); committed.resolve(); await gate.promise; return lease })
    const capturedLease = authority.capture(bus, 1); await committed.promise
    const peer = new SubagentStore(b)
    const future = await peer.recordUsageDelta(parent.tenantId, 'one', { invocationId: 'future', promptTokens: 900, completionTokens: 0 })
    if (!future) throw new Error('Missing future child')
    const queued = bus.publish(frame('subagent_event', future.event))
    expect(bus.lastEventId).toBe(bus.streamId + ':2')
    gate.resolve(); const lease = await capturedLease; await queued
    expect(lease.data.fence.eventSequence).toBe(2); expect(lease.data.usage.totalTokens).toBe(100)
    const page2 = await authority.leases.read(parent, lease.data.snapshotId, lease.data.nextCursor, 1)
    expect(page2.data.fence).toEqual(lease.data.fence); expect(page2.data.usage.totalTokens).toBe(100)
    expect(page2.data.refs[0].identity.runId).toBe('two')
    const lookup = await authority.leases.lookup(parent, lease.data.snapshotId, 'one')
    expect(lookup.item?.atSeq).toBe(first.header.lastSeq); expect(lookup.item?.atSeq).not.toBe(future.header.lastSeq)
    await bus.endOrdered()
  })
  it('rolls actual deferred-FK COMMIT failure back without advancing projection or broadcasting the child', async () => {
    const mutation = await child('one')
    await a.executeMultiple('PRAGMA foreign_keys=ON; CREATE TABLE publication_fk_parent(id INTEGER PRIMARY KEY); CREATE TABLE publication_fk_child(id INTEGER REFERENCES publication_fk_parent(id) DEFERRABLE INITIALLY DEFERRED);')
    const original = a.transaction.bind(a); let fault = true
    vi.spyOn(a, 'transaction').mockImplementation(async mode => {
      const tx = await original(mode)
      if (mode === 'write' && fault) { fault = false; const commit = tx.commit.bind(tx)
        tx.commit = async () => { await tx.execute('INSERT INTO publication_fk_child VALUES(999)'); await commit() }
      }
      return tx
    })
    await expect(bus.publish(frame('subagent_event', mutation.event))).rejects.toMatchObject({ reason: 'evidence_unavailable' })
    expect(await markCount()).toBe(0); expect(Number((await b.execute('SELECT count(*) AS count FROM publication_fk_child')).rows[0].count)).toBe(0)
    expect(bus.lastEventId).toBe(bus.streamId + ':0'); expect(bus.snapshot().subagentWatermarks).toBeUndefined()
    await vi.waitFor(() => expect(bus.finished).toBe(true))
    expect(bus.abortController.signal.aborted).toBe(false)
  })
  it('distinguishes committed evidence with lost ACK from a delivered child event and preserves the old confirmed E', async () => {
    const mutation = await child('one'), original = a.transaction.bind(a); let fault = true
    vi.spyOn(a, 'transaction').mockImplementation(async mode => {
      const tx = await original(mode)
      if (mode === 'write' && fault) { fault = false; const commit = tx.commit.bind(tx)
        tx.commit = async () => { await commit(); throw new Error('Synthetic lost evidence commit ACK') }
      }
      return tx
    })
    await expect(bus.publish(frame('subagent_event', mutation.event))).rejects.toMatchObject({ reason: 'evidence_unavailable' })
    expect(await markCount()).toBe(1); expect(bus.events).toEqual([])
    expect(bus.snapshot().publicationRecovery).toMatchObject({ reason: 'evidence_unavailable', lastConfirmedEventId: bus.streamId + ':0' })
    await expect(authority.capture(bus)).rejects.toMatchObject({ code: 'publication_recovery_required' })
    expect(bus.abortController.signal.aborted).toBe(false)
  })
  it('admits a nested tool result exact checkpoint and rejects foreign identity or malformed child controls', async () => {
    const mutation = await child('one')
    await bus.publish(frame('tool_result', { toolCallId: 'tool-one', metadata: { subagent: mutation.view }, output: 'bounded output' }))
    const lease = await authority.capture(bus)
    expect(lease.data.refs.map(item => [item.identity.runId, item.atSeq])).toEqual([['one', mutation.header.lastSeq]])
    const other = new StreamBus(new AbortController(), { publication: new ParentPublicationAuthority(a, { ...parent, rootRunId: 'second' }).hooks })
    await expect(other.publish(frame('subagent_event', { ...mutation.event, identity: { ...parent, tenantId: 'foreign', parentConversationId: parent.parentTurnId } }))).rejects.toMatchObject({ reason: 'evidence_unavailable' })
    expect(other.events).toEqual([]); expect(await markCount()).toBe(1)
    const malformed = new StreamBus(new AbortController(), { publication: new ParentPublicationAuthority(a, { ...parent, rootRunId: 'third' }).hooks })
    await expect(malformed.publish('\x00__subagent_event__{invalid')).rejects.toMatchObject({ reason: 'evidence_unavailable' })
    await bus.endOrdered()
  })
})
