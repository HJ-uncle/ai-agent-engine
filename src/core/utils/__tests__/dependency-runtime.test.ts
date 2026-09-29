/** Covers execution cwd/scratch isolation, queue cancellation, MCP abort and actual command termination. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AgentContext } from '../../agent-context/index.js'
import { WorkspaceManager } from '../../../workspace/manager.js'
import { createPool } from '../concurrency-pool.js'
import { HTTPMCPClient } from '../../../tools/mcp/client.js'
import { cmdTool } from '../../../tools/cmd/cmd-tool.js'
import { getProjectContextBlock } from '../../project-context.js'

const state = vi.hoisted(() => ({ mode: 'safe', userDir: '' }))
vi.mock('../../../security/policy-engine.js', () => ({
  getSecurityMode: () => state.mode,
  policyEngine: { evaluate: async () => ({ action: 'allow', reason: 'test' }) },
}))
vi.mock('../../aether-config.js', () => ({ getUserAetherDir: () => state.userDir }))
let tempRoot: string
let project: string
let scratch: string
let ctx: AgentContext
beforeEach(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aether-deps-'))
  project = path.join(tempRoot, 'project')
  scratch = path.join(tempRoot, 'private', 't', 's')
  fs.mkdirSync(project, { recursive: true })
  state.userDir = path.join(tempRoot, 'user')
  state.mode = 'safe'
  ctx = { tenantId: 't', sessionId: 's', workspaceDir: scratch, scratchDir: scratch, projectRoot: project, cwd: project, workspacePaths: [project] } as AgentContext
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  const resolved = path.resolve(tempRoot)
  if (!resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) || !path.basename(resolved).startsWith('aether-deps-')) throw new Error('Unexpected test cleanup target')
  fs.rmSync(resolved, { recursive: true, force: true })
})

describe('execution directory contracts', () => {
  it('uses the primary project for existing/new relative files while scratch remains the deletion path', () => {
    const manager = new WorkspaceManager(path.join(tempRoot, 'private'))
    manager.init(ctx)
    fs.writeFileSync(path.join(project, 'same.txt'), 'project')
    fs.writeFileSync(path.join(scratch, 'same.txt'), 'scratch')
    expect(manager.getPaths(ctx)[0]).toBe(project)
    expect(manager.resolveSafePath(ctx, 'same.txt')).toBe(path.join(project, 'same.txt'))
    expect(manager.resolveSafePath(ctx, 'new.txt')).toBe(path.join(project, 'new.txt'))
    expect(manager.getPath(ctx)).toBe(scratch)
    const deletionPath = path.resolve(manager.getPath(ctx))
    expect(deletionPath.startsWith(path.join(tempRoot, 'private') + path.sep)).toBe(true)
    fs.rmSync(deletionPath, { recursive: true, force: true })
    expect(fs.readFileSync(path.join(project, 'same.txt'), 'utf8')).toBe('project')
  })

  it('rejects normalized absolute traversal and reads AE.md from the bound project', () => {
    const manager = new WorkspaceManager(path.join(tempRoot, 'private'))
    expect(() => manager.resolveSafePath(ctx, project + path.sep + '..' + path.sep + 'outside.txt')).toThrow('outside')
    fs.writeFileSync(path.join(project, 'AE.md'), 'specific-project-marker')
    const block = getProjectContextBlock(project)
    expect(block).toContain('specific-project-marker')
    expect(block).not.toContain('Aether Engine')
  })
})

describe('cancellation propagation', () => {
  it('removes queued work without invoking it and reuses the released slot', async () => {
    const pool = createPool(1)
    let release!: () => void
    const first = pool(() => new Promise<void>(resolve => { release = resolve }))
    await Promise.resolve()
    const controller = new AbortController()
    const cancelledWork = vi.fn(async () => 'unexpected')
    const waiting = pool(cancelledWork, controller.signal)
    const rejected = expect(waiting).rejects.toMatchObject({ name: 'AbortError' })
    controller.abort()
    await rejected
    expect(pool.pending).toBe(0)
    release()
    await first
    expect(await pool(async () => 'next')).toBe('next')
    expect(cancelledWork).not.toHaveBeenCalled()
  })

  it('aborts the MCP HTTP request and does not convert provider isError into success', async () => {
    const controller = new AbortController()
    let started!: () => void
    const ready = new Promise<void>(resolve => { started = resolve })
    const fetchMock = vi.fn((_url: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      started()
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
    }))
    vi.stubGlobal('fetch', fetchMock)
    const client = new HTTPMCPClient({ name: 'test', url: 'http://mcp.invalid' })
    const request = client.callTool('lookup', {}, controller.signal)
    const rejected = expect(request).rejects.toMatchObject({ name: 'AbortError' })
    await ready
    controller.abort()
    await rejected
    expect(fetchMock).toHaveBeenCalledTimes(1)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({jsonrpc:'2.0', id:1, result:{isError:true, content:[{type:'text',text:'remote rejected'}]}}))))
    await expect(client.callTool('lookup', {})).rejects.toThrow('remote rejected')
  })

  it('runs commands inside the project and actually terminates a cancelled process', async () => {
    state.mode = 'full-access'
    const result = await cmdTool.execute({ command: process.execPath, args: ['-e', "require('fs').writeFileSync('cwd.txt',process.cwd())"] }, ctx)
    expect(result.success).toBe(true)
    expect(fs.readFileSync(path.join(project, 'cwd.txt'), 'utf8')).toBe(project)
    const controller = new AbortController()
    const pidFile = path.join(project, 'child.pid')
    const running = cmdTool.execute({ command: process.execPath, args: ['-e', "require('fs').writeFileSync('child.pid',String(process.pid));setInterval(()=>{},1000)"] }, {...ctx, signal:controller.signal})
    const rejected = expect(running).rejects.toMatchObject({ name:'AbortError' })
    await expect.poll(() => fs.existsSync(pidFile)).toBe(true)
    const pid = Number(fs.readFileSync(pidFile,'utf8'))
    controller.abort()
    await rejected
    expect(() => process.kill(pid, 0)).toThrow()
  }, 15000)
})
