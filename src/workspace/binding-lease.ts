import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { auditRepositoryJob, repositoryOwnerIdentity } from './repository-process.js'

export interface LeaseOwner { pid: number; generation: string; acquiredAt: string; resource: string; tenantId?: string; sessionId?: string; recoveryKind?: 'workspace-binding-metadata'; birth?: string }
export interface ResourceLease { owner: Readonly<LeaseOwner>; assertOwned(): void; release(): void }

function current(file: string): LeaseOwner | undefined {
  try {
    const stat = fs.lstatSync(file)
    if (stat.isSymbolicLink()) throw new Error('Resource lease must not be a symbolic link')
    if (stat.size > 16 * 1024) throw new Error('Resource lease metadata is too large')
    const value: unknown = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!value || typeof value !== 'object') throw new Error('Resource lease metadata is invalid')
    const candidate = value as Partial<LeaseOwner>
    if (!Number.isSafeInteger(candidate.pid) || candidate.pid! <= 0 || typeof candidate.generation !== 'string' ||
      !/^[0-9a-f-]{36}$/i.test(candidate.generation) || typeof candidate.acquiredAt !== 'string' || typeof candidate.resource !== 'string') throw new Error('Resource lease metadata is invalid')
    return candidate as LeaseOwner
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
}

export function readResourceLease(file: string): Readonly<LeaseOwner> | undefined {
  return current(file)
}

/** This guard owns only synchronous metadata recovery, never Git descendants.
 * Its exact process identity ending is therefore sufficient to retire it. */
export function acquireResourceRecoveryLease(file: string, context: { tenantId: string; sessionId: string }): ResourceLease {
  const guard = file + '.recovery.lock'
  const held = current(guard)
  if (held) {
    if (held.recoveryKind !== 'workspace-binding-metadata' || held.tenantId !== context.tenantId || held.sessionId !== context.sessionId
      || typeof held.birth !== 'string' || !/^\d{15,20}$/.test(held.birth))
      throw new Error('Workspace recovery guard identity is unverifiable')
    const proof = auditRepositoryJob(`Local\\AetherGit-${held.generation}`, { pid: held.pid, birth: held.birth, alive: true })
    if (!proof.verified) throw new Error('Workspace recovery is still running')
    const latest = current(guard)
    if (!latest || latest.generation !== held.generation || latest.pid !== held.pid || latest.birth !== held.birth)
      throw new Error('Workspace recovery guard ownership changed')
    const archive = `${guard}.recovered-${held.generation}.json`
    if (fs.existsSync(archive)) throw new Error('Workspace recovery guard archive already exists')
    fs.renameSync(guard, archive)
  }
  const identity = repositoryOwnerIdentity()
  return acquireResourceLease(guard, 'workspace session recovery', context, { recoveryKind: 'workspace-binding-metadata', birth: identity.birth })
}

/** Exclusive files work across manager instances and processes. A crashed owner
 * is reported, never guessed dead or silently displaced while its child may live. */
export function acquireResourceLease(file: string, resource: string, context?: { tenantId: string; sessionId: string }, recovery?: Pick<LeaseOwner, 'recoveryKind' | 'birth'>): ResourceLease {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const owner: LeaseOwner = Object.freeze({ pid: process.pid, generation: randomUUID(), acquiredAt: new Date().toISOString(), resource, ...context, ...recovery })
  let descriptor: number
  try {
    if (fs.existsSync(file + '.recovery.lock')) throw Object.assign(new Error('Resource recovery is in progress'), { code: 'EEXIST' })
    descriptor = fs.openSync(file, 'wx', 0o600)
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    let held: LeaseOwner | undefined, ownerMetadataError: string | undefined
    try { held = current(file) }
    catch (metadataError) { ownerMetadataError = metadataError instanceof Error ? metadataError.message : String(metadataError) }
    const problem = new Error(`Resource is busy: ${resource}; owner pid=${held?.pid ?? 'unknown'} generation=${held?.generation ?? 'unreadable'}. Retry after the operation closes; orphan leases require verified recovery.`)
    Object.assign(problem, { code: 'WORKSPACE_LEASE_BUSY', leaseFile: file, owner: held, ownerMetadataError })
    throw problem
  }
  try { fs.writeFileSync(descriptor, JSON.stringify(owner) + '\n', 'utf8'); fs.fsyncSync(descriptor) }
  catch (error) { fs.closeSync(descriptor); fs.unlinkSync(file); throw error }
  fs.closeSync(descriptor)
  // Recovery may start after the pre-open check. Do not admit side effects
  // from that window, and never remove a replacing generation while yielding.
  if (fs.existsSync(file + '.recovery.lock')) {
    if (current(file)?.generation === owner.generation) fs.unlinkSync(file)
    throw Object.assign(new Error(`Resource is busy: ${resource}; recovery is in progress`), { code: 'WORKSPACE_LEASE_BUSY', leaseFile: file })
  }
  let released = false
  const assertOwned = () => {
    if (released || current(file)?.generation !== owner.generation) throw new Error('Resource lease ownership changed')
  }
  return { owner, assertOwned, release() { if (released) return; assertOwned(); fs.unlinkSync(file); released = true } }
}

/** Read requests may queue behind a short lease. A fixed deadline preserves
 * failure visibility; stale owner files are never removed by this wait. */
export async function acquireResourceLeaseAsync(file: string, resource: string, context: { tenantId: string; sessionId: string } | undefined, waitMs = 0): Promise<ResourceLease> {
  const deadline = Date.now() + Math.max(0, Math.min(waitMs, 30_000))
  for (;;) {
    try { return acquireResourceLease(file, resource, context) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'WORKSPACE_LEASE_BUSY' || Date.now() >= deadline) throw error
      await new Promise(resolve => setTimeout(resolve, Math.min(20, Math.max(1, deadline - Date.now()))))
    }
  }
}
