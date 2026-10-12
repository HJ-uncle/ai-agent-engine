/** Read-only catalogue authorization uses the same operator/tenant boundaries as binding. */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceManager } from '../manager.js'

let root: string
let marker: string
let privateRoot: string
let projects: string
let outside: string
let bindingsFile: string

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'aether-project-catalogue-'))
  marker = randomUUID()
  fs.writeFileSync(path.join(root, '.fixture-owner'), marker)
  privateRoot = path.join(root, 'private')
  projects = path.join(root, 'projects')
  outside = path.join(root, 'outside')
  for (const directory of [privateRoot, projects, outside]) fs.mkdirSync(directory)
  bindingsFile = path.join(root, 'workspace-bindings.json')
  vi.stubEnv('AUTH_ENABLED', 'true')
  vi.stubEnv('AETHER_ALLOWED_WORKSPACE_ROOTS', projects)
  vi.stubEnv('AETHER_WORKSPACE_BINDINGS_FILE', bindingsFile)
})

afterEach(() => {
  vi.unstubAllEnvs()
  const canonical = fs.realpathSync(root)
  expect(path.dirname(canonical).toLowerCase()).toBe(fs.realpathSync(os.tmpdir()).toLowerCase())
  expect(path.basename(canonical)).toMatch(/^aether-project-catalogue-/)
  expect(fs.readFileSync(path.join(canonical, '.fixture-owner'), 'utf8')).toBe(marker)
  fs.rmSync(canonical, { recursive: true, force: true })
})

describe('read-only project directory authorization', () => {
  it('returns the canonical allowed root without creating a session binding', () => {
    const manager = new WorkspaceManager(privateRoot)
    expect(manager.resolveProjectDirectory('tenant', projects)).toBe(fs.realpathSync(projects))
    expect(fs.existsSync(bindingsFile)).toBe(false)
  })

  it('preserves all existing session selections and binding bytes during discovery', () => {
    const first = path.join(projects, 'first'), second = path.join(projects, 'second')
    fs.mkdirSync(first); fs.mkdirSync(second)
    const manager = new WorkspaceManager(privateRoot)
    manager.bind({ tenantId: 'tenant', sessionId: 'session' }, first)
    const before = fs.readFileSync(bindingsFile, 'utf8')
    expect(manager.resolveProjectDirectory('tenant', second)).toBe(fs.realpathSync(second))
    expect(fs.readFileSync(bindingsFile, 'utf8')).toBe(before)
    expect(manager.getWorkingDirectory({ tenantId: 'tenant', sessionId: 'session' })).toBe(fs.realpathSync(first))
  })

  it('rejects an authenticated operator-disallowed directory', () => {
    const manager = new WorkspaceManager(privateRoot)
    expect(() => manager.resolveProjectDirectory('tenant', outside)).toThrow('outside the engine allowed workspace roots')
    expect(fs.existsSync(bindingsFile)).toBe(false)
  })

  it('rejects another tenant private scratch and the private root itself', () => {
    const owner = path.join(privateRoot, 'owner', 'session')
    fs.mkdirSync(owner, { recursive: true })
    const manager = new WorkspaceManager(privateRoot)
    expect(() => manager.resolveProjectDirectory('tenant', owner)).toThrow('another tenant')
    expect(() => manager.resolveProjectDirectory('tenant', privateRoot)).toThrow('private workspace root')
  })

  it('rejects directories overlapping another tenant persisted binding', () => {
    const owned = path.join(projects, 'owned'), child = path.join(owned, 'child')
    fs.mkdirSync(child, { recursive: true })
    const manager = new WorkspaceManager(privateRoot)
    manager.bind({ tenantId: 'owner', sessionId: 'session' }, owned)
    expect(() => manager.resolveProjectDirectory('tenant', child)).toThrow('another tenant')
    expect(() => manager.resolveProjectDirectory('tenant', projects)).toThrow('another tenant')
  })

  it('rejects a junction inside an allowed root that resolves outside it', context => {
    const junction = path.join(projects, 'escape')
    try { fs.symlinkSync(outside, junction, 'junction') }
    catch (error) { if (['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) { return context.skip() } throw error }
    expect(() => new WorkspaceManager(privateRoot).resolveProjectDirectory('tenant', junction)).toThrow('resolves outside')
  })

  it('keeps single-user explicit local projects available without writing bindings', () => {
    vi.stubEnv('AUTH_ENABLED', 'false')
    expect(new WorkspaceManager(privateRoot).resolveProjectDirectory('tenant', outside)).toBe(fs.realpathSync(outside))
    expect(fs.existsSync(bindingsFile)).toBe(false)
  })

  it.each(['relative/project', 'bad\0path', ''])('rejects malformed project path %s', input => {
    expect(() => new WorkspaceManager(privateRoot).resolveProjectDirectory('tenant', input)).toThrow(/valid server path|absolute server path/)
  })
})
