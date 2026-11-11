import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import { basename, extname } from 'node:path'
import { z } from 'zod'
import type { AgentContext, Tool } from '../../core/agent-context/index.js'
import { resolveCapabilities } from '../../core/model-capabilities/index.js'
import { workspaceManager } from '../../workspace/index.js'
import { workbenchBridge } from './bridge.js'
import { pptRenderProgress } from './ppt-render-progress.js'
import { validateXlsxPreviewMetadata, xlsxNavigationDelivery, xlsxPreviewDescription } from './xlsx-preview-navigation.js'

type OfficeRenderFormat = 'docx' | 'xlsx' | 'pptx' | 'pdf'
function formatForPath(inputPath: string): OfficeRenderFormat {
  const extension = extname(inputPath).toLowerCase()
  if (extension === '.docx' || extension === '.xlsx' || extension === '.pptx' || extension === '.pdf') return extension.slice(1) as OfficeRenderFormat
  throw new Error('当前画面检查仅支持 DOCX、XLSX、PPTX 和 PDF。')
}
const schema = z.object({ path: z.string().min(1).max(4096), page: z.number().int().min(1).max(100).default(1),
  expectedHash: z.string().regex(/^(?:sha256:)?[a-f0-9]{64}$/).optional(), includeNavigation: z.boolean().optional() }).strict()
