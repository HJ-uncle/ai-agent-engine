import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createClient, type Client } from '@libsql/client'
import { pino } from 'pino'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentContext } from '../../../core/agent-context/index.js'
import { commandJobs, type CommandJobSnapshot } from '../../../core/command-jobs/index.js'
import * as database from '../../../storage/sqlite/db.js'
import { up } from '../../../storage/sqlite/migrations/011_add_security_and_perf.js'
import { clearSecurityMode, policyEngine, setSecurityMode } from '../../../security/policy-engine.js'
import { ChangeStore } from '../../../storage/changes/index.js'
import { hashFileContent } from '../../../shared/file-version.js'
import { captureCreatedDirectories } from '../../../storage/changes/directories.js'
import { commitWriteChange, readOldSnapshot } from '../../file/change-recorder.js'
import { cmdTool, commandJobScope } from '../execute-command.js'
import { cancelCommandTool, commandOutputTool } from '../job-tools.js'
import { COMMAND_CHANGE_LIMITS, createCommandChangeObserver } from '../command-change-observer.js'
import { RootRunStore } from '../../../storage/root-runs/index.js'
import { CollaborationRuntime } from '../../../core/collaboration/runtime.js'
import { CollaborationStore } from '../../../core/collaboration/store.js'
import { ExecutionOwners } from '../../../core/collaboration/execution-owner.js'
import { SubagentStore } from '../../../core/subagent/store.js'
import { SubagentRunner } from '../../../core/subagent/runner.js'
import { JSONLConversationHistory } from '../../../storage/conversation/jsonl-history.js'
import { createAgentContext } from '../../../core/agent-context/factory.js'
import { ToolRegistry } from '../../../core/tool-registry/index.js'
import { LocalSqliteProcessClient } from '../../../storage/sqlite/local-process-client.js'

let db: Client, fixture: string, workspace: string, ctx: AgentContext
const store = new ChangeStore()
const jobOf = (result: { metadata?: Record<string, unknown> }) => result.metadata!.commandJob as CommandJobSnapshot
const script = (content: string) => { const file = path.join(workspace, 'task.cjs'); fs.writeFileSync(file, content); return file }
const execute = (content: string, options: Record<string, unknown> = {}) => cmdTool.execute({ command: process.execPath, args: [script(content)], ...options }, ctx)
const fakeJob = (): CommandJobSnapshot => ({ schemaVersion: 1, jobId: 'observed-job', sessionId: ctx.sessionId,
  ownerSessionId: ctx.sessionId, runId: 'run', turnId: 'turn', toolCallId: 'tool', version: 1, status: 'running',
  command: 'node', args: [], cwd: workspace, background: false, createdAt: Date.now(), updatedAt: Date.now(),
  exitCode: null, signal: null, cursor: 0, earliestCursor: 0 })

beforeEach(async () => {
  fixture = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'aether-command-observation-'))
  workspace = path.join(fixture, 'workspace'); fs.mkdirSync(workspace)
  vi.stubEnv('DATA_DIR', path.join(fixture, 'db.sqlite'))
  db = createClient({ url: 'file::memory:' })
  vi.spyOn(database, 'getDb').mockReturnValue(db)
  await up(db); await policyEngine.resetDefaults()
  ctx = { tenantId: 'observation', sessionId: path.basename(fixture), rootRunId: 'root-run', turnId: 'turn',
    currentToolCallId: 'launch-tool', workspaceDir: workspace, scratchDir: workspace, cwd: workspace,
    projectRoot: workspace, workspacePaths: [workspace], toolProfile: 'general', logger: pino({ level: 'silent' }) } as AgentContext
  setSecurityMode(ctx.tenantId, ctx.sessionId, 'full-access')
})
afterEach(async () => {
  await commandJobs.cancelScope(commandJobScope(ctx), 'test_cleanup')
  clearSecurityMode(ctx.tenantId, ctx.sessionId)
  if (db instanceof LocalSqliteProcessClient) expect((await db.closeWithReceipt()).healthy).toBe(true)
  else db.close()
  // AuditLogStore retains its original provider and may open this fixture's
  // real datasource in addition to the mocked client. Join it before removal.
  await database.closeDb()
  vi.restoreAllMocks(); vi.unstubAllEnvs()
  if (path.dirname(fixture) !== fs.realpathSync.native(os.tmpdir()) || !path.basename(fixture).startsWith('aether-command-observation-')) throw new Error('Unsafe cleanup')
  fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
})

