import fs from 'node:fs'
import path from 'node:path'
import { acquireResourceRecoveryLease, readResourceLease, type LeaseOwner } from './binding-lease.js'
import { physicalRepositoryLock, recoveredRepositoryOwner, recoverRepositoryLease, repositoryLeaseStatus, type RepositoryLeaseOwner } from './repository-lease.js'

function samePath(left: string, right: string): boolean {
  if (!path.isAbsolute(left) || !path.isAbsolute(right)) return false
  const a = path.resolve(left), b = path.resolve(right)
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

function matches(owner: RepositoryLeaseOwner, held: Readonly<LeaseOwner>, file: string, root: string): boolean {
  const binding = owner.bindingLease
  return !!binding && typeof binding.file === 'string' && typeof binding.root === 'string'
    && samePath(binding.file, file) && samePath(binding.root, root)
    && binding.generation === held.generation && binding.pid === held.pid && owner.owner?.pid === held.pid
}

/** A missing process alone proves nothing about its Git descendants. Only an
 * exact repository receipt plus the existing native job audit can release a
 * stranded binding, including after that session's persisted mapping is gone. */
export async function recoverGitBindingLease(
  sessionFile: string,
  workspaceRoot: string,
  context: { tenantId: string; sessionId: string }
): Promise<boolean> {
  if (!fs.existsSync(sessionFile) && !fs.existsSync(sessionFile + '.recovery.lock')) return false
  let recovery: ReturnType<typeof acquireResourceRecoveryLease>
  try { recovery = acquireResourceRecoveryLease(sessionFile, context) }
  catch { return false }
  try {
    // Recovery may have stopped after archiving the session but before dropping
    // its metadata-only guard. Acquiring the guard above repairs that case too.
    const initial = readResourceLease(sessionFile)
    if (!initial || initial.resource !== 'workspace session' || initial.tenantId !== context.tenantId || initial.sessionId !== context.sessionId) return false
    const root = fs.realpathSync(workspaceRoot)
    const file = physicalRepositoryLock(root)
    // Recovery cannot use a parent checkout or linked metadata outside the
    // selected workspace to obtain authority over this session's lease.
    const relative = path.relative(root, fs.realpathSync(path.dirname(file)))
    if (path.isAbsolute(relative) || relative === '..' || relative.startsWith('..' + path.sep)) return false
    let verified: RepositoryLeaseOwner | undefined
    const active = repositoryLeaseStatus(file)
    if (active.busy && !active.recoverable) return false
    if (active.recoverable && active.owner && matches(active.owner, initial, sessionFile, root)) {
      recoverRepositoryLease(file, active.owner.generation)
      verified = recoveredRepositoryOwner(file, active.owner.generation)
    }
    if (!verified) {
      const prefix = path.basename(file) + '.recovered-'
      for (const name of fs.readdirSync(path.dirname(file))) {
        if (!name.startsWith(prefix) || !/^[0-9a-f-]{36}\.json$/i.test(name.slice(prefix.length))) continue
        try {
          const archive = path.join(path.dirname(file), name)
          const stat = fs.lstatSync(archive)
          if (stat.isSymbolicLink() || stat.size > 16 * 1024) continue
          const candidate = JSON.parse(fs.readFileSync(archive, 'utf8')) as RepositoryLeaseOwner
          if (!candidate || !matches(candidate, initial, sessionFile, root)) continue
          // Re-audit live process identities and native closure now; the stored
          // "verified" boolean from a previous recovery is not a certificate.
          const owner = recoveredRepositoryOwner(file, name.slice(prefix.length, -5))
          if (matches(owner, initial, sessionFile, root)) { verified = owner; break }
        } catch { /* Unrelated or incomplete archives confer no recovery authority. */ }
      }
    }
    if (!verified) return false
    const current = readResourceLease(sessionFile)
    if (!current || current.pid !== initial.pid || current.generation !== initial.generation
      || current.tenantId !== context.tenantId || current.sessionId !== context.sessionId) return false
    const archived = `${sessionFile}.recovered-${current.generation}.json`
    if (fs.existsSync(archived)) return false
    recovery.assertOwned()
    fs.renameSync(sessionFile, archived)
    return true
  } catch {
    // An absent or unverifiable certificate leaves the existing lease and its
    // normal busy error intact for explicit investigation.
    return false
  } finally { recovery.release() }
}
