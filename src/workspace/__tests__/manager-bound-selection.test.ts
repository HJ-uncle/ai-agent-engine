// Automation must distinguish an explicit selected project from the scratch/context fallback.
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {beforeEach,afterEach,describe,it,expect,vi} from 'vitest'
import {WorkspaceManager} from '../manager.js'
let fixture:string;let root:string;let project:string;let manager:WorkspaceManager
beforeEach(()=>{
  fixture=fs.mkdtempSync(path.join(os.tmpdir(),'aether-explicit-workspace-'));root=path.join(fixture,'private');project=path.join(fixture,'project')
  fs.mkdirSync(root);fs.mkdirSync(project);vi.stubEnv('AUTH_ENABLED','false');vi.stubEnv('AETHER_ALLOWED_WORKSPACE_ROOTS',project)
  vi.stubEnv('AETHER_WORKSPACE_BINDINGS_FILE',path.join(fixture,'bindings.json'));manager=new WorkspaceManager(root)
})
afterEach(()=>{
  vi.unstubAllEnvs()
  if(path.dirname(fixture)!==path.resolve(os.tmpdir()) || !path.basename(fixture).startsWith('aether-explicit-workspace-'))throw new Error('Unsafe fixture cleanup')
  fs.rmSync(fixture,{recursive:true,force:true})
})
describe('explicit automation workspace selection',()=>{
  it('returns null for an unbound session even when context cwd can resolve a project',()=>{
    const ctx={tenantId:'tenant',sessionId:'source',cwd:project}
    expect(manager.getWorkingDirectory(ctx)).toBe(path.resolve(project));expect(manager.getBoundDirectory(ctx)).toBeNull()
  })
  it('loads the persisted canonical selection after manager recreation and keeps it tenant scoped',()=>{
    manager.bind({tenantId:'tenant',sessionId:'source'},project)
    const reopened=new WorkspaceManager(root)
    expect(reopened.getBoundDirectory({tenantId:'tenant',sessionId:'source'})).toBe(fs.realpathSync(project))
    expect(reopened.getBoundDirectory({tenantId:'foreign',sessionId:'source'})).toBeNull()
  })
  it('revalidates a missing or narrowed selection instead of switching to scratch',()=>{
    manager.bind({tenantId:'tenant',sessionId:'source'},project)
    fs.renameSync(project,project+'-moved')
    expect(()=>manager.getBoundDirectory({tenantId:'tenant',sessionId:'source'})).toThrow('no longer available')
    fs.renameSync(project+'-moved',project);vi.stubEnv('AETHER_ALLOWED_WORKSPACE_ROOTS','')
    expect(()=>new WorkspaceManager(root).getBoundDirectory({tenantId:'tenant',sessionId:'source'})).toThrow('outside')
  })
  it('rejects a persisted no-auth overlap when authenticated tenant isolation is enabled',()=>{
    manager.bind({tenantId:'tenant',sessionId:'source'},project);manager.bind({tenantId:'foreign',sessionId:'source'},project)
    vi.stubEnv('AUTH_ENABLED','true')
    expect(()=>new WorkspaceManager(root).getBoundDirectory({tenantId:'tenant',sessionId:'source'})).toThrow('overlaps')
  })
})
