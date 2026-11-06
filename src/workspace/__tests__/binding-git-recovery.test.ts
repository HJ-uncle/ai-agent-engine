/** Exact on-disk binding ownership and native closure gate stale Git recovery. */
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { recoverGitBindingLease } from '../binding-git-recovery.js'
import { acquireResourceRecoveryLease, type LeaseOwner } from '../binding-lease.js'
import { physicalRepositoryLock, recoverRepositoryLease, type RepositoryLeaseOwner } from '../repository-lease.js'
import * as repositoryProcess from '../repository-process.js'
import { WorkspaceManager } from '../manager.js'

const context = { tenantId: 'tenant-recovery', sessionId: 'previous-session' }
const closedJob: repositoryProcess.NativeAudit = {
  ownerAlive: false, supervisorAlive: false, jobExists: false,
  activeProcesses: 0, empty: true, verified: true
}
let fixture: string
let root: string
let sessionFile: string
let repositoryFile: string
let held: LeaseOwner

beforeEach(() => {
  fixture = path.resolve('.e2e-tmp', `binding-git-recovery-${randomUUID()}`)
  fs.mkdirSync(path.join(fixture, 'project'), { recursive: true })
  root = fs.realpathSync(path.join(fixture, 'project'))
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^GIT_/i.test(name)))
  execFileSync('git', ['-C', root, 'init', '--quiet'], { env, windowsHide: true })
  repositoryFile = physicalRepositoryLock(root)
  sessionFile = path.join(fixture, 'workspace-bindings.json.session-previous.lock')
  held = {
    pid: 987654, generation: randomUUID(), acquiredAt: new Date().toISOString(),
    resource: 'workspace session', ...context
  }
  fs.writeFileSync(sessionFile, JSON.stringify(held) + '\n')
  // Keep the disk parsers and archive recovery real; the native OS job query is
  // the only boundary replaced, so every refusal still exercises its evidence.
  vi.spyOn(repositoryProcess, 'auditRepositoryJob').mockReturnValue(closedJob)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  const scratch = path.resolve('.e2e-tmp')
  const resolved = path.resolve(fixture)
  if (!resolved.startsWith(scratch + path.sep) || !path.basename(resolved).startsWith('binding-git-recovery-')) {
    throw new Error('Unsafe fixture cleanup')
  }
  fs.rmSync(resolved, { recursive: true, force: true })
})

function repositoryOwner(): RepositoryLeaseOwner {
  const generation = randomUUID()
  return {
    schema: 3, protocol: 'windows-job-v1', generation,
    acquiredAt: new Date().toISOString(), resource: repositoryFile,
    owner: { pid: held.pid, birth: '133700000000000000', alive: false },
    supervisor: { pid: 987655, birth: '133700000000000001', alive: false },
    jobName: `Local\\AetherGit-${generation}`, phase: 'supervising', access: 'read',
    bindingLease: { file: sessionFile, generation: held.generation, pid: held.pid, root, epoch: randomUUID() }
  }
}

function seedRepository(owner = repositoryOwner(), closure = true): RepositoryLeaseOwner {
  fs.writeFileSync(repositoryFile, JSON.stringify(owner) + '\n')
  if (closure && owner.supervisor) {
    fs.writeFileSync(`${repositoryFile}.native-close-${owner.generation}.json`, JSON.stringify({
      protocol: owner.protocol, jobName: owner.jobName,
      ownerPid: owner.owner.pid, ownerBirth: owner.owner.birth,
      supervisorPid: owner.supervisor.pid, supervisorBirth: owner.supervisor.birth,
      activeProcesses: 0
    }) + '\n')
  }
  return owner
}

function bindingArchive(): string { return `${sessionFile}.recovered-${held.generation}.json` }
function repositoryArchive(owner: RepositoryLeaseOwner): string { return `${repositoryFile}.recovered-${owner.generation}.json` }

async function expectRetained(): Promise<void> {
  const bindingBefore = fs.readFileSync(sessionFile)
  const repositoryBefore = fs.existsSync(repositoryFile) ? fs.readFileSync(repositoryFile) : undefined
  expect(await recoverGitBindingLease(sessionFile, root, context)).toBe(false)
  expect(fs.readFileSync(sessionFile)).toEqual(bindingBefore)
  expect(fs.existsSync(bindingArchive())).toBe(false)
  if (repositoryBefore) expect(fs.readFileSync(repositoryFile)).toEqual(repositoryBefore)
  expect(fs.existsSync(sessionFile + '.recovery.lock')).toBe(false)
}

