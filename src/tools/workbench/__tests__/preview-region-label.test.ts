/** Region metadata must describe the actual client version, without turning
 * successful image delivery into a completeness or visual quality claim. */
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentContext } from '../../../core/agent-context/index.js'
import { captureOfficeEvidence } from '../../../core/utils/tool-evidence.js'
import { workbenchBridge } from '../bridge.js'
import { workbenchRenderTool } from '../render.js'

const parent = path.resolve('.e2e-tmp')
let workspace = ''
beforeEach(() => { fs.mkdirSync(parent, { recursive: true }); workspace = fs.mkdtempSync(path.join(parent, 'region-label-')) })
afterEach(() => {
  vi.restoreAllMocks()
  if (path.dirname(workspace) !== parent || !path.basename(workspace).startsWith('region-label-')) throw new Error('Unsafe fixture cleanup')
  fs.rmSync(workspace, { recursive: true, force: true })
})

describe('client preview region labels', () => {
  it.each(['docx', 'xlsx'] as const)('labels new %s images as content regions and preserves this through evidence', async format => {
    const file = path.join(workspace, `source.${format}`)
    fs.writeFileSync(file, 'version-pinned fixture')
    vi.spyOn(workbenchBridge, 'execute').mockResolvedValue({ success: true,
      output: JSON.stringify({ format, renderer: `aether-${format}-preview-2.0.0`, pageCount: 9, unit: 'page' }) })
    const context = { tenantId: 'region-label', sessionId: 'fixture', modelCaps: { vision: true }, modelName: 'fixture',
      workspaceDir: workspace, workspacePaths: [workspace], cwd: workspace, projectRoot: workspace } as AgentContext
    const args = { path: file, page: 9 }
    const result = await workbenchRenderTool.execute(args, context)
    expect(result.success).toBe(true)
    const image = JSON.parse(result.output)
    expect(image.unit).toBe('content-chunk')
    expect(image.description).toContain('第 9/9 预览区域')
    expect(image.description).toContain('不是原生打印页码')
    expect(image.description).toContain('截图成功不代表验收通过')
    expect(captureOfficeEvidence({ name: 'workbench_render', args }, result)).toMatchObject({ files: [{ unit: 'content-chunk' }] })
  })

  it.each(['docx', 'xlsx'] as const)('retains the older %s client boundary', async format => {
    const file = path.join(workspace, `source.${format}`)
    fs.writeFileSync(file, 'older-client fixture')
    vi.spyOn(workbenchBridge, 'execute').mockResolvedValue({ success: true,
      output: JSON.stringify({ format, renderer: `aether-${format}-preview-1.0.0`, pageCount: 1 }) })
    const context = { tenantId: 'region-label', sessionId: 'fixture', modelCaps: { vision: true }, modelName: 'fixture',
      workspaceDir: workspace, workspacePaths: [workspace], cwd: workspace, projectRoot: workspace } as AgentContext
    const result = await workbenchRenderTool.execute({ path: file }, context)
    expect(result.success).toBe(true)
    const image = JSON.parse(result.output)
    expect(image.unit).toBe(format === 'docx' ? 'section' : 'content-chunk')
    expect(image.description).toContain('旧版客户端可能裁切')
    expect(image.description).not.toContain('第 1/1 预览区域')
  })
})
