import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { WorkspaceManager } from '../manager.js'
import { clearSecurityMode, setSecurityMode } from '../../security/policy-engine.js'

const made: string[] = []
afterEach(() => {
  clearSecurityMode('tenant', 'session')
  for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aether-workspace-boundary-'))
  made.push(root)
  const privateRoot = path.join(root, 'private')
  const allowed = path.join(root, 'projects')
  const outside = path.join(root, 'outside')
  fs.mkdirSync(allowed, { recursive: true })
  fs.mkdirSync(outside, { recursive: true })
  return { root, privateRoot, allowed, outside }
}

describe('WorkspaceManager boundary validation', () => {
  it.each(['../escape', 'a/b', 'a\\b', 'C:drive', 'CON', ''])('rejects unsafe session identifier %s', id => {
    const f = fixture()
    const manager = new WorkspaceManager(f.privateRoot)
    expect(() => manager.getPath({ tenantId: 'tenant', sessionId: id })).toThrow(/valid identifier/)
  })

  it('rejects a junction that resolves outside the selected project in safe mode', () => {
    const f = fixture()
    const oldAuth = process.env.AUTH_ENABLED
    process.env.AUTH_ENABLED = 'false'
    const project = path.join(f.allowed, 'project')
    fs.mkdirSync(project)
    const link = path.join(project, 'linked')
    try { fs.symlinkSync(f.outside, link, 'junction') } catch { if (oldAuth === undefined) delete process.env.AUTH_ENABLED; else process.env.AUTH_ENABLED = oldAuth; return }
    fs.writeFileSync(path.join(f.outside, 'canary.txt'), 'outside')
    const manager = new WorkspaceManager(f.privateRoot)
    const ctx = { tenantId: 'tenant', sessionId: 'session', projectRoot: project, cwd: project, workspacePaths: [project] }
    setSecurityMode(ctx.tenantId, ctx.sessionId, 'safe')
    try { expect(() => manager.resolveSafePath(ctx, 'linked/canary.txt')).toThrow(/outside/) }
    finally { if (oldAuth === undefined) delete process.env.AUTH_ENABLED; else process.env.AUTH_ENABLED = oldAuth }
  })

  it('prevents a second authenticated tenant from binding an overlapping project', () => {
    const f = fixture()
    fs.mkdirSync(f.privateRoot, { recursive: true })
    const old = process.env.AUTH_ENABLED
    const oldAllowed = process.env.AETHER_ALLOWED_WORKSPACE_ROOTS
    process.env.AUTH_ENABLED = 'true'
    process.env.AETHER_ALLOWED_WORKSPACE_ROOTS = f.allowed
    try {
      const manager = new WorkspaceManager(f.privateRoot)
      manager.bind({ tenantId: 'a', sessionId: 's' }, f.allowed)
      fs.mkdirSync(path.join(f.allowed, 'child'))
      expect(() => manager.bind({ tenantId: 'b', sessionId: 's' }, path.join(f.allowed, 'child'))).toThrow(/another tenant/)
    } finally {
      if (old === undefined) delete process.env.AUTH_ENABLED; else process.env.AUTH_ENABLED = old
      if (oldAllowed === undefined) delete process.env.AETHER_ALLOWED_WORKSPACE_ROOTS; else process.env.AETHER_ALLOWED_WORKSPACE_ROOTS = oldAllowed
    }
  })

  it('restores a bound project after a manager instance is recreated', () => {
    const f = fixture()
    const project = path.join(f.allowed, 'persistent-project')
    fs.mkdirSync(project)
    const oldAuth = process.env.AUTH_ENABLED
    const oldAllowed = process.env.AETHER_ALLOWED_WORKSPACE_ROOTS
    process.env.AUTH_ENABLED = 'false'
    process.env.AETHER_ALLOWED_WORKSPACE_ROOTS = f.allowed
    try {
      const first = new WorkspaceManager(f.privateRoot)
      expect(first.bind({ tenantId: 'tenant', sessionId: 'session' }, project)).toBe(fs.realpathSync(project))
      const second = new WorkspaceManager(f.privateRoot)
      expect(second.getWorkingDirectory({ tenantId: 'tenant', sessionId: 'session' })).toBe(fs.realpathSync(project))
    } finally {
      if (oldAuth === undefined) delete process.env.AUTH_ENABLED; else process.env.AUTH_ENABLED = oldAuth
      if (oldAllowed === undefined) delete process.env.AETHER_ALLOWED_WORKSPACE_ROOTS; else process.env.AETHER_ALLOWED_WORKSPACE_ROOTS = oldAllowed
    }
  })

  it('does not restore overlapping no-auth bindings after authentication is enabled', () => {
    const f = fixture()
    const project = path.join(f.allowed, 'shared')
    fs.mkdirSync(path.join(project, 'child'), { recursive: true })
    const oldAuth = process.env.AUTH_ENABLED
    const oldAllowed = process.env.AETHER_ALLOWED_WORKSPACE_ROOTS
    process.env.AETHER_ALLOWED_WORKSPACE_ROOTS = f.allowed
    try {
      process.env.AUTH_ENABLED = 'false'
      new WorkspaceManager(f.privateRoot).bind({ tenantId: 'a', sessionId: 's' }, project)
      new WorkspaceManager(f.privateRoot).bind({ tenantId: 'b', sessionId: 's' }, path.join(project, 'child'))
      process.env.AUTH_ENABLED = 'true'
      expect(() => new WorkspaceManager(f.privateRoot).getWorkingDirectory({ tenantId: 'a', sessionId: 's' })).toThrow(/overlaps/)
      expect(() => new WorkspaceManager(f.privateRoot).getWorkingDirectory({ tenantId: 'b', sessionId: 's' })).toThrow(/overlaps/)
    } finally {
      if (oldAuth === undefined) delete process.env.AUTH_ENABLED; else process.env.AUTH_ENABLED = oldAuth
      if (oldAllowed === undefined) delete process.env.AETHER_ALLOWED_WORKSPACE_ROOTS; else process.env.AETHER_ALLOWED_WORKSPACE_ROOTS = oldAllowed
    }
  })

  it('rejects binding the authenticated private root itself', () => {
    const f = fixture()
    fs.mkdirSync(f.privateRoot, { recursive: true })
    const oldAuth = process.env.AUTH_ENABLED
    const oldAllowed = process.env.AETHER_ALLOWED_WORKSPACE_ROOTS
    process.env.AUTH_ENABLED = 'true'
    process.env.AETHER_ALLOWED_WORKSPACE_ROOTS = f.privateRoot
    try { expect(() => new WorkspaceManager(f.privateRoot).bind({ tenantId: 'tenant', sessionId: 'session' }, f.privateRoot)).toThrow(/private workspace root/) }
    finally {
      if (oldAuth === undefined) delete process.env.AUTH_ENABLED; else process.env.AUTH_ENABLED = oldAuth
      if (oldAllowed === undefined) delete process.env.AETHER_ALLOWED_WORKSPACE_ROOTS; else process.env.AETHER_ALLOWED_WORKSPACE_ROOTS = oldAllowed
    }
  })
})