it('retains an active owner even when a matching closure receipt is present', async () => {
  seedRepository()
  vi.mocked(repositoryProcess.auditRepositoryJob).mockReturnValue({
    ownerAlive: true, supervisorAlive: true, jobExists: true,
    activeProcesses: 2, empty: false, verified: false
  })
  await expectRetained()
})

it('does not use an older matching archive while a newer repository operation is active', async () => {
  const previous = seedRepository()
  recoverRepositoryLease(repositoryFile, previous.generation)
  const active = seedRepository()
  vi.mocked(repositoryProcess.auditRepositoryJob).mockImplementation(jobName => jobName === active.jobName ? {
    ownerAlive: true, supervisorAlive: true, jobExists: true,
    activeProcesses: 2, empty: false, verified: false
  } : closedJob)
  await expectRetained()
  expect(fs.existsSync(repositoryArchive(previous))).toBe(true)
})

const mismatches: Array<{ name: string; change: (owner: RepositoryLeaseOwner) => void }> = [
  { name: 'binding generation', change: owner => { owner.bindingLease!.generation = randomUUID() } },
  { name: 'binding pid', change: owner => { owner.bindingLease!.pid += 1 } },
  { name: 'repository owner pid', change: owner => { owner.owner.pid += 1 } },
  { name: 'session file', change: owner => { owner.bindingLease!.file = path.join(fixture, 'another-session.lock') } },
  { name: 'workspace root', change: owner => { owner.bindingLease!.root = fixture } }
]

it.each(mismatches)('retains ownership when the $name does not match', async ({ change }) => {
  const owner = repositoryOwner()
  change(owner)
  seedRepository(owner)
  await expectRetained()
})

it.each(['tenantId', 'sessionId'] as const)('retains a binding from a different %s', async field => {
  seedRepository()
  const before = fs.readFileSync(sessionFile)
  expect(await recoverGitBindingLease(sessionFile, root, { ...context, [field]: 'different-context' })).toBe(false)
  expect(fs.readFileSync(sessionFile)).toEqual(before)
  expect(fs.existsSync(repositoryFile)).toBe(true)
  expect(repositoryProcess.auditRepositoryJob).not.toHaveBeenCalled()
})

it('recovers the exact old session without requiring a current persisted binding', async () => {
  const bindingsFile = path.join(fixture, 'workspace-bindings.json')
  const bindings = JSON.stringify({ version: 1, bindings: [] }) + '\n'
  fs.writeFileSync(bindingsFile, bindings)
  const owner = seedRepository()
  expect(await recoverGitBindingLease(sessionFile, root, context)).toBe(true)
  expect(fs.existsSync(sessionFile)).toBe(false)
  expect(JSON.parse(fs.readFileSync(bindingArchive(), 'utf8'))).toEqual(held)
  expect(fs.existsSync(repositoryFile)).toBe(false)
  expect(JSON.parse(fs.readFileSync(repositoryArchive(owner), 'utf8'))).toEqual(owner)
  expect(fs.existsSync(repositoryArchive(owner) + '.audit.json')).toBe(true)
  expect(fs.readFileSync(bindingsFile, 'utf8')).toBe(bindings)
  expect(fs.existsSync(sessionFile + '.recovery.lock')).toBe(false)
})

it('recovers a leftover binding after its exact repository owner was already recovered', async () => {
  const owner = seedRepository()
  recoverRepositoryLease(repositoryFile, owner.generation)
  const archivedBefore = fs.readFileSync(repositoryArchive(owner))
  vi.mocked(repositoryProcess.auditRepositoryJob).mockClear()
  expect(await recoverGitBindingLease(sessionFile, root, context)).toBe(true)
  expect(fs.existsSync(sessionFile)).toBe(false)
  expect(JSON.parse(fs.readFileSync(bindingArchive(), 'utf8'))).toEqual(held)
  expect(fs.readFileSync(repositoryArchive(owner))).toEqual(archivedBefore)
  expect(repositoryProcess.auditRepositoryJob).toHaveBeenCalledWith(owner.jobName, owner.owner, owner.supervisor)
})

it('retains a dead-owner binding when no repository ownership proof exists', async () => {
  await expectRetained()
  expect(repositoryProcess.auditRepositoryJob).not.toHaveBeenCalled()
})

it('retains a dead-owner binding when native closure proof is missing', async () => {
  seedRepository(repositoryOwner(), false)
  await expectRetained()
})