class FileChanged extends Error {}
async function readAuthorizedVersion(ctx: AgentContext, inputPath: string): Promise<{ path: string; hash: string }> {
  const path = await fs.realpath(workspaceManager.resolveSafePath(ctx, inputPath))
  workspaceManager.resolveSafePath(ctx, path)
  const handle = await fs.open(path, 'r')
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size > 16 * 1024 * 1024) throw new Error('需要不超过 16 MB 的现有办公文件。')
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
  name: 'workbench_render', displayName: '检查办公文件实际画面', executionMode: 'serial',
  description: '通过在线 Aether 客户端渲染真实办公文件，传 expectedHash 锁定版本。page/pageCount 对 PPTX/PDF 是页，DOCX/XLSX 是按内容顺序编号的预览区域，不是原生打印页或工作表编号。新版保留原字号、表格样式及支持的图表，长内容分区展示；旧客户端可能裁切或简化，按回执边界判断。仅记录实际可见覆盖，不为迁就截图删内容。截图成功不代表视觉验收或外部办公应用原生保真。',
  parameters: { type: 'object', additionalProperties: false, required: ['path'], properties: {
    path: { type: 'string', minLength: 1, maxLength: 4096 }, page: { type: 'integer', minimum: 1, maximum: 100, default: 1 },
    includeNavigation: { type: 'boolean', description: 'XLSX目录默认同任务同版本首次返回；true重新返回，false省略。当前区域始终标明工作表和范围或图表。' },
    expectedHash: { type: 'string', pattern: '^(sha256:)?[a-f0-9]{64}$', description: '前次回执的 sha256（也接受 sha256: 前缀）；文件变化时拒绝混用旧画面。' }
  } },
  async execute(args, ctx) {
    const input = schema.parse(args)
    const fail = (code: string, output: string) => ({ success: false, output, metadata: { code, operationPerformed: false } })
    if (resolveCapabilities({ model: ctx.modelName, overrides: ctx.modelCaps ?? ctx.resolvedModel?.capabilities }).vision !== true)
      return fail('WORKBENCH_VISION_UNAVAILABLE', '当前模型不支持图片输入，无法完成逐页视觉检查。请切换支持视觉的模型；不要把结构检查当作视觉验收。')
    let format: OfficeRenderFormat
    try { format = formatForPath(input.path) }
    catch (error) { return fail('WORKBENCH_FORMAT_UNSUPPORTED', error instanceof Error ? error.message : '当前画面检查仅支持 DOCX、XLSX、PPTX 和 PDF。') }
    try {
      const { path, hash: expectedHash } = await readAuthorizedVersion(ctx, input.path)
      if (input.expectedHash && expectedHash !== input.expectedHash.replace(/^sha256:/, '')) return fail('WORKBENCH_FILE_CHANGED', '文件版本已变化；确认最新 hash 后检查受影响页，本次未返回画面。')
      const result = await workbenchBridge.execute('artifact.render', { path, page: input.page, expectedHash, format }, ctx)
      if (!result.success) return result
      const latest = await readAuthorizedVersion(ctx, input.path)
      if (latest.path !== path || latest.hash !== expectedHash) return fail('WORKBENCH_FILE_CHANGED', '渲染期间文件已变化，本次画面不能作为当前文件的验收证据。')
      const rendered = JSON.parse(result.output) as { pageCount: number; dataUrl: string; format?: string; renderer?: string; currentRegion?: unknown; navigation?: unknown }
      if (rendered.format !== undefined && rendered.format !== format) return fail('WORKBENCH_RENDER_FAILED', '客户端返回的办公文件格式与请求不一致。')
      const regionPreview = (format === 'docx' || format === 'xlsx') && rendered.renderer === `aether-${format}-preview-2.0.0`
      const pageLabel = regionPreview ? '预览区域' : format === 'xlsx' ? '内容块' : format === 'docx' ? '区段' : '页'
      const unit = regionPreview || format === 'xlsx' ? 'content-chunk' : format === 'docx' ? 'section' : 'page'
      const previewBoundary = regionPreview
        ? '按原内容顺序分区，编号不是原生打印页码；请按实际可见内容判断覆盖。'
        : format === 'docx' || format === 'xlsx' ? '旧版客户端可能裁切长区段或简化样式，不能据此宣称完整覆盖。' : ''
      const pageIdentity = `第 ${input.page}/${rendered.pageCount} ${pageLabel}`
      const xlsx = format === 'xlsx' ? validateXlsxPreviewMetadata(rendered, input.page, rendered.pageCount) : undefined
      const includeNavigation = xlsx ? xlsxNavigationDelivery.include(ctx, expectedHash, xlsx.navigation, input.includeNavigation) : false
      const navigationFields = xlsx ? { currentRegion: xlsx.currentRegion, ...(includeNavigation ? { navigation: xlsx.navigation } : {}) } : {}
      const progress = format === 'pptx' ? pptRenderProgress.record(ctx, expectedHash, input.page, rendered.pageCount) : undefined
      const progressDescription = progress
        ? ` 本任务同版本已返回图片页码：${progress.renderedPages.join(',')}；尚未返回：${progress.remainingPages.join(',') || '无'}；本页重复返回：${progress.repeatedPage ? '是' : '否'}。仅统计图片返回，不表示已查看或合格；未返回页不等于必须重验，局部修订只复核受影响页。`
        : ''
      // Provider adapters preserve fileVersion and description when reducing
      // image text budgets. Keep page identity and fidelity limits there too.
      return { ...result,
        // Preserve the authenticated identity without reparsing retained image payloads.
        metadata: { ...result.metadata, path, expectedHash: `sha256:${expectedHash}`, format, page: input.page, pageCount: rendered.pageCount, unit,
          ...navigationFields,
          ...(progress ? { renderProgress: progress } : {}) },
        output: JSON.stringify({ ...rendered, navigation: undefined, ...navigationFields,
        format, unit, filename: `${basename(path)} · ${pageIdentity}`,
        expectedHash: `sha256:${expectedHash}`,
        fileVersion: { path, expectedHash: `sha256:${expectedHash}`, encoding: 'binary-or-non-utf8', lineEnding: 'none', utf8Bom: false },
        ...(progress ? { renderProgress: progress } : {}),
        description: xlsx ? xlsxPreviewDescription(xlsx, input.page, rendered.pageCount, includeNavigation)
          : `原始 ${format.toUpperCase()} ${pageIdentity}。Aether 客户端预览，非外部办公应用原生渲染；画面固定 960×540。${previewBoundary}截图成功不代表验收通过；请检查布局、重叠、裁切、可读性。${progressDescription}`,
      }) }
    } catch (error) { return fail(error instanceof FileChanged ? 'WORKBENCH_FILE_CHANGED' : 'WORKBENCH_RENDER_FAILED', error instanceof Error ? error.message : '文件画面检查失败。') }
  }
}
