import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentContext, ToolResult } from '../../core/agent-context/index.js'
import { workspaceManager } from '../../workspace/index.js'
import { skillsRegistry } from '../skills-registry.js'
import { loadProjectSkills } from '../project-skills.js'
import { SkillManagementService, assertSkillManagementAccess, type SkillManagementContext } from '../management-service.js'
import { createSkillManagementTools } from '../../tools/skill/management-tools.js'
import { withFileLocks } from '../../shared/file-version.js'

const fixtureParent = path.resolve('.e2e-tmp', 'skill-management')
const service = new SkillManagementService()
let root: string, project: string, context: SkillManagementContext
const main = (name = 'example', body = 'original') => `---\nname: ${name}\ndescription: Test skill\n---\n\n${body}\n`
const skillDir = (name = 'example') => path.join(project, '.ae', 'skills', name)
const seed = async (name = 'example', scope: 'project' | 'global' = 'project') =>
  (await service.apply(context, service.prepareCreate(context, { name, description: 'Test skill', content: 'original', scope }))).skill!

beforeEach(() => {
  fs.mkdirSync(fixtureParent, { recursive: true })
  root = fs.mkdtempSync(path.join(fixtureParent, 'fixture-'))
  project = path.join(root, 'project')
  fs.mkdirSync(project)
  vi.stubEnv('AUTH_ENABLED', 'false')
  vi.stubEnv('AETHER_GLOBAL_DIR', path.join(root, 'global'))
  vi.stubEnv('SKILLS_ROOT', path.join(root, 'deployment'))
  vi.spyOn(skillsRegistry, 'reload').mockImplementation(() => {})
  context = { tenantId: 'default', projectRoot: project }
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  if (path.dirname(root) !== fixtureParent || !path.basename(root).startsWith('fixture-')) throw new Error('Unsafe fixture cleanup')
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

describe('Skill management service', () => {
  it.each(['LF', 'BOM/CRLF'])('creates one header from a complete document with identical metadata (%s)', async format => {
    const body = '# Instructions\n\nPreserve this separator:\n\n---\n\nAnd this text.'
    const content = format === 'LF' ? main('example', body) : '\uFEFF' + main('example', body).replace(/\n/g, '\r\n')
    const pending = service.prepareCreate(context, { name: 'example', description: 'Test skill', content })
    const expected = main('example', format === 'LF' ? body : body.replace(/\n/g, '\r\n'))
    expect(pending.content).toBe(expected)
    const created = await service.apply(context, pending)
    expect(created.skill?.content).toBe(expected)
    expect(fs.readFileSync(path.join(skillDir(), 'SKILL.md'), 'utf8')).toBe(expected)
  })

  it.each([
    main('other'),
    main().replace('description: Test skill', 'description: Different description'),
    main().replace('description: Test skill', 'description: Test skill\nallowed-tools: read_file'),
    main().replace('name: example', 'name: example\nname: example'),
    '---\nname: example\ndescription: Test skill',
    main('example', main()),
  ])('rejects conflicting, extra or ambiguous metadata without creating files', content => {
    expect(() => service.prepareCreate(context, { name: 'example', description: 'Test skill', content })).toThrow(/正文|frontmatter/)
    expect(fs.existsSync(skillDir())).toBe(false)
  })

  it('rejects a header-only document instead of creating an empty skill', () => {
    expect(() => service.prepareCreate(context, { name: 'example', description: 'Test skill', content: main('example', '') })).toThrow()
    expect(fs.existsSync(skillDir())).toBe(false)
  })

  it('creates, reads, edits, disables and deletes the selected persistent skill', async () => {
    const created = await seed()
    expect(created).toMatchObject({ name: 'example', executionId: 'example', scope: 'project', enabled: true, dir: skillDir() })
    expect(created.id).toMatch(/^skill-[a-f0-9]{32}$/)
    expect(service.list(context)).toHaveLength(1)
    const updated = await service.apply(context, service.prepareChange(context, 'update', {
      id: created.id, expectedHash: created.hash, content: main('example', 'updated'),
    }))
    expect(updated.skill?.content).toContain('updated')
    expect(updated.resourceChange).toEqual({ kind: 'skill', action: 'update', id: created.id })
    await service.apply(context, service.prepareChange(context, 'set_enabled', { id: created.id, enabled: false }))
    expect(service.list(context)[0].enabled).toBe(false)
    await service.apply(context, service.prepareChange(context, 'delete', { id: created.id }))
    expect(fs.existsSync(skillDir())).toBe(false)
    expect(service.list(context)).toEqual([])
  })

  it('updates a custom main file without changing plugin.json, scripts or images', async () => {
    const dir = skillDir()
    fs.mkdirSync(path.join(dir, 'references'), { recursive: true })
    const manifest = JSON.stringify({ id: 'custom-runtime-id', name: 'example', description: 'Manifest description', main: 'references/main.md', extra: { keep: true } })
    fs.writeFileSync(path.join(dir, 'plugin.json'), manifest)
    fs.writeFileSync(path.join(dir, 'references', 'main.md'), main())
    fs.writeFileSync(path.join(dir, 'script.py'), 'print("preserved")')
    fs.writeFileSync(path.join(dir, 'image.png'), Buffer.from([0, 1, 2, 255]))
    const before = service.get(context, 'example')
    expect(before.executionId).toBe('custom-runtime-id')
    const result = await service.apply(context, service.prepareChange(context, 'update', {
      id: before.id, expectedHash: before.hash, content: main('example', 'edited'),
    }))
    expect(result.skill?.dir).toBe(dir)
    expect(result.skill?.description).toBe('Manifest description')
    expect(fs.readFileSync(path.join(dir, 'plugin.json'), 'utf8')).toBe(manifest)
    expect(fs.readFileSync(path.join(dir, 'script.py'), 'utf8')).toBe('print("preserved")')
    expect(fs.readFileSync(path.join(dir, 'image.png'))).toEqual(Buffer.from([0, 1, 2, 255]))
    expect(fs.existsSync(path.join(dir, 'SKILL.md'))).toBe(false)
  })

  it('rejects stale hashes, implicit renaming and malformed update arguments', async () => {
    const skill = await seed()
    const base = { id: skill.id, expectedHash: skill.hash, content: main('example', 'next') }
    expect(() => service.prepareChange(context, 'update', { ...base, expectedHash: 'sha256:' + '0'.repeat(64) })).toThrow(/版本/)
    expect(() => service.prepareChange(context, 'update', { ...base, content: main('renamed') })).toThrow(/name/)
    expect(() => service.prepareChange(context, 'update', { ...base, projectRoot: root })).toThrow()
    expect(() => service.prepareCreate(context, { name: '../outside', description: 'test', content: 'x' })).toThrow()
  })

  it.each(['main', 'manifest', 'config'])('rejects a %s change while approval is pending', async target => {
    const skill = await seed()
    const pending = service.prepareChange(context, 'update', { id: skill.id, expectedHash: skill.hash, content: main('example', 'unapproved replacement') })
    if (target === 'main') fs.writeFileSync(path.join(skill.dir, 'SKILL.md'), main('example', 'external edit'))
    if (target === 'manifest') fs.writeFileSync(path.join(skill.dir, 'plugin.json'), JSON.stringify({ name: 'example', enabled: false }))
    if (target === 'config') fs.writeFileSync(path.join(path.dirname(skill.dir), 'skills.config.json'), JSON.stringify({ defaults: { example: { enabled: false } } }))
    await expect(service.apply(context, JSON.parse(JSON.stringify(pending)))).rejects.toThrow(/变化/)
    expect(fs.readFileSync(path.join(skill.dir, 'SKILL.md'), 'utf8')).not.toContain('unapproved replacement')
  })

  it('freezes the entire directory before delete, including attachments and empty directories', async () => {
    const skill = await seed()
    fs.writeFileSync(path.join(skill.dir, 'script.py'), 'original script')
    const pending = service.prepareChange(context, 'delete', { id: skill.id })
    fs.writeFileSync(path.join(skill.dir, 'script.py'), 'external script')
    await expect(service.apply(context, pending)).rejects.toThrow(/附件/)
    const second = service.prepareChange(context, 'delete', { id: skill.id })
    fs.mkdirSync(path.join(skill.dir, 'new-directory'))
    await expect(service.apply(context, second)).rejects.toThrow(/附件/)
    expect(fs.existsSync(skill.dir)).toBe(true)
  })

  it('also freezes the source enablement config when editing a legacy skill', async () => {
    const legacy = path.join(project, '.aether', 'skills')
    fs.mkdirSync(path.join(legacy, 'example'), { recursive: true })
    fs.writeFileSync(path.join(legacy, 'example', 'SKILL.md'), main())
    const skill = service.get(context, 'example')
    const pending = service.prepareChange(context, 'update', { id: skill.id, expectedHash: skill.hash, content: main('example', 'next') })
    fs.writeFileSync(path.join(legacy, 'skills.config.json'), JSON.stringify({ defaults: { example: { enabled: false } } }))
    await expect(service.apply(context, pending)).rejects.toThrow(/变化/)
  })

  it('serializes competing updates so exactly one can apply the shared base revision', async () => {
    const skill = await seed()
    const one = service.prepareChange(context, 'update', { id: skill.id, expectedHash: skill.hash, content: main('example', 'one') })
    const two = service.prepareChange(context, 'update', { id: skill.id, expectedHash: skill.hash, content: main('example', 'two') })
    const results = await Promise.allSettled([service.apply(context, one), service.apply(context, two)])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
  })

  it('distinguishes project and global copies by ID and rejects ambiguous names', async () => {
    const local = await seed()
    const global = await seed('example', 'global')
    expect(service.list(context)).toHaveLength(2)
    expect(local.id).not.toBe(global.id)
    expect(() => service.get(context, 'example')).toThrow(/同名/)
    await service.apply(context, service.prepareChange(context, 'set_enabled', { id: global.id, enabled: false }))
    expect(service.get(context, local.id).enabled).toBe(true)
    expect(service.get(context, global.id).enabled).toBe(false)
  })

  it('suppresses legacy resurrection after deleting the current project copy', async () => {
    for (const layer of ['.aether/skills', 'SKILLs']) {
      const dir = path.join(project, layer, 'example')
      fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'SKILL.md'), main())
    }
    const current = await seed()
    await service.apply(context, service.prepareChange(context, 'delete', { id: current.id }))
    expect(service.list(context)).toEqual([])
    expect(loadProjectSkills(project)).toEqual([])
    expect(fs.existsSync(path.join(project, 'SKILLs', 'example', 'SKILL.md'))).toBe(true)
    await seed()
    expect(loadProjectSkills(project)).toHaveLength(1)
  })

  it.each(['root', 'skill', 'attachment'])('rejects a %s directory junction', async target => {
    const outside = path.join(root, 'outside')
    fs.mkdirSync(outside)
    fs.writeFileSync(path.join(outside, 'SKILL.md'), main())
    if (target === 'root') fs.symlinkSync(outside, path.join(project, '.ae'), 'junction')
    if (target === 'skill') {
      fs.mkdirSync(path.dirname(skillDir()), { recursive: true })
      fs.symlinkSync(outside, skillDir(), 'junction')
    }
    if (target === 'attachment') {
      await seed()
      fs.symlinkSync(outside, path.join(skillDir(), 'references'), 'junction')
    }
    expect(() => target === 'root' ? service.prepareCreate(context, { name: 'x', description: 'x', content: 'x' }) : service.get(context, 'example')).toThrow()
    expect(fs.readFileSync(path.join(outside, 'SKILL.md'), 'utf8')).toBe(main())
  })

  it('rejects manifest main traversal before reading outside the skill directory', () => {
    fs.mkdirSync(skillDir(), { recursive: true })
    fs.writeFileSync(path.join(skillDir(), 'plugin.json'), JSON.stringify({ main: '../../secret.md' }))
    expect(() => service.list(context)).toThrow(/授权目录/)
  })

  it('rejects a replaced global root instead of canonicalizing away the junction', () => {
    const outside = path.join(root, 'outside'), global = path.join(root, 'global')
    fs.mkdirSync(outside); fs.mkdirSync(global)
    fs.symlinkSync(outside, path.join(global, 'skills'), 'junction')
    expect(() => service.prepareCreate(context, { name: 'example', description: 'test', content: 'test', scope: 'global' })).toThrow(/联接/)
    expect(fs.readdirSync(outside)).toEqual([])
  })

  it('revalidates tenant, role and workspace before applying a frozen operation', async () => {
    const pending = service.prepareCreate(context, { name: 'example', description: 'test', content: 'test' })
    await expect(service.apply({ ...context, tenantId: 'other' }, pending)).rejects.toThrow(/租户|工作区/)
    await expect(service.apply({ ...context, projectRoot: root }, pending)).rejects.toThrow(/工作区/)
    await expect(service.apply({ ...context, principal: { tenantId: 'default', method: 'jwt', roles: [] } }, pending)).rejects.toThrow(/权限/)
    vi.stubEnv('AUTH_ENABLED', 'true')
    await expect(service.apply({ ...context, principal: { tenantId: 'default', method: 'jwt', roles: ['admin'] } }, pending)).rejects.toThrow(/allowed workspace/)
    expect(fs.existsSync(skillDir())).toBe(false)
  })

  it('does not allow auth downgrade or tenant mismatch, and limits global mutation to default tenant', () => {
    expect(() => assertSkillManagementAccess({ tenantId: 'other', principal: { tenantId: 'default', method: 'jwt', roles: ['admin'] } })).toThrow(/租户/)
    expect(() => assertSkillManagementAccess({ tenantId: 'default', principal: { tenantId: 'default', method: 'jwt', roles: [] } })).toThrow(/权限/)
    expect(() => assertSkillManagementAccess({ tenantId: 'other', principal: { tenantId: 'other', method: 'jwt', roles: ['admin'] } }, 'global')).toThrow(/共享资源/)
    vi.stubEnv('AUTH_ENABLED', 'true')
    expect(() => assertSkillManagementAccess({ tenantId: 'default' })).toThrow(/权限/)
    expect(() => assertSkillManagementAccess({ tenantId: 'default', principal: { tenantId: 'default', method: 'none' } })).toThrow(/权限/)
    expect(() => assertSkillManagementAccess({ tenantId: 'default', principal: { tenantId: 'default', method: 'jwt', roles: ['skill-manager'] } })).not.toThrow()
  })

  it('rejects a replacement directory created while a create approval is waiting', async () => {
    const pending = service.prepareCreate(context, { name: 'example', description: 'test', content: 'test' })
    fs.mkdirSync(skillDir(), { recursive: true })
    fs.writeFileSync(path.join(skillDir(), 'external.txt'), 'external')
    await expect(service.apply(context, pending)).rejects.toThrow(/已存在/)
    expect(fs.readFileSync(path.join(skillDir(), 'external.txt'), 'utf8')).toBe('external')
  })
})