it('does not trust a recovered archive after native closure proof disappears', async () => {
  const owner = seedRepository()
  recoverRepositoryLease(repositoryFile, owner.generation)
  fs.unlinkSync(`${repositoryFile}.native-close-${owner.generation}.json`)
  await expectRetained()
  expect(fs.existsSync(repositoryArchive(owner))).toBe(true)
})

it('rechecks native job liveness for a previously recovered repository owner', async () => {
  const owner = seedRepository()
  recoverRepositoryLease(repositoryFile, owner.generation)
  vi.mocked(repositoryProcess.auditRepositoryJob).mockReturnValue({
    ...closedJob, jobExists: true, activeProcesses: 1, empty: false, verified: false
  })
  await expectRetained()
})

function managerFixture(): WorkspaceManager {
  const bindingsFile = path.join(fixture, 'workspace-bindings.json')
  vi.stubEnv('AUTH_ENABLED', 'false')
  vi.stubEnv('AETHER_DESKTOP_OWNED', '1')
  vi.stubEnv('AETHER_WORKSPACE_BINDINGS_FILE', bindingsFile)
  const canonicalLease = `${bindingsFile}.session-${createHash('sha256').update(context.tenantId + '\0' + context.sessionId).digest('hex')}.lock`
  fs.renameSync(sessionFile, canonicalLease)
  sessionFile = canonicalLease
  return new WorkspaceManager(fixture)
}

it('normal asynchronous bind recovers the archived proof for a previous session missing from current mappings', async () => {
  const manager = managerFixture()
  const owner = seedRepository()
  recoverRepositoryLease(repositoryFile, owner.generation)
  await expect(manager.bindSnapshotAsync(context, root, 0)).resolves.toMatchObject({ root })
  expect(manager.getBoundDirectory(context)).toBe(root)
  expect(fs.existsSync(sessionFile)).toBe(false)
  expect(JSON.parse(fs.readFileSync(bindingArchive(), 'utf8'))).toEqual(held)
})

it('normal Git binding acquisition recovers an exact stranded lease for an existing mapping', async () => {
  const manager = managerFixture()
  fs.unlinkSync(sessionFile)
  const snapshot = manager.bindSnapshot(context, root)
  fs.writeFileSync(sessionFile, JSON.stringify(held) + '\n')
  seedRepository()
  const result = await manager.withBindingLease(context, snapshot, async lease => {
    lease.assertCurrent()
    return lease.snapshot
  })
  expect(result).toEqual(snapshot)
  expect(fs.existsSync(sessionFile)).toBe(false)
  expect(JSON.parse(fs.readFileSync(bindingArchive(), 'utf8'))).toEqual(held)
})

it('keeps an active metadata recovery guard and its original session untouched', async () => {
  seedRepository()
  const guard = acquireResourceRecoveryLease(sessionFile, context)
  vi.mocked(repositoryProcess.auditRepositoryJob).mockReturnValue({
    ...closedJob, ownerAlive: true, verified: false
  })
  try {
    const before = fs.readFileSync(sessionFile)
    expect(await recoverGitBindingLease(sessionFile, root, context)).toBe(false)
    expect(fs.readFileSync(sessionFile)).toEqual(before)
    expect(fs.existsSync(sessionFile + '.recovery.lock')).toBe(true)
  } finally { guard.release() }
})

it('recovers an interrupted metadata guard before recovering its still-stranded session', async () => {
  seedRepository()
  acquireResourceRecoveryLease(sessionFile, context)
  // The mocked native boundary certifies that the recorded pid/birth ended;
  // the guard and binding parsers, archive paths and Git evidence remain real.
  expect(await recoverGitBindingLease(sessionFile, root, context)).toBe(true)
  expect(fs.existsSync(sessionFile)).toBe(false)
  expect(fs.existsSync(sessionFile + '.recovery.lock')).toBe(false)
  expect(JSON.parse(fs.readFileSync(bindingArchive(), 'utf8'))).toEqual(held)
})

it('normal bind repairs an interrupted guard even when the session was already archived', async () => {
  const manager = managerFixture()
  fs.renameSync(sessionFile, bindingArchive())
  acquireResourceRecoveryLease(sessionFile, context)
  await expect(manager.bindSnapshotAsync(context, root, 0)).resolves.toMatchObject({ root })
  expect(manager.getBoundDirectory(context)).toBe(root)
  expect(fs.existsSync(sessionFile)).toBe(false)
  expect(fs.existsSync(sessionFile + '.recovery.lock')).toBe(false)
  expect(JSON.parse(fs.readFileSync(bindingArchive(), 'utf8'))).toEqual(held)
})
