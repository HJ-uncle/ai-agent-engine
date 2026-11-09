import fs from 'node:fs/promises'
import path from 'node:path'
import type { AgentContext } from '../../core/agent-context/index.js'
import type { CommandChangeObserver, CommandChangeTracking, CommandJobSnapshot } from '../../core/command-jobs/types.js'
import { ChangeStore, type FileChange } from '../../storage/changes/index.js'
import { getDb, getDbEpoch } from '../../storage/sqlite/db.js'
import { canonicalFilePathSync, hashFileContent, withFileLocks } from '../../shared/file-version.js'
import { discardUnpublishedSnapshot, snapshotFromBytes, type ChangeSnapshot } from '../file/change-recorder.js'
import { serviceForOwner } from '../../core/collaboration/execution-owner.js'
import { captureCreatedDirectories } from '../../storage/changes/directories.js'

export const COMMAND_CHANGE_LIMITS = Object.freeze({ maxFiles: 512, maxBytes: 16 * 1024 * 1024,
  maxFileBytes: 8 * 1024 * 1024, maxEntries: 10_000, maxDepth: 16, maxScanMs: 1500, maxChanges: 128 })
export const COMMAND_CHANGE_EXCLUDED = ['.git', '.hg', '.svn', '.ae', '.aether', 'node_modules', '.venv', 'venv', '__pycache__', '.cache']
const excluded = new Set(COMMAND_CHANGE_EXCLUDED)
const key = (value: string) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value)
const inside = (root: string, file: string) => { const relative = path.relative(root, file); return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)) }
interface SnapshotTree {
  files: Map<string, { path: string; bytes?: Buffer; signature?: string }>
  directories: Set<string>
  known: Set<string>
  completeDirectories: Set<string>
}
const signature = (stat: Awaited<ReturnType<typeof fs.lstat>>) =>
  `${stat.dev}:${stat.ino}:${stat.mode}:${stat.nlink}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`

/** Bounded observation, not a filesystem sandbox or attribution of arbitrary
 * external writes. Explicit-selection rollback is enforced by ChangeStore. */
