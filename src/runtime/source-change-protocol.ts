import path from 'node:path'
import { createBuildManifest, type BuildManifest } from './build-identity.js'
import { canonicalFilePathSync, readFileVersionSync } from '../shared/file-version.js'

/** A source operation is allowed to continue only against the version it
 * admitted.  This protocol is intentionally independent of security policy:
 * full-access mode can approve a tool, but cannot make a stale source current. */
export const SOURCE_CHANGE_PROTOCOL_VERSION = 1 as const
export const SOURCE_CHANGE_CHOICES = ['pause', 'recheck', 'rebuild', 'skip'] as const
/** Writes cannot safely replay stale operation arguments over a newly edited
 * source. They require a fresh recheck; only explicit skip may proceed. */
export const SOURCE_WRITE_CHANGE_CHOICES = ['pause', 'recheck', 'skip'] as const
export type SourceChangeChoice = typeof SOURCE_CHANGE_CHOICES[number]
export type SourceChangePhase = 'build' | 'write'

export interface SourceFileVersion {
  path: string
  hash: string
  byteLength: number
}

export interface SourceFileSnapshot {
  protocolVersion: 1
  kind: 'files'
  root: string
  files: SourceFileVersion[]
  capturedAt: number
}

export interface BuildSourceSnapshot {
  protocolVersion: 1
  kind: 'build'
  root: string
  buildId: string
  capturedAt: number
}

export type SourceSnapshot = SourceFileSnapshot | BuildSourceSnapshot

export interface SourceFileChange {
  path: string
  before: SourceFileVersion
  after: SourceFileVersion
  kind: 'created' | 'modified' | 'deleted'
}

export interface SourceChangeCheck {
  changed: boolean
  before: SourceSnapshot
  after: SourceSnapshot
  changes: SourceFileChange[]
}

/** Pending action payload is durable and safe to expose: it contains hashes
 * and paths only, never source bytes.  The operation and snapshot are frozen
 * so resume cannot silently re-read a different request. */
export interface SourceChangePendingAction {
  [key: string]: unknown
  type: 'source_change'
  protocolVersion: 1
  phase: SourceChangePhase
  operation: string
  root: string
  before: SourceSnapshot
  after: SourceSnapshot
  changes: SourceFileChange[]
  choices: readonly SourceChangeChoice[]
  defaultChoice: 'pause'
  reason: string
  risk: 'external-source-change'
  /**
   * When an active command from another execution owner is touching the same
   * workspace, the client may keep the pending card visible while it waits.
   * This is advisory state only: resuming still performs a fresh source
   * verification and can create another pending action if the writer is not
   * actually finished.
   */
  wait?: SourceChangeWait
}

export interface SourceChangeCommandBlocker {
  kind: 'command'
  id: string
  sessionId: string
  ownerSessionId?: string
  runId?: string
  ownerRunId?: string
  jobId: string
  cwd: string
  status: 'running' | 'cancelling'
}

export interface SourceChangeRunBlocker {
  kind: 'run'
  id: string
  sessionId: string
  runId: string
  status: 'running'
}

export type SourceChangeWaitBlocker = SourceChangeCommandBlocker | SourceChangeRunBlocker

export interface SourceChangeWait {
  mode: 'external-writer'
  reason?: 'external-writer' | 'source-changing' | 'stable-window'
  startedAt: number
  pollMs: number
  stableWindowMs: number
  blockers: SourceChangeWaitBlocker[]
}

const missing = (file: string): SourceFileVersion => ({ path: canonicalFilePathSync(file), hash: 'missing', byteLength: 0 })

function fileVersion(file: string): SourceFileVersion {
  const canonical = canonicalFilePathSync(file)
  const version = readFileVersionSync(canonical)
  return { path: canonical, hash: version.hash, byteLength: version.content?.byteLength ?? 0 }
}

/** Capture exact versions for a bounded set of files used by a write. */
export function captureSourceFiles(files: readonly string[], root = process.cwd()): SourceFileSnapshot {
  if (!Array.isArray(files) || files.length === 0) throw new Error('Source snapshot requires at least one file')
  if (files.length > 512) throw new Error('Source snapshot file limit exceeded')
  const canonicalRoot = canonicalFilePathSync(root)
  const versions = files.map(fileVersion)
  for (const version of versions) {
    const relative = path.relative(canonicalRoot, version.path)
    if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('Source snapshot path is outside its root')
  }
  return { protocolVersion: 1, kind: 'files', root: canonicalRoot, files: versions, capturedAt: Date.now() }
}

