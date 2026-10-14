/** Exact captured admissions/real child identities: no provider calls or mocked process termination. */
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CommandJobManager } from '../manager.js'
import type { CommandJobLaunch, CommandScopeCapture } from '../types.js'
import { LocalSqliteProcessClient } from '../../../storage/sqlite/local-process-client.js'
import * as processTree from '../process-tree.js'

const barrier = () => { let release!: () => void; const promise = new Promise<void>(yes => { release = yes }); return { promise, release } }
const holds: ReturnType<typeof barrier>[] = []
const hold = () => { const value = barrier(); holds.push(value); return value }
const managers: CommandJobManager[] = []
let root: string, db: LocalSqliteProcessClient, manager: CommandJobManager
const scope = { tenantId: 'owned-command', sessionId: 'shared-session' }
const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
function launch(marker: string): CommandJobLaunch {
  return { ...scope, ownerSessionId: scope.sessionId, command: process.execPath,
    args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(path.join(root, marker))},String(process.pid));setInterval(()=>{},1000)`],
    cwd: root, env: { ...process.env }, background: true }
}
async function pid(marker: string) {
  await vi.waitFor(() => expect(fs.existsSync(path.join(root, marker))).toBe(true), { timeout: 10_000 })
  return Number(fs.readFileSync(path.join(root, marker), 'utf8'))
}
beforeEach(async () => {
  root = path.resolve('.e2e-tmp', 'owned-command-' + randomUUID()); fs.mkdirSync(root, { recursive: true })
  db = new LocalSqliteProcessClient({ url: `file:${path.join(root, 'command.db').replaceAll('\\', '/')}` })
  manager = new CommandJobManager({ db }); managers.push(manager); await manager.initialize()
})
afterEach(async () => {
  for (const value of holds.splice(0)) value.release()
  const stops = await Promise.allSettled(managers.splice(0).map(value => value.shutdown('Fixture finished')))
  const receipt = await db.closeWithReceipt(); expect(receipt.healthy, JSON.stringify(receipt)).toBe(true)
  vi.restoreAllMocks()
  if (!root.startsWith(path.resolve('.e2e-tmp') + path.sep)) throw new Error('Unsafe command fixture cleanup path')
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 30 })
  const failed = stops.find((value): value is PromiseRejectedResult => value.status === 'rejected')
  if (failed) throw failed.reason
})

describe('exact owned command stop capture', () => {
  it('revokes a held old launch admission and joins its terminal write while a later same-session child remains running', async () => {
    const entered = hold(), receipt = hold(), native = db.batch.bind(db); let block = true
    vi.spyOn(db, 'batch').mockImplementation(async (statements, mode) => {
      const value = await native(statements, mode)
      if (block && statements.some(statement => typeof statement !== 'string' && !Array.isArray(statement) && Array.isArray(statement.args)
        && typeof statement.args[5] === 'string' && JSON.parse(statement.args[5]).status === 'running')) {
        block = false; entered.release(); await receipt.promise
      }
      return value
    })
    const input = launch('old.pid'), old = manager.start(input); void old.catch(() => undefined)
    await entered.promise
    // Mutating caller data must not rename the already registered admission.
    input.sessionId = 'later-mutated-session'; input.args.splice(0)
    const capture = manager.captureScope(scope)
    expect(manager.hasCapturedWork(capture)).toBe(true)
    let settled = false
    const cancelling = manager.cancelCaptured(capture).then(value => { settled = true; return value })
    const later = await manager.start(launch('later.pid')), laterPid = await pid('later.pid')
    expect(settled).toBe(false); expect(alive(laterPid)).toBe(true); expect(fs.existsSync(path.join(root, 'old.pid'))).toBe(false)
    receipt.release(); await expect(old).rejects.toThrow('stopping'); await cancelling
    expect((await manager.list(scope)).find(value => value.jobId !== later.jobId)?.status).toBe('cancelled')
    expect((await manager.get(scope, later.jobId))?.status).toBe('running'); expect(alive(laterPid)).toBe(true)
    expect(manager.cancelCaptured(capture)).toBe(manager.cancelCaptured(capture))
  }, 20_000)

  it('rejects copied, foreign-manager and closed-datasource captures without canceling the owner child', async () => {
    const job = await manager.start(launch('owner.pid')), ownerPid = await pid('owner.pid'), capture = manager.captureScope(scope)
    const other = new CommandJobManager({ db }); managers.push(other)
    expect(() => other.cancelCaptured(capture)).toThrow('same-manager')
    expect(() => manager.cancelCaptured({ ...capture } as CommandScopeCapture)).toThrow('same-manager')
    expect(alive(ownerPid)).toBe(true); expect((await manager.get(scope, job.jobId))?.status).toBe('running')
    await manager.cancelCaptured(capture); expect(alive(ownerPid)).toBe(false)
    db.close(); expect(() => manager.cancelCaptured(capture)).toThrow('same-manager')
  }, 20_000)

  it('keeps a shutdown failure sticky and waits for every other real child close and held terminal ACK before rejecting', async () => {
    const denied = await manager.start(launch('denied.pid')), deniedPid = await pid('denied.pid')
    const joined = await manager.start(launch('joined.pid')), joinedPid = await pid('joined.pid')
    const failedStop = hold(), ackEntered = hold(), receipt = hold(), batch = db.batch.bind(db)
    vi.spyOn(db, 'batch').mockImplementation(async (statements, mode) => {
      const result = await batch(statements, mode)
      if (statements.some(statement => typeof statement !== 'string' && !Array.isArray(statement) && Array.isArray(statement.args)
        && statement.args[2] === joined.jobId && typeof statement.args[5] === 'string' && JSON.parse(statement.args[5]).status === 'cancelled')) {
        ackEntered.release(); await receipt.promise
      }
      return result
    })
    const terminate = processTree.stopCommandProcessTree
    let deniedChild: Parameters<typeof terminate>[0] | undefined
    const stopSpy = vi.spyOn(processTree, 'stopCommandProcessTree').mockImplementation(async (child, createdAt) => {
      if (child.pid === deniedPid) {
        deniedChild = child; failedStop.release(); throw new Error('Synthetic owned process stop refused')
      }
      return terminate(child, createdAt)
    })
    let returned = false
    const closing = manager.shutdown('Owned shutdown failure')
    void closing.then(() => { returned = true }, () => { returned = true })
    try {
      await failedStop.promise; await ackEntered.promise
      expect(manager.shutdown('A retry must not erase the first failure')).toBe(closing)
      expect(returned).toBe(false)
      expect(alive(deniedPid)).toBe(true); expect(alive(joinedPid)).toBe(false)
      receipt.release()
      await expect(closing).rejects.toThrow('COMMAND_CLEANUP_UNKNOWN')
      expect(returned).toBe(true)
    } finally {
      receipt.release(); stopSpy.mockRestore()
      // Only the exact ChildProcess observed by this fixture can be reclaimed.
      if (deniedChild) await terminate(deniedChild, denied.createdAt)
      await manager.wait(scope, denied.jobId)
    }
    expect(alive(deniedPid)).toBe(false)
    expect((await manager.get(scope, denied.jobId))?.error?.code).toBe('COMMAND_TERMINATION_FAILED')
    expect(manager.shutdown('Physical recovery still preserves failure')).toBe(closing)
    await expect(manager.shutdown()).rejects.toThrow('COMMAND_CLEANUP_UNKNOWN')
    // The expected failed close is asserted above and stays sticky; a second
    // cleanup call must not reinterpret it as a successful service close.
    managers.splice(managers.indexOf(manager), 1)
  }, 30_000)

  it('waits for an already dispatched pending retry persist before rejecting the sticky close receipt', async () => {
    const job = await manager.start(launch('retry.pid')), childPid = await pid('retry.pid')
    const entered = hold(), receipt = hold(), batch = db.batch.bind(db); let rejectTerminal = true
    vi.spyOn(db, 'batch').mockImplementation(async (statements, mode) => {
      const terminal = statements.some(statement => typeof statement !== 'string' && !Array.isArray(statement) && Array.isArray(statement.args)
        && statement.args[2] === job.jobId && typeof statement.args[5] === 'string' && JSON.parse(statement.args[5]).status === 'cancelled')
      if (terminal && rejectTerminal) { rejectTerminal = false; throw new Error('Synthetic terminal persistence failed') }
      const result = await batch(statements, mode)
      if (terminal) { entered.release(); await receipt.promise }
      return result
    })
    expect((await manager.cancel(scope, job.jobId))?.error?.code).toBe('COMMAND_PERSIST_FAILED')
    expect(alive(childPid)).toBe(false)
    await entered.promise
    let returned = false
    const closing = manager.shutdown('Stop while terminal retry ACK is held')
    void closing.then(() => { returned = true }, () => { returned = true })
    try {
      // A real independent IPC round trip lets an early close rejection run;
      // the held retry ACK remains the only unfinished write receipt.
      await db.execute('SELECT 1')
      expect(returned).toBe(false)
      receipt.release(); await expect(closing).rejects.toThrow('COMMAND_CLEANUP_UNKNOWN')
      expect((await manager.get(scope, job.jobId))?.status).toBe('cancelled')
      expect(manager.shutdown('Do not erase the prior receipt failure')).toBe(closing)
      managers.splice(managers.indexOf(manager), 1)
    } finally {
      receipt.release(); await db.execute('SELECT 1')
    }
  }, 25_000)
})
