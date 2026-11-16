import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPluginProject } from '../project.js'
import { closeAllDevPlugins, closeDevPlugin, devCapabilityAccess, getDevPlugin, invokeDevPlugin, openDevPlugin, refreshDevPlugin, resolveDevPluginAccess, setDevPluginPermissionGrants } from '../dev-session.js'
import { closeDb } from '../../storage/sqlite/db.js'

let root: string
const fixtures = path.resolve('.e2e-tmp/plugin-dev-unit')
beforeEach(() => {
  fs.mkdirSync(fixtures, { recursive: true }); root = fs.mkdtempSync(path.join(fixtures, 'case-'))
  vi.stubEnv('AETHER_DEV_PLUGIN_ROOTS', root); vi.stubEnv('DATA_DIR', path.join(root, 'state', 'agent.db')); vi.stubEnv('DEFAULT_SECURITY_MODE', 'standard')
})
afterEach(async () => {
  await closeAllDevPlugins()
  // Closing a development session also checks durable parked Agent roots. The
  // fixture owns that SQLite process and must join it before removing its files.
  const closed = await closeDb()
  if (closed) expect(closed.healthy, closed.errors.join('\n')).toBe(true)
  vi.unstubAllEnvs()
  if (path.dirname(root) !== fixtures || !path.basename(root).startsWith('case-')) throw new Error('Unsafe dev fixture cleanup')
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 30 })
  if (!fs.readdirSync(fixtures).length) fs.rmdirSync(fixtures)
})
function project() { const directory = path.join(root, 'project'); createPluginProject(directory, 'json-tool', 'dev-json'); return directory }
function change(directory: string) { const file = path.join(directory, 'main.mjs'); fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('const text = args.text.trim()', 'const text = args.text.trim().toUpperCase()')) }
describe('local development plugin sessions', () => {
  it('does not impose a development-session count or small settings ceiling', async () => {
    const directory = project(), file = path.join(directory, 'aether-plugin.json'), manifest = JSON.parse(fs.readFileSync(file, 'utf8'))
    manifest.permissions = { requested: ['settings.read', 'settings.write'] }; fs.writeFileSync(file, JSON.stringify(manifest))
    const opened = Array.from({ length: 17 }, () => openDevPlugin('alice', directory).session)
    const current = opened.at(-1)!
    setDevPluginPermissionGrants('alice', current.devSessionId, ['settings.read', 'settings.write'], current)
    const access = devCapabilityAccess('alice', current.devSessionId, current), value = { text: 'x'.repeat(128 * 1024) }
    await expect(access.setSettings(value)).resolves.toEqual(value)
    await expect(access.getSettings()).resolves.toEqual(value)
    expect(new Set(opened.map(session => session.devSessionId)).size).toBe(17)
  })
  it('requires refresh before executing changed disk source and returns a ready application', async () => {
    const directory = project(), opened = openDevPlugin('alice', directory), current = opened.session
    expect(opened.application).toMatchObject({ id: 'dev-json', revision: 1, execution: { allowed: true } }); expect(opened.examples.length).toBeGreaterThan(0)
    const first = await invokeDevPlugin('alice', current.devSessionId, 'normalize_text', { text: '  hello  ' }, current)
    expect(first.result).toEqual({ text: 'hello', characters: 5 }); change(directory)
    await expect(invokeDevPlugin('alice', current.devSessionId, 'normalize_text', { text: 'hello' }, current)).rejects.toMatchObject({ statusCode: 409 })
    const next = refreshDevPlugin('alice', current.devSessionId).session; expect(next.revision).toBe(2)
    await expect(invokeDevPlugin('alice', current.devSessionId, 'normalize_text', { text: 'hello' }, current)).rejects.toMatchObject({ statusCode: 409 })
    expect((await invokeDevPlugin('alice', next.devSessionId, 'normalize_text', { text: 'hello' }, next)).result).toEqual({ text: 'HELLO', characters: 5 })
    expect(fs.existsSync(path.join(root, 'state', 'plugin-runtime'))).toBe(false)
  })
  it('does not expose or close another tenant session', async () => {
    const session = openDevPlugin('alice', project()).session
    expect(() => getDevPlugin('bob', session.devSessionId)).toThrow('不存在')
    expect(() => refreshDevPlugin('bob', session.devSessionId)).toThrow('不存在')
    await expect(closeDevPlugin('bob', session.devSessionId)).rejects.toMatchObject({ statusCode: 404 })
    expect(getDevPlugin('alice', session.devSessionId).revision).toBe(1)
  })
  it('denies safe execution and outside or linked directories', async () => {
    const directory = project(); vi.stubEnv('DEFAULT_SECURITY_MODE', 'safe')
    const opened = openDevPlugin('alice', directory)
    expect(opened.application.execution.allowed).toBe(false)
    await expect(invokeDevPlugin('alice', opened.session.devSessionId, 'normalize_text', { text: 'hello' }, opened.session)).rejects.toMatchObject({ statusCode: 403 })
    expect(() => openDevPlugin('alice', path.dirname(root))).toThrow('允许的本地开发根目录')
    const linked = path.join(root, 'linked'); fs.symlinkSync(directory, linked, 'junction')
    expect(() => openDevPlugin('alice', linked)).toThrow('符号链接'); fs.unlinkSync(linked)
  })
  it('allows the local administrator selected project when no operator roots are configured', () => {
    const directory = project()
    vi.stubEnv('AETHER_DEV_PLUGIN_ROOTS', undefined); vi.stubEnv('AETHER_ALLOWED_WORKSPACE_ROOTS', undefined)
    expect(openDevPlugin('alice', directory).session.path).toBe(directory)
  })
  it('keeps only previously granted declarations on refresh and resets trust for a new plugin identity', () => {
    const directory = project(), file = path.join(directory, 'aether-plugin.json'), manifest = JSON.parse(fs.readFileSync(file, 'utf8'))
    manifest.permissions = { requested: ['skills.read'] }; fs.writeFileSync(file, JSON.stringify(manifest))
    const current = openDevPlugin('alice', directory).session
    expect(current.permissionGrants).toEqual([])
    expect(() => setDevPluginPermissionGrants('alice', current.devSessionId, ['workspace.write'], current)).toThrow('已声明')
    expect(setDevPluginPermissionGrants('alice', current.devSessionId, ['skills.read'], current).permissionGrants).toEqual(['skills.read'])
    change(directory)
    expect(() => resolveDevPluginAccess('alice', current.devSessionId, current)).toThrow('源码已变化')
    expect(refreshDevPlugin('alice', current.devSessionId).session.permissionGrants).toEqual(['skills.read'])
    manifest.permissions.requested.push('workspace.read'); fs.writeFileSync(file, JSON.stringify(manifest))
    expect(refreshDevPlugin('alice', current.devSessionId).session.permissionGrants).toEqual(['skills.read'])
    manifest.permissions.requested = []; fs.writeFileSync(file, JSON.stringify(manifest))
    expect(refreshDevPlugin('alice', current.devSessionId).session.permissionGrants).toEqual([])
    manifest.permissions.requested = ['skills.read']; fs.writeFileSync(file, JSON.stringify(manifest))
    const restored = refreshDevPlugin('alice', current.devSessionId).session
    setDevPluginPermissionGrants('alice', current.devSessionId, ['skills.read'], restored)
    manifest.id = 'replacement'; fs.writeFileSync(file, JSON.stringify(manifest))
    expect(refreshDevPlugin('alice', current.devSessionId).session.permissionGrants).toEqual([])
  })
  it('uses the host SDK in a real Node source preview without modifying the authoring tree', async () => {
    const directory = project(), file = path.join(directory, 'aether-plugin.json'), manifest = JSON.parse(fs.readFileSync(file, 'utf8'))
    manifest.permissions = { requested: ['settings.read'] }; fs.writeFileSync(file, JSON.stringify(manifest))
    fs.writeFileSync(path.join(directory, 'main.mjs'), `for await(const c of process.stdin){};console.log(JSON.stringify({result:{settings:await $AE.settings.get(),context:await $AE.context()}}))`)
    const current = openDevPlugin('alice', directory).session
    await expect(invokeDevPlugin('alice', current.devSessionId, 'normalize_text', { text: 'x' }, current)).rejects.toThrow('尚未获准')
    setDevPluginPermissionGrants('alice', current.devSessionId, ['settings.read'], current)
    const result = await invokeDevPlugin('alice', current.devSessionId, 'normalize_text', { text: 'x' }, current, undefined, 'bound-session')
    expect(result.result).toMatchObject({ settings: {}, context: { sessionId: 'bound-session', pluginId: 'dev-json' } })
    expect(fs.readdirSync(directory)).not.toContain('plugin-runtime')
    expect(fs.existsSync(path.join(root, 'state', 'plugin-runtime'))).toBe(false)
  })
  it('debounces watcher refresh and releases it on close', async () => {
    const directory = project(), current = openDevPlugin('alice', directory, true).session
    change(directory)
    await vi.waitFor(() => expect(getDevPlugin('alice', current.devSessionId).revision).toBe(2), { timeout: 3000 })
    await closeDevPlugin('alice', current.devSessionId)
    expect(() => getDevPlugin('alice', current.devSessionId)).toThrow('不存在')
  })
})