/** Build identity is the content fingerprint of all engine source/build inputs. */
export function captureBuildSource(root: string): BuildSourceSnapshot {
  const canonicalRoot = canonicalFilePathSync(root)
  const manifest = createBuildManifest(canonicalRoot)
  return { protocolVersion: 1, kind: 'build', root: canonicalRoot, buildId: manifest.buildId, capturedAt: Date.now() }
}

export function verifySourceSnapshot(snapshot: SourceSnapshot): SourceChangeCheck {
  if (snapshot.protocolVersion !== 1) throw new Error('Unsupported source snapshot protocol')
  if (snapshot.kind === 'build') {
    const manifest: BuildManifest = createBuildManifest(snapshot.root)
    const after: BuildSourceSnapshot = { protocolVersion: 1, kind: 'build', root: snapshot.root,
      buildId: manifest.buildId, capturedAt: Date.now() }
    return { changed: after.buildId !== snapshot.buildId, before: snapshot, after, changes: [] }
  }
  const afterFiles = snapshot.files.map(before => {
    try { return fileVersion(before.path) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return missing(before.path)
      throw error
    }
  })
  const changes: SourceFileChange[] = []
  for (let index = 0; index < snapshot.files.length; index++) {
    const before = snapshot.files[index], after = afterFiles[index]
    if (before.hash === after.hash) continue
    const kind = before.hash === 'missing' ? 'created' : after.hash === 'missing' ? 'deleted' : 'modified'
    changes.push({ path: before.path, before, after, kind })
  }
  const after: SourceFileSnapshot = { ...snapshot, files: afterFiles, capturedAt: Date.now() }
  return { changed: changes.length > 0, before: snapshot, after, changes }
}

export function sourceChangePendingAction(check: SourceChangeCheck, input: {
  phase: SourceChangePhase
  operation: string
  wait?: SourceChangeWait
}): SourceChangePendingAction {
  if (!check.changed) throw new Error('Cannot create source-change pending action for an unchanged snapshot')
  return {
    type: 'source_change', protocolVersion: 1, phase: input.phase, operation: input.operation,
    root: check.before.root, before: structuredClone(check.before), after: structuredClone(check.after),
    changes: structuredClone(check.changes), choices: input.phase === 'write' ? SOURCE_WRITE_CHANGE_CHOICES : SOURCE_CHANGE_CHOICES, defaultChoice: 'pause',
    reason: input.phase === 'build' ? '构建期间检测到源码版本变化，候选产物未被信任。' : '写入期间检测到源码版本变化，未静默覆盖外部编辑。',
    risk: 'external-source-change',
    ...(input.wait ? { wait: structuredClone(input.wait) } : {}),
  }
}

export function resolveSourceChangeChoice(action: unknown, value: unknown): SourceChangeChoice | undefined {
  if (!action || typeof action !== 'object') return undefined
  const candidate = String(value ?? '') as SourceChangeChoice
  const choices = (action as Partial<SourceChangePendingAction>).choices
  const phase = (action as Partial<SourceChangePendingAction>).phase
  const allowed = phase === 'write' ? SOURCE_WRITE_CHANGE_CHOICES : SOURCE_CHANGE_CHOICES
  const canonical = Array.isArray(choices) && choices.length > 0 && choices.length <= allowed.length && new Set(choices).size === choices.length &&
    choices.every(choice => allowed.includes(choice as never))
  return canonical && allowed.includes(candidate as never) ? candidate : undefined
}

/** The final check is mandatory for every choice, including skip. */
export function assertSourceSnapshotUnchanged(snapshot: SourceSnapshot): SourceChangeCheck {
  const check = verifySourceSnapshot(snapshot)
  if (check.changed) throw Object.assign(new Error('Source changed during operation; final verification required'), {
    code: 'SOURCE_CHANGED_DURING_OPERATION', check,
  })
  return check
}
