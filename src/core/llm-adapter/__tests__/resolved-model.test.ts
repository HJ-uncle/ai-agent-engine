/** Verifies credentials/headers are reused only for the same resolved model and child caps are recomputed. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveModelConfig, type ResolvedModelConfig } from '../resolve-model.js'
const mocks=vi.hoisted(()=>({getModels:vi.fn(),getWhitelists:vi.fn(async()=>[])}))
vi.mock('../../../storage/sqlite/models.js',()=>({ModelsStore:class {getModels=mocks.getModels;getWhitelists=mocks.getWhitelists}}))
vi.mock('../../../storage/sqlite/system-config.js',()=>({systemConfigStore:{get:vi.fn(async()=>null)}}))
afterEach(()=>{vi.unstubAllEnvs();vi.clearAllMocks()})
describe('resolved child models',()=>{
  const parent:ResolvedModelConfig={model:'parent-model',provider:'anthropic',apiKey:'parent-memory-key',baseUrl:'http://parent.invalid',extraHeaders:{'X-Access-Token':'parent-header'},capabilities:{vision:false,thinking:true},thinkingConfig:{thinking:{type:'enabled'}}}
  it('inherits the exact memory object when the model is unchanged',async()=>{
    expect(await resolveModelConfig({tenantId:'t',parent,model:'parent-model'})).toBe(parent)
    expect(mocks.getModels).not.toHaveBeenCalled()
  })
  it('switching model resolves that model credentials, headers and capabilities independently',async()=>{
    mocks.getModels.mockResolvedValue([{id:'child-id',modelId:'child-model',provider:'custom',apiKey:'child-memory-key',baseUrl:'http://child.invalid',isEnabled:true,capabilities:{vision:true,thinking:false,contextWindow:12345}}])
    const resolved=await resolveModelConfig({tenantId:'t',parent,model:'child-model'})
    expect(resolved).toMatchObject({model:'child-model',provider:'custom',apiKey:'child-memory-key',baseUrl:'http://child.invalid',capabilities:{vision:true,thinking:false,contextWindow:12345}})
    expect(resolved.extraHeaders).toBeUndefined()
    expect(resolved.thinkingConfig).toBeUndefined()
  })
})