describe('Skill management tools', () => {
  const tools = createSkillManagementTools(service)
  const tool = (name: string) => tools.find(item => item.name === name)!
  const ctx = () => ({ tenantId: 'default', sessionId: 'test', currentToolCallId: 'call-1' }) as AgentContext
  const approved = (name: string, args: Record<string, unknown>, waiting: ToolResult, context = ctx()): AgentContext => ({ ...context,
    approvedToolCallId: context.currentToolCallId,
    resumeToolCall: { decision: 'approved', toolCall: { id: context.currentToolCallId!, name, args },
      pendingAction: JSON.parse(JSON.stringify(waiting.pendingAction)) },
  })
  beforeEach(() => { vi.spyOn(workspaceManager, 'getWorkingDirectory').mockImplementation(() => project) })

  it('publishes exactly the six management tools', () => {
    expect(tools.map(item => item.name)).toEqual(['skill_list', 'skill_get', 'skill_create', 'skill_update', 'skill_set_enabled', 'skill_delete'])
  })
  it('freezes approval and resumes the original creation with a resource-change receipt', async () => {
    const args = { name: 'example', description: 'test', content: '# Approved body' }
    const waiting = await tool('skill_create').execute(args, ctx())
    expect(waiting).toMatchObject({ status: 'waiting', needsConfirmation: true })
    expect(fs.existsSync(skillDir())).toBe(false)
    expect(waiting.output).toContain('# Approved body')
    const result = await tool('skill_create').execute(args, approved('skill_create', args, waiting))
    expect(result).toMatchObject({ success: true, metadata: { resourceChange: { kind: 'skill', action: 'create' } } })
    expect(service.get(context, 'example').content).toContain('# Approved body')
  })
  it('rejects altered resume arguments and missing approval identity', async () => {
    const args = { name: 'example', description: 'test', content: 'Original' }
    const waiting = await tool('skill_create').execute(args, ctx())
    const resumed = approved('skill_create', args, waiting)
    expect((await tool('skill_create').execute({ ...args, content: 'Changed' }, resumed)).success).toBe(false)
    expect((await tool('skill_create').execute(args, { ...ctx(), approvedToolCallId: 'call-1' })).success).toBe(false)
    expect(fs.existsSync(skillDir())).toBe(false)
  })
  it('rejects child execution and model-supplied project roots', async () => {
    expect((await tool('skill_list').execute({}, { ...ctx(), parentSessionId: 'parent' })).success).toBe(false)
    expect((await tool('skill_create').execute({ name: 'example', description: 'test', content: 'x', projectRoot: root }, ctx())).success).toBe(false)
    expect((await tool('skill_get').execute({ id: 'example' }, ctx())).success).toBe(false)
    expect(fs.existsSync(skillDir())).toBe(false)
  })

  it.each(['skill_create', 'skill_update', 'skill_set_enabled', 'skill_delete'])('%s does not write after cancellation while queued for the file lock', async name => {
    const skill = await seed()
    const args: Record<string, unknown> = name === 'skill_create' ? { name: 'queued', description: 'test', content: 'cancelled body' }
      : name === 'skill_update' ? { id: skill.id, expectedHash: skill.hash, content: main('example', 'cancelled edit') }
        : name === 'skill_set_enabled' ? { id: skill.id, enabled: false } : { id: skill.id }
    const waiting = await tool(name).execute(args, ctx())
    expect(waiting.status).toBe('waiting')
    const controller = new AbortController()
    const resumed = { ...approved(name, args, waiting), signal: controller.signal }
    let release!: () => void, locked!: () => void, enteredApply!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    const acquired = new Promise<void>(resolve => { locked = resolve })
    const applying = new Promise<void>(resolve => { enteredApply = resolve })
    const config = path.join(path.dirname(skill.dir), 'skills.config.json')
    const owner = withFileLocks([config], async () => { locked(); await held })
    await acquired
    const originalApply = service.apply.bind(service)
    vi.spyOn(service, 'apply').mockImplementation((context, operation) => {
      const queued = originalApply(context, operation)
      enteredApply()
      return queued
    })
    const result = tool(name).execute(args, resumed)
    try {
      await applying // The approved call has passed helper admission and entered the locked service.
      controller.abort(new DOMException('User stopped the queued mutation', 'AbortError'))
    } finally { release() }
    await owner
    expect(await result).toMatchObject({ success: false, status: 'cancelled', output: 'User stopped the queued mutation' })
    expect(service.get(context, skill.id)).toMatchObject({ content: skill.content, enabled: true, hash: skill.hash })
    expect(fs.existsSync(config)).toBe(false)
    expect(fs.existsSync(path.join(path.dirname(skill.dir), 'queued'))).toBe(false)
  })
})
