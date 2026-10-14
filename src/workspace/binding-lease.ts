import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

export interface LeaseOwner { pid: number; generation: string; acquiredAt: string; resource: string; tenantId?: string; sessionId?: string }
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

/** Exclusive files work across manager instances and processes. A crashed owner
 * is reported, never guessed dead or silently displaced while its child may live. */
export function acquireResourceLease(file: string, resource: string, context?: { tenantId: string; sessionId: string }): ResourceLease {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const owner: LeaseOwner = Object.freeze({ pid: process.pid, generation: randomUUID(), acquiredAt: new Date().toISOString(), resource, ...context })
  let descriptor: number
  try { descriptor = fs.openSync(file, 'wx', 0o600) }
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
