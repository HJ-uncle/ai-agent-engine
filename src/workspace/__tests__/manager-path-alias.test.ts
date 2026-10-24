/** Authorization follows the same real directory across Windows 8.3/long
 * spellings without granting sibling roots or junction targets outside it.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceManager } from '../manager.js'
import { canonicalFilePathSync } from '../../shared/file-version.js'
import { clearSecurityMode, setSecurityMode } from '../../security/policy-engine.js'

let rawRoot: string, root: string, project: string, manager: WorkspaceManager
const identity = { tenantId: 'alias-tenant', sessionId: 'alias-session' }
beforeEach(() => {
  rawRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aether-path-alias-'))
  root = fs.realpathSync.native(rawRoot)
  project = path.join(root, 'project')
  fs.mkdirSync(project)
  vi.stubEnv('AUTH_ENABLED', 'false')
  vi.stubEnv('DATA_DIR', path.join(root, 'state', 'agent.db'))
  vi.stubEnv('AETHER_WORKSPACE_BINDINGS_FILE', path.join(root, 'state', 'bindings.json'))
  manager = new WorkspaceManager(path.join(root, 'private'))
  setSecurityMode(identity.tenantId, identity.sessionId, 'safe')
})
afterEach(() => {
  clearSecurityMode(identity.tenantId, identity.sessionId)
  vi.restoreAllMocks(); vi.unstubAllEnvs()
  if (path.dirname(root) !== fs.realpathSync.native(os.tmpdir()) || !path.basename(root).startsWith('aether-path-alias-')) throw new Error('Unsafe alias fixture cleanup')
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
})
function context(selected = project) {
  return { ...identity, cwd: selected, projectRoot: selected, workspacePaths: [selected] }
}
function makeLink(target: string, link: string): string | undefined {
  try { fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir') }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EPERM' || code === 'EACCES' || code === 'ENOSYS' || code === 'ENOTSUP') return 'Filesystem link capability unavailable: ' + code
    throw error
  }
  return undefined
}

describe('WorkspaceManager canonical authorization', () => {
  it.skipIf(process.platform !== 'win32')('accepts a locked long path inside the same actual 8.3 workspace, including uncreated suffixes', t => {
    if (!/~\d/.test(rawRoot) || rawRoot.toLowerCase() === root.toLowerCase()) { console.info('The host TEMP path has no distinct live 8.3 alias'); t.skip() }
    const shortProject = path.join(rawRoot, 'project'), ctx = context(shortProject)
    fs.writeFileSync(path.join(project, 'existing.txt'), 'same file')
    for (const relative of ['existing.txt', 'new/nested/周报.docx']) {
      const first = manager.resolveSafePath(ctx, relative)
      const locked = canonicalFilePathSync(first)
      expect(locked).toBe(path.join(project, relative))
      expect(manager.resolveSafePath(ctx, locked)).toBe(locked)
    }
  })
  it.skipIf(process.platform !== 'win32')('accepts short target spelling with a long workspace root and preserves the requested spelling', t => {
    if (!/~\d/.test(rawRoot) || rawRoot.toLowerCase() === root.toLowerCase()) { console.info('The host TEMP path has no distinct live 8.3 alias'); t.skip() }
    const target = path.join(rawRoot, 'project', 'nested', 'new.csv')
    expect(manager.resolveSafePath(context(), target)).toBe(target)
  })
  it.skipIf(process.platform !== 'win32')('binds and reopens an operator-authorized project across aliases while retaining tenant ownership', t => {
    if (!/~\d/.test(rawRoot) || rawRoot.toLowerCase() === root.toLowerCase()) { console.info('The host TEMP path has no distinct live 8.3 alias'); t.skip() }
    vi.stubEnv('AUTH_ENABLED', 'true')
    vi.stubEnv('AETHER_ALLOWED_WORKSPACE_ROOTS', path.join(rawRoot, 'project'))
    const bound = new WorkspaceManager(path.join(root, 'private'))
    expect(canonicalFilePathSync(bound.bind(identity, project))).toBe(project)
    const reopened = new WorkspaceManager(path.join(root, 'private'))
    expect(canonicalFilePathSync(reopened.getBoundDirectory(identity)!)).toBe(project)
    expect(reopened.resolveSafePath(identity, path.join(rawRoot, 'project', 'new.txt'))).toBe(path.join(rawRoot, 'project', 'new.txt'))
    expect(() => reopened.bind({ tenantId: 'other-tenant', sessionId: 'other-session' }, path.join(rawRoot, 'project'))).toThrow(/another tenant/)
  })
  it('preserves every nonexistent suffix instead of authorizing its nearest existing ancestor', () => {
    const missing = path.join(root, 'not-created', 'only-this-project'), ctx = context(missing)
    expect(manager.resolveSafePath(ctx, 'new/deep/file.txt')).toBe(path.join(missing, 'new/deep/file.txt'))
    expect(() => manager.resolveSafePath(ctx, path.join(root, 'not-created', 'other-project', 'file.txt'))).toThrow(/outside/)
    expect(() => manager.resolveSafePath(ctx, path.join(root, 'unrelated.txt'))).toThrow(/outside/)
  })
  it('rejects traversal, a real outside directory and an adjacent directory with the same name prefix', () => {
    const outside = path.join(root, 'outside'), prefix = path.join(root, 'project-copy')
    fs.mkdirSync(outside); fs.mkdirSync(prefix)
    for (const target of ['../outside/canary.txt', path.join(outside, 'new.txt'), path.join(prefix, 'new.txt'), path.join(rawRoot, 'project-copy', 'missing', 'file.txt')]) {
      expect(() => manager.resolveSafePath(context(), target)).toThrow(/outside/)
    }
  })
  it('rejects a symlink/junction escape for existing files and nonexistent descendants', t => {
    const outside = path.join(root, 'outside'), link = path.join(project, 'escape')
    fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'canary.txt'), 'untouched')
    const unsupported = makeLink(outside, link); if (unsupported) { console.info(unsupported); t.skip() }
    for (const target of ['escape/canary.txt', 'escape/new/deep/file.txt', path.join(rawRoot, 'project', 'escape', 'new.txt')]) {
      expect(() => manager.resolveSafePath(context(), target)).toThrow(/outside/)
    }
    expect(fs.readFileSync(path.join(outside, 'canary.txt'), 'utf8')).toBe('untouched')
    expect(fs.existsSync(path.join(outside, 'new'))).toBe(false)
  })
  it('rejects dangling symlinks/junctions instead of treating them as ordinary missing directories', t => {
    const link = path.join(project, 'dangling'), missingTarget = path.join(root, 'outside-missing')
    const unsupported = makeLink(missingTarget, link); if (unsupported) { console.info(unsupported); t.skip() }
    expect(() => manager.resolveSafePath(context(), 'dangling/new.txt')).toThrow(/dangling|outside/)
    expect(fs.existsSync(missingTarget)).toBe(false)
  })
  it('rejects an external link pointing inward, whose directory entry is not owned by the workspace', t => {
    const external = path.join(root, 'external-link')
    const unsupported = makeLink(project, external); if (unsupported) { console.info(unsupported); t.skip() }
    fs.writeFileSync(path.join(project, 'kept.txt'), 'retained')
    for (const target of [external, path.join(external, 'kept.txt'), path.join(external, 'new', 'file.txt')]) {
      expect(() => manager.resolveSafePath(context(), target)).toThrow(/outside/)
    }
    expect(fs.lstatSync(external).isSymbolicLink()).toBe(true)
    expect(fs.readFileSync(path.join(project, 'kept.txt'), 'utf8')).toBe('retained')
    vi.stubEnv('AUTH_ENABLED', 'true')
    vi.stubEnv('AETHER_ALLOWED_WORKSPACE_ROOTS', project)
    const bound = new WorkspaceManager(path.join(root, 'private'))
    expect(() => bound.bind(identity, external)).toThrow(/outside/)
    expect(() => bound.resolveProjectDirectory(identity.tenantId, external)).toThrow(/outside/)
  })
  it('rejects attempts to borrow uncreated private tenant/session ancestors in authenticated mode', () => {
    vi.stubEnv('AUTH_ENABLED', 'true')
    const own = path.join(root, 'private', identity.tenantId, identity.sessionId)
    expect(manager.resolveSafePath(identity, path.join(own, 'new.txt'))).toBe(path.join(own, 'new.txt'))
    for (const target of [path.join(root, 'private', 'other-tenant', 'session', 'file.txt'), path.join(root, 'private', identity.tenantId, 'other-session', 'file.txt'), path.join(project, 'file.txt')]) {
      expect(() => manager.resolveSafePath(context(), target)).toThrow(/outside/)
    }
  })
  it('keeps the authenticated private-session symlink guard', t => {
    vi.stubEnv('AUTH_ENABLED', 'true')
    const outside = path.join(root, 'outside'), tenant = path.join(root, 'private', identity.tenantId)
    fs.mkdirSync(outside); fs.mkdirSync(tenant, { recursive: true })
    const unsupported = makeLink(outside, path.join(tenant, identity.sessionId)); if (unsupported) { console.info(unsupported); t.skip() }
    expect(() => manager.resolveSafePath(identity, 'new.txt')).toThrow(/symbolic link/)
  })
})