export async function createCommandChangeObserver(ctx: AgentContext, root: string, job: CommandJobSnapshot,
  limits = COMMAND_CHANGE_LIMITS): Promise<CommandChangeObserver> {
  const canonicalRoot = canonicalFilePathSync(root)
  const tenantId = ctx.tenantId, sessionId = ctx.rootSessionId ?? ctx.sessionId
  const sourceDb = getDb(), sourceEpoch = getDbEpoch(sourceDb)
  // Capture the real launching invocation while admission is live. Observation
  // may finish during cancellation, and must still retain its original source;
  // this identifies the observer, never the exclusive author of all changed bytes.
  let producer: Pick<FileChange, 'producerChildSessionId' | 'producerRunId'> = {}
  if (ctx.executionOwner) {
    const service = serviceForOwner(ctx.executionOwner)
    service.assertDispatch(ctx.executionOwner)
    if (service.db !== sourceDb) throw new Error('Command observation owner datasource mismatch')
    const binding = service.collaboration.executionBinding(service.producerForExecution(ctx.executionOwner))
    if (binding.kind === 'child') {
      if (binding.tenantId !== tenantId || binding.sessionId !== ctx.sessionId || binding.invocationRunId !== ctx.runId
        || binding.rootSessionId !== sessionId || binding.rootSessionId !== ctx.parentSessionId || binding.rootRunId !== ctx.rootRunId
        || binding.turnId !== (ctx.turnId ?? ctx.parentConversationId ?? ctx.conversationId)
        || job.sessionId !== binding.rootSessionId || job.ownerSessionId !== binding.sessionId || job.ownerRunId !== binding.invocationRunId
        || job.runId !== binding.rootRunId || job.turnId !== binding.turnId) throw new Error('Command observation child owner mismatch')
      producer = Object.freeze({ producerChildSessionId: binding.sessionId, producerRunId: binding.invocationRunId })
    }
  }
  const store = new ChangeStore(sourceDb)
  const ensureSource = () => {
    if (getDb() !== sourceDb || sourceDb.closed || getDbEpoch(sourceDb) !== sourceEpoch) throw new Error('Command observation datasource changed')
  }
  const sequence = await store.latestSequence()
  const directorySequence = await store.latestDirectorySequence()
  const skippedReasons: Record<string, number> = {}
  const skippedSamples: string[] = []
  let skippedCount = 0, concurrentChangesExcluded = 0
  const skip = (file: string, reason: string) => {
    skippedCount++; skippedReasons[reason] = (skippedReasons[reason] ?? 0) + 1
    if (skippedSamples.length < 24) skippedSamples.push(`${path.relative(canonicalRoot, file) || '.'}: ${reason}`)
  }
  const safe = (file: string) => inside(canonicalRoot, file) && key(canonicalFilePathSync(file)) === key(file)
  async function readBounded(file: string): Promise<{ bytes: Buffer; signature: string } | null> {
    try {
      const stat = await fs.lstat(file)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1 || stat.size > limits.maxFileBytes || !safe(file)) return null
      // Bound the allocation itself, even if an external writer grows the
      // file between lstat and read. readFile() alone has no such bound.
      const handle = await fs.open(file, 'r')
      const bytes = Buffer.allocUnsafe(stat.size + 1)
      let length = 0
      try {
        if (signature(await handle.stat()) !== signature(stat)) return null
        while (length < bytes.length) {
          const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length)
          if (!bytesRead) break
          length += bytesRead
        }
      } finally { await handle.close() }
      const after = await fs.lstat(file)
      if (!after.isFile() || after.isSymbolicLink() || after.nlink > 1 || length !== stat.size ||
        signature(stat) !== signature(after) || !safe(file)) return null
      return { bytes: bytes.subarray(0, length), signature: signature(after) }
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
  }
  async function scan(capture: boolean): Promise<SnapshotTree> {
    const tree: SnapshotTree = { files: new Map(), directories: new Set(), known: new Set([key(canonicalRoot)]), completeDirectories: new Set() }
    let entries = 0, totalBytes = 0
    const started = Date.now()
    const queue = [{ dir: canonicalRoot, depth: 0 }]
    while (queue.length) {
      const { dir, depth } = queue.shift()!
      if (depth > limits.maxDepth) { skip(dir, 'depth-limit'); continue }
      if (entries >= limits.maxEntries || Date.now() - started > limits.maxScanMs) { skip(dir, 'scan-limit'); continue }
      let handle: Awaited<ReturnType<typeof fs.opendir>> | undefined
      try {
        const stat = await fs.lstat(dir)
        if (!stat.isDirectory() || stat.isSymbolicLink() || !safe(dir)) { skip(dir, 'linked-or-changed-directory'); continue }
        tree.directories.add(dir)
        handle = await fs.opendir(dir)
        for (;;) {
          if (entries >= limits.maxEntries || Date.now() - started > limits.maxScanMs) { skip(dir, 'scan-limit'); break }
          const entry = await handle.read()
          if (!entry) { tree.completeDirectories.add(key(dir)); break }
          entries++
          const file = path.join(dir, entry.name), identity = key(file)
          tree.known.add(identity)
          if (entry.isSymbolicLink()) { skip(file, 'symbolic-link'); continue }
          if (entry.isDirectory()) {
            if (excluded.has(entry.name.toLowerCase())) continue
            queue.push({ dir: file, depth: depth + 1 }); continue
          }
          if (!entry.isFile()) { skip(file, 'not-regular-file'); continue }
          if (tree.files.size >= limits.maxFiles) { skip(file, 'file-count-limit'); continue }
          const stat = await fs.lstat(file)
          if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink > 1 || !safe(file)) { skip(file, 'linked-or-changed-file'); continue }
          if (stat.size > limits.maxFileBytes) { skip(file, 'file-size-limit'); continue }
          if (totalBytes + stat.size > limits.maxBytes) { skip(file, 'snapshot-byte-limit'); continue }
          totalBytes += stat.size
          tree.files.set(identity, { path: file, signature: signature(stat) })
        }
      } catch { skip(dir, 'unreadable-directory') }
      finally { await handle?.close().catch(() => undefined) }
    }
    if (capture) {
      // Enumerate once, then overlap a small bounded number of independent
      // file reads. Serial open/read/stat/close for every file adds seconds
      // to a simple version probe on Windows.
      const files = [...tree.files.entries()]
      let cursor = 0, capturedBytes = 0
      await Promise.all(Array.from({ length: Math.min(8, files.length) }, async () => {
        for (;;) {
          const item = files[cursor++]
          if (!item) return
          const [identity, candidate] = item
          if (Date.now() - started > limits.maxScanMs) {
            tree.files.delete(identity); skip(candidate.path, 'scan-limit'); continue
          }
          try {
            const snapshot = await readBounded(candidate.path)
            if (snapshot === null) {
              tree.files.delete(identity); skip(candidate.path, 'file-changed-during-snapshot'); continue
            }
            if (capturedBytes + snapshot.bytes.length > limits.maxBytes) {
              tree.files.delete(identity); skip(candidate.path, 'snapshot-byte-limit'); continue
            }
            capturedBytes += snapshot.bytes.length
            tree.files.set(identity, { path: candidate.path, ...snapshot })
          } catch { tree.files.delete(identity); skip(candidate.path, 'unreadable-file') }
        }
      }))
    }
    return tree
  }
  const before = await scan(true)
  const tracking = (status: CommandChangeTracking['status'], recordedCount = 0): CommandChangeTracking => ({
    status, root: canonicalRoot, limits, excludedDirectories: COMMAND_CHANGE_EXCLUDED,
    skippedCount, skippedSamples: [...skippedSamples], skippedReasons: { ...skippedReasons }, concurrentChangesExcluded, recordedCount,
    note: '仅观察命令工作目录内的有界文件变化；排除依赖/版本库/内部目录、符号链接与超限文件，不覆盖目录外或其他系统副作用。观察结果可能包含外部并发编辑，须审阅并明确选择后回退。',
  })
  let finished: Promise<{ changes: Record<string, unknown>[]; tracking: CommandChangeTracking }> | undefined
  const isNewWithinCoveredDirectory = (file: string): boolean => {
    if (before.known.has(key(file))) return false
    let directory = path.dirname(file)
    while (inside(canonicalRoot, directory)) {
      if (before.known.has(key(directory))) return before.completeDirectories.has(key(directory))
      const parent = path.dirname(directory)
      if (parent === directory) return false
      directory = parent
    }
    return false
  }
  async function finish() {
    ensureSource()
    const changes: Record<string, unknown>[] = []
    const started = Date.now()
    const after = await scan(false)
    const candidates = new Map([...before.files, ...after.files])
    let finalBytes = 0
    let recordedDirectoryCount = 0
    for (const [identity, candidate] of candidates) {
      if (Date.now() - started > limits.maxScanMs) { skip(candidate.path, 'final-scan-limit'); continue }
      const prior = before.files.get(identity)
      // scan(false) already revalidated these paths and their stat identity.
      // Reacquire the file lock and verify bytes only for observed changes.
      if (prior && after.files.get(identity)?.signature === prior.signature) continue
      if (!prior && !isNewWithinCoveredDirectory(candidate.path)) continue
      let oldSnapshot: ChangeSnapshot | undefined, newSnapshot: ChangeSnapshot | undefined, recorded = false
      try {
        await withFileLocks([candidate.path], async ([canonical]) => {
          if (!safe(canonical) || key(canonical) !== identity) { skip(candidate.path, 'path-changed'); return }
          let content: Buffer | null
          try {
            const stat = await fs.lstat(canonical)
            if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1 || stat.size > limits.maxFileBytes || finalBytes + stat.size > limits.maxBytes) {
              skip(canonical, 'final-file-limit-or-link'); return
            }
            // A normal read-only probe does not reread/hash every unchanged
            // baseline file. Rollback still verifies complete byte hashes.
            if (prior?.signature === signature(stat)) return
            const snapshot = await readBounded(canonical)
            if (snapshot === null) { skip(canonical, 'final-file-changed'); return }
            content = snapshot.bytes
            finalBytes += content.length
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
            content = null
          }
          const oldContent = prior?.bytes ?? null
          if (hashFileContent(oldContent) === hashFileContent(content)) return
          if (changes.length >= limits.maxChanges) { skip(canonical, 'change-receipt-limit'); return }
          if (await store.hasPathChangesAfter(canonical, sequence)) {
            concurrentChangesExcluded++; skip(candidate.path, 'concurrent-managed-change'); return
          }
          ensureSource()
          oldSnapshot = snapshotFromBytes(canonical, oldContent)
          newSnapshot = snapshotFromBytes(canonical, content)
          const change = await store.record(tenantId, { sessionId, ...producer,
            turnId: job.turnId, runId: job.runId, path: canonical, kind: content === null ? 'delete' : 'write',
            oldContent: oldSnapshot.oldContent, newContent: newSnapshot.oldContent, oldHash: oldSnapshot.oldHash, newHash: newSnapshot.oldHash,
            oldSnapshotRef: oldSnapshot.snapshotRef, newSnapshotRef: newSnapshot.snapshotRef, truncated: oldSnapshot.truncated || newSnapshot.truncated,
            source: 'command-observation', commandJobId: job.jobId, requiresExplicitRevert: true })
          recorded = true
          changes.push(receipt(change, canonicalRoot, job.toolCallId))
        })
      } catch { skip(candidate.path, 'recording-failed') }
      finally {
        if (!recorded) { if (oldSnapshot) discardUnpublishedSnapshot(oldSnapshot); if (newSnapshot) discardUnpublishedSnapshot(newSnapshot) }
      }
    }
    // A command may only mkdir, with file tools writing into it later. That
    // absence boundary must survive independently of those later file edits.
    for (const directory of after.directories) {
      if (key(directory) === key(canonicalRoot) || !isNewWithinCoveredDirectory(directory)) continue
      if (Date.now() - started > limits.maxScanMs || changes.length + recordedDirectoryCount >= limits.maxChanges) { skip(directory, 'directory-receipt-limit'); continue }
      const entries = captureCreatedDirectories(path.join(directory, '.directory-creation-probe'), [directory])
      if (!entries.length) continue
      try {
        ensureSource()
        if (await store.hasDirectoryChangesAfter(directory, directorySequence, sequence)) {
          concurrentChangesExcluded++; skip(directory, 'concurrent-managed-directory'); continue
        }
        const recordedDirectories = await store.recordCreatedDirectories(tenantId, {
          sessionId, turnId: job.turnId, runId: job.runId, source: 'command-observation', commandJobId: job.jobId, requiresExplicitRevert: true,
        }, entries)
        recordedDirectoryCount += recordedDirectories.length
      } catch { skip(directory, 'directory-recording-failed') }
    }
    return { changes, tracking: { ...tracking(skippedCount ? 'partial' : 'complete', changes.length), recordedDirectoryCount } }
  }
  return { initial: tracking('observing'), finish: () => finished ??= finish(), dispose: () => before.files.clear() }
}

function receipt(change: FileChange, root: string, toolCallId?: string): Record<string, unknown> {
  return { id: change.id, seq: change.seq, sessionId: change.sessionId, path: change.path, displayPath: path.relative(root, change.path),
    kind: change.kind, oldHash: change.oldHash, newHash: change.newHash, status: change.status, truncated: change.truncated,
    createdAt: change.createdAt, turnId: change.turnId, runId: change.runId, toolCallId,
    ...(change.producerChildSessionId && change.producerRunId ? { producerChildSessionId: change.producerChildSessionId, producerRunId: change.producerRunId } : {}),
    source: change.source, commandJobId: change.commandJobId, requiresExplicitRevert: true, isNew: change.oldHash === 'missing' }
}