describe('command workspace observation and guarded rollback', () => {
  it('tracks new command parent directories and removes only those once their files are reverted', async () => {
    const existing = path.join(workspace, 'existing'); fs.mkdirSync(existing)
    const observer = await createCommandChangeObserver(ctx, workspace, fakeJob())
    const created = path.join(workspace, 'delivery', 'nested'); fs.mkdirSync(created, { recursive: true })
    fs.writeFileSync(path.join(created, 'book.xlsx'), Buffer.from([0, 255, 1]))
    fs.writeFileSync(path.join(existing, 'notes.txt'), 'notes')
    const observed = await observer.finish(); observer.dispose()
    expect(observed.changes).toHaveLength(2)
    const preview = await store.previewRevert(ctx.tenantId, { sessionId: ctx.sessionId })
    expect(preview.changes.filter(item => item.entryType === 'directory').map(item => item.path).sort()).toEqual([created, path.dirname(created)].sort())
    const result = await store.revertBatch(ctx.tenantId, { sessionId: ctx.sessionId, reviewedCommandChangeIds: preview.changes.map(item => item.id) })
    expect(result).toMatchObject({ reverted: 4, unavailable: 0, removedDirectories: [created, path.dirname(created)] })
    expect(fs.existsSync(created)).toBe(false)
    expect(fs.existsSync(existing)).toBe(true)
  })

  it('tracks a standalone command mkdir even when no files were produced', async () => {
    const observer = await createCommandChangeObserver(ctx, workspace, fakeJob())
    const directory = path.join(workspace, 'empty'); fs.mkdirSync(directory)
    const observed = await observer.finish(); observer.dispose()
    expect(observed.changes).toEqual([])
    expect(observed.tracking).toMatchObject({ recordedCount: 0, recordedDirectoryCount: 1 })
    const preview = await store.previewRevert(ctx.tenantId, { sessionId: ctx.sessionId })
    expect(preview.changes).toEqual([expect.objectContaining({ path: directory, entryType: 'directory', requiresExplicitRevert: true })])
    expect(await store.revertBatch(ctx.tenantId, { sessionId: ctx.sessionId })).toMatchObject({ unavailable: 1 })
    expect(await store.revertBatch(ctx.tenantId, { sessionId: ctx.sessionId, reviewedCommandChangeIds: [preview.changes[0].id] })).toMatchObject({ reverted: 1, removedDirectories: [directory] })
    expect(fs.existsSync(directory)).toBe(false)
  })

  it('does not claim a managed directory created by a concurrent session', async () => {
    const observer = await createCommandChangeObserver(ctx, workspace, fakeJob())
    const directory = path.join(workspace, 'other-session'); fs.mkdirSync(directory)
    await store.recordCreatedDirectories(ctx.tenantId, { sessionId: 'other-session' }, captureCreatedDirectories(path.join(directory, '.probe'), [directory]))
    const observed = await observer.finish(); observer.dispose()
    expect(observed.tracking).toMatchObject({ status: 'partial', concurrentChangesExcluded: 1 })
    expect((await store.previewRevert(ctx.tenantId, { sessionId: ctx.sessionId })).changes).toEqual([])
    expect(fs.existsSync(directory)).toBe(true)
  })

  it('does not claim implicit parent directories created by a concurrent file/office writer', async () => {
    const observer = await createCommandChangeObserver(ctx, workspace, fakeJob())
    const directory = path.join(workspace, 'other-writer', 'delivery'), file = path.join(directory, 'report.docx')
    const snapshot = await readOldSnapshot(file)
    fs.mkdirSync(directory, { recursive: true }); fs.writeFileSync(file, Buffer.from([0, 255, 1]))
    await commitWriteChange({ ...ctx, sessionId: 'other-session' }, file, file, snapshot)
    const observed = await observer.finish(); observer.dispose()
    expect(observed.changes).toEqual([])
    expect(observed.tracking).toMatchObject({ status: 'partial', concurrentChangesExcluded: 3, recordedDirectoryCount: 0 })
    expect((await store.previewRevert(ctx.tenantId, { sessionId: ctx.sessionId })).changes).toEqual([])
    expect(fs.existsSync(file)).toBe(true)
    expect(fs.existsSync(directory)).toBe(true)
  })

  it('records real script create/edit/delete/binary changes, requires explicit selection, and restores exact bytes', async () => {
    fs.writeFileSync(path.join(workspace, 'edit.txt'), 'original')
    fs.writeFileSync(path.join(workspace, 'remove.txt'), 'keep me')
    const originalBytes = Buffer.from([0, 255, 123, 65]); fs.writeFileSync(path.join(workspace, 'book.xlsx'), originalBytes)
    const result = await execute("const fs=require('node:fs');fs.writeFileSync('created.txt','hello');fs.writeFileSync('edit.txt','changed');fs.unlinkSync('remove.txt');fs.writeFileSync('book.xlsx',Buffer.from([0,1,2,3]));")
    expect(result.success).toBe(true)
    expect(result.changes).toHaveLength(4)
    expect(jobOf(result).changeTracking).toMatchObject({ status: 'complete', recordedCount: 4 })
    expect(result.changes?.every(change => change.source === 'command-observation' && change.requiresExplicitRevert === true && change.toolCallId === 'launch-tool')).toBe(true)
    const summary = JSON.parse(result.output.split('[文件变化观察] ')[1])
    expect(summary.changes.map((change: { id: string }) => change.id)).toEqual(result.changes?.map(change => change.id))
    expect(result.output).not.toContain('"sessionId"')
    expect(result.output).not.toContain('"limits"')
    expect(jobOf(result).changeTracking?.limits).toEqual(COMMAND_CHANGE_LIMITS)
    const records = await store.list(ctx.tenantId, ctx.sessionId)
    expect(records).toHaveLength(4)
    expect(records.find(change => change.path.endsWith('book.xlsx'))?.oldSnapshotRef).toBeTruthy()
    expect(await store.revertBatch(ctx.tenantId, { sessionId: ctx.sessionId })).toMatchObject({ reverted: 0, unavailable: 4 })
    expect(fs.readFileSync(path.join(workspace, 'edit.txt'), 'utf8')).toBe('changed')
    expect(await store.revertBatch(ctx.tenantId, { sessionId: ctx.sessionId, ids: records.map(change => change.id) })).toMatchObject({ reverted: 4, conflicts: 0 })
    expect(fs.existsSync(path.join(workspace, 'created.txt'))).toBe(false)
    expect(fs.readFileSync(path.join(workspace, 'edit.txt'), 'utf8')).toBe('original')
    expect(fs.readFileSync(path.join(workspace, 'remove.txt'), 'utf8')).toBe('keep me')
    expect(fs.readFileSync(path.join(workspace, 'book.xlsx'))).toEqual(originalBytes)
  })

  it('preserves a subsequent user edit even after explicit selection', async () => {
    fs.writeFileSync(path.join(workspace, 'edit.txt'), 'before')
    const result = await execute("require('node:fs').writeFileSync('edit.txt','command')")
    fs.writeFileSync(path.join(workspace, 'edit.txt'), 'user edit after command')
    const reverted = await store.revertBatch(ctx.tenantId, { sessionId: ctx.sessionId, ids: result.changes!.map(change => String(change.id)) })
    expect(reverted).toMatchObject({ reverted: 0, conflicts: 1 })
    expect(fs.readFileSync(path.join(workspace, 'edit.txt'), 'utf8')).toBe('user edit after command')
  })

  it('attributes child command receipts to the root session, run and turn while keeping the launching tool identity', async () => {
    const rootSessionId = ctx.sessionId
    const child = { ...ctx, rootSessionId, sessionId: `${rootSessionId}-child`, runId: 'child-run',
      turnId: undefined, parentConversationId: 'parent-turn', conversationId: 'child-conversation' }
    const file = script("require('node:fs').writeFileSync('child.txt','child output')")
    const result = await cmdTool.execute({ command: process.execPath, args: [file] }, child)
    expect(result.changes).toHaveLength(1)
    expect(result.changes![0]).toMatchObject({ sessionId: rootSessionId, runId: 'root-run', turnId: 'parent-turn', toolCallId: 'launch-tool' })
    expect(result.changes![0]).not.toHaveProperty('producerChildSessionId')
    expect(result.changes![0]).not.toHaveProperty('producerRunId')
    expect(jobOf(result)).toMatchObject({ sessionId: rootSessionId, ownerSessionId: child.sessionId, ownerRunId: 'child-run' })
    expect(await store.list(ctx.tenantId, child.sessionId)).toEqual([])
    expect(await store.list(ctx.tenantId, rootSessionId)).toHaveLength(1)
  })

  it('persists the real child command observer source without claiming exclusive authorship', async () => {
    db.close()
    db = new LocalSqliteProcessClient({ url: 'file:' + path.join(fixture, 'owned.sqlite').replaceAll('\\', '/') })
    vi.mocked(database.getDb).mockReturnValue(db)
    const roots = new RootRunStore(); await roots.initialize()
    const root = await roots.create(ctx.tenantId, ctx.sessionId, 'fixture', [workspace], { memoryScope: 'off' })
    const children = new SubagentStore(db), service = new ExecutionOwners(db, new CollaborationRuntime(new CollaborationStore(db), children))
    const controller = new AbortController()
    const owner = await service.admitRoot({ tenantId: ctx.tenantId, rootRunId: root.runId,
      rootAttemptId: (await roots.get(ctx.tenantId, root.runId))!.attemptId, controller })
    const history = new JSONLConversationHistory()
    const parent = createAgentContext({ tenantId: ctx.tenantId, sessionId: ctx.sessionId, scratchDir: workspace,
      workspacePaths: [workspace], tools: new ToolRegistry(), history, logger: ctx.logger, executionOwner: owner,
      signal: controller.signal, rootRunId: root.runId, turnId: root.turnId, conversationId: root.turnId })
    await history.append({ id: 'delegate-message', role: 'assistant', content: '', conversationId: root.turnId,
      toolCall: { id: 'delegate-call', name: 'subagent_start', args: {} } }, parent)
    let recordId = '', childSessionId = '', childRunId = '', actionError: unknown
    try {
      const run = await new SubagentRunner(children).run({ tenantId: ctx.tenantId, rootSessionId: ctx.sessionId,
        parentSessionId: ctx.sessionId, parentConversationId: root.turnId, parentMessageId: 'delegate-message', parentToolCallId: 'delegate-call',
        task: 'Produce a file', description: 'Owned command fixture', modelId: 'fixture' }, parent, async execution => {
        try {
          childSessionId = execution.snapshot.childSessionId; childRunId = execution.snapshot.runId
          const child = createAgentContext({ tenantId: ctx.tenantId, sessionId: childSessionId, parentSessionId: ctx.sessionId,
            rootSessionId: ctx.sessionId, rootRunId: root.runId, turnId: root.turnId, runId: childRunId,
            scratchDir: path.join(fixture, 'child'), workspacePaths: [workspace], tools: new ToolRegistry(), history,
            logger: ctx.logger, executionOwner: execution.executionOwner, signal: execution.signal })
          const identity = { ...fakeJob(), sessionId: ctx.sessionId, ownerSessionId: childSessionId,
            runId: root.runId, ownerRunId: childRunId, turnId: root.turnId }
          await expect(createCommandChangeObserver({ ...child, runId: 'forged-run' }, workspace, identity)).rejects.toThrow('owner mismatch')
          await expect(createCommandChangeObserver(child, workspace, { ...identity, ownerRunId: 'forged-job' })).rejects.toThrow('owner mismatch')
          const scope = { tenantId: ctx.tenantId, sessionId: ctx.sessionId, runId: root.runId }
          const started = await commandJobs.start({ ...scope, ownerSessionId: childSessionId, ownerRunId: childRunId,
            turnId: root.turnId, toolCallId: 'owned-command', command: process.execPath,
            args: ['-e', "require('node:fs').writeFileSync('owned-child.txt','child command output')"],
            cwd: workspace, background: false, env: { ...process.env }, signal: execution.signal,
            observeChanges: job => createCommandChangeObserver(child, workspace, job) })
          const finished = await commandJobs.wait(scope, started.jobId)
          expect(finished).toMatchObject({ status: 'succeeded', changeTracking: { recordedCount: 1 } })
          expect(finished!.changes![0]).toMatchObject({ producerChildSessionId: childSessionId, producerRunId: childRunId,
            source: 'command-observation', requiresExplicitRevert: true, sessionId: ctx.sessionId, runId: root.runId })
          expect(finished!.changeTracking!.note).toContain('外部并发编辑')
          recordId = String(finished!.changes![0].id)
          await execution.observer.onOutcome({ status: 'succeeded', output: 'Created the file' })
        } catch (error) {
          actionError = error
          await execution.observer.onOutcome({ status: 'failed', error: { code: 'FIXTURE', message: String(error), retryable: false } })
        }
      })
      if (actionError) throw actionError
      expect(run.status).toBe('succeeded')
      expect(await store.getById(recordId, ctx.tenantId)).toMatchObject({ producerChildSessionId: childSessionId,
        producerRunId: childRunId, source: 'command-observation', requiresExplicitRevert: true })
      expect(await store.revertBatch(ctx.tenantId, { sessionId: ctx.sessionId })).toMatchObject({ reverted: 0, unavailable: 1 })
    } finally { await roots.finishOwned(owner, { status: 'cancelled' }) }
  })

  it('retains generated files when an explicit command deadline ends the process', async () => {
    const result = await execute("require('node:fs').writeFileSync('timeout.txt','partial output');setInterval(()=>{},1000)", { timeoutMs: 1000 })
    expect(result.success).toBe(false)
    expect(jobOf(result)).toMatchObject({ status: 'timed_out', changeTracking: { recordedCount: 1 } })
    expect(result.changes?.[0]).toMatchObject({ displayPath: 'timeout.txt', requiresExplicitRevert: true })
  }, 10_000)

  it('does not claim external edits while admission is cancelled before the process spawns', async () => {
    let ready!: () => void, release!: () => void
    const prepared = new Promise<void>(resolve => { ready = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    const starting = commandJobs.start({ ...commandJobScope(ctx), ownerSessionId: ctx.sessionId,
      command: process.execPath, args: ['-e', "require('node:fs').writeFileSync('unexpected.txt','ran')"],
      cwd: workspace, background: false, env: { ...process.env }, observeChanges: async job => {
        const observer = await createCommandChangeObserver(ctx, workspace, job)
        ready(); await gate; return observer
      } }).catch(error => error as Error)
    try {
      await prepared
      const cancelling = commandJobs.cancelScope(commandJobScope(ctx), 'stopped before spawn')
      fs.writeFileSync(path.join(workspace, 'external.txt'), 'manual edit during cancelled preparation')
      release()
      expect(await starting).toBeInstanceOf(Error)
      await cancelling
      expect(fs.existsSync(path.join(workspace, 'unexpected.txt'))).toBe(false)
      expect(await store.list(ctx.tenantId, ctx.sessionId)).toEqual([])
    } finally { release() }
  })

  it('retains changes from a failing command and publishes them once', async () => {
    const result = await execute("require('node:fs').writeFileSync('partial.txt','useful partial output');process.exitCode=2")
    expect(result.success).toBe(false)
    expect(result.changes).toHaveLength(1)
    expect(result.output).toContain('[COMMAND_EXIT_FAILED] status=failed; exitCode=2')
    const summary = JSON.parse(result.output.split('[文件变化观察] ')[1])
    expect(summary.changes[0]).toMatchObject({ id: result.changes![0].id, path: result.changes![0].path, oldHash: 'missing', newHash: result.changes![0].newHash })
    expect(jobOf(result)).toMatchObject({ exitCode: 2, changeTracking: { status: 'complete', limits: COMMAND_CHANGE_LIMITS } })
    const output = await commandOutputTool.execute({ jobId: jobOf(result).jobId }, ctx)
    expect(output.changes?.[0].id).toBe(result.changes?.[0].id)
    expect(await store.list(ctx.tenantId, ctx.sessionId)).toHaveLength(1)
  })

  it('finishes background observation before cancellation is acknowledged and exposes durable receipts', async () => {
    const result = await execute("require('node:fs').writeFileSync('background.txt','generated');process.stdout.write('ready');setInterval(()=>{},1000)", { background: true })
    expect(jobOf(result).changeTracking?.status).toBe('observing')
    await vi.waitFor(() => expect(fs.existsSync(path.join(workspace, 'background.txt'))).toBe(true), { timeout: 10_000 })
    const cancelled = await cancelCommandTool.execute({ jobId: jobOf(result).jobId }, ctx)
    expect(jobOf(cancelled).status).toBe('cancelled')
    expect(cancelled.changes).toHaveLength(1)
    const recovered = await commandJobs.get(commandJobScope(ctx), jobOf(result).jobId)
    expect(recovered?.changes?.[0].id).toBe(cancelled.changes?.[0].id)
    expect(recovered?.changeTracking?.recordedCount).toBe(1)
    expect(recovered!.version).toBeGreaterThan(jobOf(result).version)
  })

  it('does not claim another managed writer changed by a running command', async () => {
    const file = path.join(workspace, 'shared.txt'); fs.writeFileSync(file, 'old')
    const observer = await createCommandChangeObserver(ctx, workspace, fakeJob())
    fs.writeFileSync(file, 'other tool')
    await store.record(ctx.tenantId, { sessionId: 'other-session', path: file, kind: 'write', oldContent: 'old', newContent: 'other tool' })
    const observed = await observer.finish(); observer.dispose()
    expect(observed.changes).toEqual([])
    expect(observed.tracking).toMatchObject({ status: 'partial', concurrentChangesExcluded: 1 })
    expect(await store.list(ctx.tenantId, ctx.sessionId)).toEqual([])
  })

  it('never publishes a previous command observation into a replacement database', async () => {
    const observer = await createCommandChangeObserver(ctx, workspace, fakeJob())
    fs.writeFileSync(path.join(workspace, 'old-command.txt'), 'output')
    const replacement = createClient({ url: 'file::memory:' })
    vi.mocked(database.getDb).mockReturnValue(replacement)
    try {
      await expect(observer.finish()).rejects.toThrow('datasource changed')
      expect(await new ChangeStore(db).list(ctx.tenantId, ctx.sessionId)).toEqual([])
      expect(await new ChangeStore(replacement).list(ctx.tenantId, ctx.sessionId)).toEqual([])
    } finally { observer.dispose(); vi.mocked(database.getDb).mockReturnValue(db); replacement.close() }
  })

  it('reports incomplete coverage, never treats skipped old files as created, and records only eligible new files', async () => {
    fs.writeFileSync(path.join(workspace, 'large.txt'), 'before too large')
    fs.mkdirSync(path.join(workspace, 'node_modules')); fs.writeFileSync(path.join(workspace, 'node_modules', 'package.txt'), 'a')
    const observer = await createCommandChangeObserver(ctx, workspace, fakeJob(), { ...COMMAND_CHANGE_LIMITS, maxFileBytes: 4, maxBytes: 8 })
    fs.writeFileSync(path.join(workspace, 'large.txt'), 'tiny')
    fs.writeFileSync(path.join(workspace, 'small.txt'), 'ok')
    fs.writeFileSync(path.join(workspace, 'node_modules', 'package.txt'), 'b')
    const observed = await observer.finish(); observer.dispose()
    expect(observed.changes.map(change => change.displayPath)).toEqual(['small.txt'])
    expect(observed.tracking).toMatchObject({ status: 'partial', skippedReasons: { 'file-size-limit': 1 } })
    expect(observed.tracking.excludedDirectories).toContain('node_modules')
    expect(observed.changes[0].oldHash).toBe('missing')
  })

  it('does not traverse junctions or record changed files outside the command working directory', async () => {
    const outside = path.join(fixture, 'outside'); fs.mkdirSync(outside)
    fs.writeFileSync(path.join(outside, 'private.txt'), 'before')
    fs.symlinkSync(outside, path.join(workspace, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
    const observer = await createCommandChangeObserver(ctx, workspace, fakeJob())
    fs.writeFileSync(path.join(outside, 'private.txt'), 'after')
    const observed = await observer.finish(); observer.dispose()
    expect(observed.changes).toEqual([])
    expect(observed.tracking.skippedReasons?.['symbolic-link']).toBeGreaterThan(0)
  })

  it('keeps independent small command output unchanged when no files change', async () => {
    const result = await execute("process.stdout.write(JSON.stringify({ok:true}))")
    expect(JSON.parse(result.output)).toEqual({ ok: true })
    expect(result.changes).toEqual([])
    expect(hashFileContent(fs.readFileSync(path.join(workspace, 'task.cjs')))).toMatch(/^sha256:/)
  })
})
