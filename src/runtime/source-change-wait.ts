import fs from 'node:fs'
import path from 'node:path'
import { commandJobs } from '../core/command-jobs/index.js'
import { rootRunStore, type RootRun } from '../storage/root-runs/index.js'
import { verifySourceSnapshot, type SourceChangeWaitBlocker, type SourceSnapshot } from './source-change-protocol.js'

export const SOURCE_CHANGE_WAIT_DEFAULTS = Object.freeze({ pollMs: 2_000, stableWindowMs: 1_500 })

export interface SourceChangeWaitStatus {
  ready: boolean
  reason: 'external-writer' | 'source-changing' | 'stable-window' | 'ready'
  observedAt: number
  stableSince?: number
  stableWindowMs: number
  blockers: SourceChangeWaitBlocker[]
  sourceChanged: boolean
  currentSnapshot: SourceSnapshot
}

export interface SourceChangeWaitQuery {
  tenantId: string
  root: string
  currentSessionId?: string
  currentRunId?: string
  currentJobId?: string
  snapshot?: SourceSnapshot
  stableWindowMs?: number
  now?: number
}

interface Sample {
  fingerprint: string
  stableSince: number
  snapshot: SourceSnapshot
}

const samples = new Map<string, Sample>()
const MAX_SAMPLES = 256

function pathKey(value: string): string {
  let resolved = path.resolve(value)
  try { resolved = fs.realpathSync.native(resolved) } catch { /* missing paths remain safely comparable */ }
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function pathsOverlap(left: string, right: string): boolean {
  const a = pathKey(left), b = pathKey(right)
  const relative = path.relative(a, b)
  const reverse = path.relative(b, a)
  const inside = (value: string) => value === '' || (!value.startsWith(`..${path.sep}`) && value !== '..' && !path.isAbsolute(value))
  return inside(relative) || inside(reverse)
}

function fingerprint(snapshot: SourceSnapshot): string {
  return snapshot.kind === 'build'
    ? `build:${snapshot.buildId}`
    : `files:${snapshot.files.map(file => `${pathKey(file.path)}:${file.hash}:${file.byteLength}`).join('|')}`
}

function runBlocker(run: RootRun, root: string, currentSessionId?: string, currentRunId?: string): SourceChangeWaitBlocker | undefined {
  if (run.runId === currentRunId && run.sessionId === currentSessionId) return undefined
  if (!run.workspacePaths.some(workspace => pathsOverlap(root, workspace))) return undefined
  return { kind: 'run', id: run.runId, sessionId: run.sessionId, runId: run.runId, status: 'running' }
}

/**
 * Read-only source guard probe for a pending source-change action. It joins
 * durable active roots with live command jobs and keeps a bounded in-process
 * sample so the client can wait for a stable source window after all writers
 * have ended. A restart simply starts a new stable window from the durable
 * pending snapshot; it never treats restart as proof of safety.
 */
export async function getSourceChangeWaitStatus(input: SourceChangeWaitQuery): Promise<SourceChangeWaitStatus> {
  const observedAt = input.now ?? Date.now()
  const stableWindowMs = Math.max(250, Math.min(input.stableWindowMs ?? SOURCE_CHANGE_WAIT_DEFAULTS.stableWindowMs, 60_000))
  // Each durable pending action gets its own stability window. Use the sealed
  // source fingerprint rather than capturedAt: verification creates a fresh
  // timestamp on every sample, but that must not restart an unchanged window.
  const seed = input.snapshot ?? samples.get(JSON.stringify([input.tenantId, pathKey(input.root), input.currentSessionId ?? '', input.currentRunId ?? '']))?.snapshot
  const seedFingerprint = seed ? fingerprint(seed) : ''
  const key = JSON.stringify([input.tenantId, pathKey(input.root), input.currentSessionId ?? '', input.currentRunId ?? '', seedFingerprint])
  const prior = samples.get(key)
  // Once a wait has sampled the current source, use that sample as the next
  // verification baseline. The durable pending action intentionally keeps its
  // original `after` snapshot; comparing every poll to that sealed version
  // would report `source-changing` forever after a legitimate external edit.
  const base = prior?.snapshot ?? input.snapshot
  if (!base) throw new Error('SOURCE_CHANGE_WAIT_SNAPSHOT_REQUIRED')
  const check = verifySourceSnapshot(base)
  const current = check.after
  const currentFingerprint = fingerprint(current)
  const sourceChanged = currentFingerprint !== seedFingerprint
  const same = prior?.fingerprint === currentFingerprint
  const stableSince = same ? prior!.stableSince : observedAt

  const [jobs, runs] = await Promise.all([commandJobs.listActiveForTenant(input.tenantId), rootRunStore.activeForTenant(input.tenantId)])
  const blockers: SourceChangeWaitBlocker[] = []
  for (const job of jobs) {
    if (input.currentJobId && job.jobId === input.currentJobId) continue
    if (!pathsOverlap(input.root, job.cwd)) continue
    blockers.push({ kind: 'command', id: job.jobId, sessionId: job.sessionId, ownerSessionId: job.ownerSessionId,
      ...(job.runId ? { runId: job.runId } : {}), ...(job.ownerRunId ? { ownerRunId: job.ownerRunId } : {}),
      jobId: job.jobId, cwd: job.cwd, status: job.status as 'running' | 'cancelling' })
  }
  for (const run of runs) {
    const blocker = runBlocker(run, input.root, input.currentSessionId, input.currentRunId)
    if (blocker) blockers.push(blocker)
  }

  if (samples.size >= MAX_SAMPLES && !samples.has(key)) samples.delete(samples.keys().next().value!)
  samples.set(key, { fingerprint: currentFingerprint, stableSince, snapshot: structuredClone(current) })

  if (blockers.length) return { ready: false, reason: 'external-writer', observedAt, stableWindowMs, stableSince,
    blockers: blockers.slice(0, 32), sourceChanged, currentSnapshot: current }
  // A writer is allowed to leave a new source version behind. The guard must
  // stabilize that new version before rechecking. Only a change between two
  // consecutive samples is still in-flight; comparing every sample to the
  // sealed pending baseline would wait forever after a legitimate edit.
  if ((prior && !same) || (!prior && check.changed)) return { ready: false, reason: 'source-changing', observedAt, stableWindowMs, stableSince,
    blockers: [], sourceChanged, currentSnapshot: current }
  if (observedAt - stableSince < stableWindowMs) return { ready: false, reason: 'stable-window', observedAt, stableWindowMs, stableSince,
    blockers: [], sourceChanged, currentSnapshot: current }
  return { ready: true, reason: 'ready', observedAt, stableWindowMs, stableSince,
    blockers: [], sourceChanged, currentSnapshot: current }
}

/** Tests and shutdown hooks can discard a sample without touching durable state. */
export function clearSourceChangeWaitSamples(): void { samples.clear() }

