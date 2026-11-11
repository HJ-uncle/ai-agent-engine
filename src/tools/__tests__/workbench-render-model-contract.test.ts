/** New regression for the actual registered model projection. A stale compact
 * description must not hide capabilities present in the canonical renderer. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { skillsRegistry } from '../../skills/index.js'
import { createToolRegistry } from '../registry-factory.js'
import { createSubagentToolRegistry } from '../subagent/subagent-tool.js'
import { workbenchRenderTool } from '../workbench/render.js'

vi.mock('../../storage/mcp/mcp-config.js', () => ({ listServers: () => [] }))
beforeEach(() => {
  vi.stubEnv('OSM_MODE', 'balanced')
  vi.spyOn(skillsRegistry, 'getSkills').mockReturnValue([])
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs() })

describe('registered Office preview model contract', () => {
  it('uses the canonical preview description in model definitions and the loaded request', async () => {
    const { registry } = await createToolRegistry({ allowedMcpServers: [], memoryScopes: ['global', 'session'] })
    const catalogue = registry.list().find(tool => tool.name === 'workbench_render')!
    const projected = registry.listForModel().find(tool => tool.name === 'workbench_render')!
    expect(catalogue.description).toBe(workbenchRenderTool.description)
    expect(projected.description).toBe(catalogue.description)
    registry.loadForModel(['workbench_render'])
    expect(registry.listForRequest().find(tool => tool.name === 'workbench_render')?.description).toBe(catalogue.description)
    for (const phrase of ['保留原字号', '表格样式及支持的图表', '旧客户端可能裁切或简化', '截图成功不代表视觉验收']) {
      expect(projected.description).toContain(phrase)
    }
    expect(projected.description).not.toContain('omit original styles/charts')
    expect(projected.description).not.toContain('simplified XLSX content chunks')
  })

  it('preserves the same canonical contract for a delegated executor', async () => {
    const { registry } = await createToolRegistry({ allowedMcpServers: [], memoryScopes: ['global', 'session'] })
    const child = createSubagentToolRegistry(registry, false)
    const canonical = child.list().find(tool => tool.name === 'workbench_render')!
    expect(canonical.description).toBe(workbenchRenderTool.description)
    expect(child.listForModel!().find(tool => tool.name === 'workbench_render')?.description).toBe(canonical.description)
  })
})
