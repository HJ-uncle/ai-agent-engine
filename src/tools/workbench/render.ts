import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import { basename, extname } from 'node:path'
import { z } from 'zod'
import type { AgentContext, Tool } from '../../core/agent-context/index.js'
import { resolveCapabilities } from '../../core/model-capabilities/index.js'
import { workspaceManager } from '../../workspace/index.js'
import { workbenchBridge } from './bridge.js'

const schema = z.object({ path: z.string().min(1).max(4096), page: z.number().int().min(1).max(100).default(1),
  expectedHash: z.string().regex(/^(?:sha256:)?[a-f0-9]{64}$/).optional() }).strict()
class FileChanged extends Error {}
async function readAuthorizedVersion(ctx: AgentContext, inputPath: string): Promise<{ path: string; hash: string }> {
  const path = await fs.realpath(workspaceManager.resolveSafePath(ctx, inputPath))
  workspaceManager.resolveSafePath(ctx, path)
  const handle = await fs.open(path, 'r')
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size > 16 * 1024 * 1024) throw new Error('需要不超过 16 MB 的现有 PPTX 文件。')
    const checkPath = async () => {
      const current = await fs.realpath(workspaceManager.resolveSafePath(ctx, inputPath))
      workspaceManager.resolveSafePath(ctx, current)
      const currentStat = await fs.stat(current)
      if (current !== path || currentStat.dev !== stat.dev || currentStat.ino !== stat.ino) throw new FileChanged('文件路径在读取期间变化，请重新检查。')
    }
    await checkPath()
    // The actual descriptor read is bounded even if an external writer grows
    // or replaces the file after stat; no unbounded readFile allocation.
    const buffer = Buffer.alloc(stat.size + 1)
    let length = 0
    while (length < buffer.length) {
      ctx.signal?.throwIfAborted()
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length)
      if (!bytesRead) break
      length += bytesRead
    }
    const after = await handle.stat()
    if (length !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) throw new FileChanged('文件在读取期间变化，请重新检查。')
    await checkPath()
    return { path, hash: createHash('sha256').update(buffer.subarray(0, length)).digest('hex') }
  } finally { await handle.close() }
}
export const workbenchRenderTool: Tool = {
  name: 'workbench_render', displayName: '检查幻灯片实际画面', executionMode: 'serial',
  description: '将当前会话已有 PPTX 的指定页通过 Aether 客户端原文件预览渲染为图片，供视觉模型检查。返回 pageCount、page、sha256 与图片；逐页检查时传 expectedHash 锁定文件。需要在线客户端及视觉模型；此为 Aether HTML 预览保真边界，不等同 PowerPoint 原生渲染，截图成功不代表视觉验收通过。',
  parameters: { type: 'object', additionalProperties: false, required: ['path'], properties: {
    path: { type: 'string', minLength: 1, maxLength: 4096 }, page: { type: 'integer', minimum: 1, maximum: 100, default: 1 },
    expectedHash: { type: 'string', pattern: '^(sha256:)?[a-f0-9]{64}$', description: '前次回执的 sha256（也接受 sha256: 前缀）；文件变化时拒绝混用旧画面。' }
  } },
  async execute(args, ctx) {
    const input = schema.parse(args)
    const fail = (code: string, output: string) => ({ success: false, output, metadata: { code, operationPerformed: false } })
    if (resolveCapabilities({ model: ctx.modelName, overrides: ctx.modelCaps ?? ctx.resolvedModel?.capabilities }).vision !== true)
      return fail('WORKBENCH_VISION_UNAVAILABLE', '当前模型不支持图片输入，无法完成逐页视觉检查。请切换支持视觉的模型；不要把结构检查当作视觉验收。')
    if (extname(input.path).toLowerCase() !== '.pptx') return fail('WORKBENCH_FORMAT_UNSUPPORTED', '当前逐页画面检查仅支持 PPTX。')
    try {
      const { path, hash: expectedHash } = await readAuthorizedVersion(ctx, input.path)
      if (input.expectedHash && expectedHash !== input.expectedHash.replace(/^sha256:/, '')) return fail('WORKBENCH_FILE_CHANGED', '文件已变化，需从新版本重新检查，不能沿用旧页验收。')
      const result = await workbenchBridge.execute('artifact.render', { path, page: input.page, expectedHash }, ctx)
      if (!result.success) return result
      const latest = await readAuthorizedVersion(ctx, input.path)
      if (latest.path !== path || latest.hash !== expectedHash) return fail('WORKBENCH_FILE_CHANGED', '渲染期间文件已变化，本次画面不能作为当前文件的验收证据。')
      const rendered = JSON.parse(result.output) as { pageCount: number; dataUrl: string }
      // Provider adapters preserve fileVersion and description when reducing
      // image text budgets. Keep page identity and fidelity limits there too.
      return { ...result, output: JSON.stringify({ ...rendered,
        filename: `${basename(path)} · 第 ${input.page}/${rendered.pageCount} 页`,
        expectedHash: `sha256:${expectedHash}`,
        fileVersion: { path, expectedHash: `sha256:${expectedHash}`, encoding: 'binary-or-non-utf8', lineEnding: 'none', utf8Bom: false },
        description: `原始 PPTX 第 ${input.page}/${rendered.pageCount} 页。Aether 预览（Chromium + pptx-to-html），非 PowerPoint 原生渲染；不支持动画、SmartArt、嵌入字体及部分高级图形。画面固定 960×540，非16:9原稿会缩放至16:9。截图成功不代表验收通过；请检查布局、重叠、裁切、可读性。`,
      }) }
    } catch (error) { return fail(error instanceof FileChanged ? 'WORKBENCH_FILE_CHANGED' : 'WORKBENCH_RENDER_FAILED', error instanceof Error ? error.message : '文件画面检查失败。') }
  }
}
