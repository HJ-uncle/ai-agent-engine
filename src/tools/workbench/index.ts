import fs from 'node:fs/promises'
import { z } from 'zod'
import type { Tool } from '../../core/agent-context/index.js'
import { workspaceManager } from '../../workspace/index.js'
import { workbenchBridge } from './bridge.js'
import { workbenchRenderTool } from './render.js'

const openSchema = z.object({ path: z.string().min(1).max(4096), line: z.number().int().positive().optional() }).strict()
const contextSchema = z.object({ terminalId: z.string().min(1).max(128).optional(), maxLines: z.number().int().min(1).max(200).optional() }).strict()
export const workbenchTools: Tool[] = [workbenchRenderTool, {
  name: 'workbench_context', displayName: '读取工作台状态', executionMode: 'readonly',
  description: '读取本会话已开文件、预览格式、终端和连接状态；terminalId指定终端最近输出。用户终端与execute_cmd任务分开；只读，不运行命令/输入按键/扩大权限，未连接返回不可用。',
  parameters: { type: 'object', additionalProperties: false, properties: { terminalId: { type: 'string', minLength: 1, maxLength: 128 }, maxLines: { type: 'integer', minimum: 1, maximum: 200, default: 80 } } },
  async execute(args, ctx) {
    const parsed = contextSchema.parse(args)
    return workbenchBridge.execute(parsed.terminalId ? 'terminal.read' : 'workspace.context', parsed, ctx)
  },
}, {
  name: 'workbench_open', displayName: '在工作台打开文件', executionMode: 'serial',
  description: '在本会话打开已存在的办公/媒体/文本/代码文件。path为真实路径，相对主工作区；line仅定位代码行。等待客户端回执：opened是入口已打开，renderStatus是读取状态，均不证明视觉验收。不创建文件或切换他人会话；HTML交互用browser_open。',
  parameters: { type: 'object', additionalProperties: false, required: ['path'], properties: { path: { type: 'string', minLength: 1, maxLength: 4096 }, line: { type: 'integer', minimum: 1 } } },
  async execute(args, ctx) {
    const parsed = openSchema.parse(args)
    const requested = workspaceManager.resolveSafePath(ctx, parsed.path)
    try {
      const canonical = await fs.realpath(requested)
      workspaceManager.resolveSafePath(ctx, canonical)
      const stat = await fs.stat(canonical)
      if (!stat.isFile()) return { success: false, output: '只能打开已存在的文件。', metadata: { code: 'WORKBENCH_FILE_REQUIRED', operationPerformed: false } }
      return workbenchBridge.execute('artifact.open', { path: canonical, ...(parsed.line ? { line: parsed.line } : {}) }, ctx)
    } catch (error) {
      return { success: false, output: error instanceof Error ? error.message : '无法访问指定文件。', metadata: { code: 'WORKBENCH_FILE_UNAVAILABLE', operationPerformed: false } }
    }
  },
}]
