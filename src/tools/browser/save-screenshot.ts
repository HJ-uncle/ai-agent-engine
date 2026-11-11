import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { AgentContext, Tool, ToolResult } from '../../core/agent-context/index.js'
import { resolveCapabilities } from '../../core/model-capabilities/index.js'
import { projectDataPath } from '../../core/project-storage.js'
import { throwIfAborted } from '../../core/utils/abort.js'
import { hashFileContent, readFileVersionSync } from '../../shared/file-version.js'
import { workspaceManager } from '../../workspace/index.js'
import { writeFileTool } from '../file/super-file-tool.js'
import { inspectPptxImage, MAX_PPTX_IMAGE_BYTES } from '../office/pptx-design.js'
import { browserBridge } from './browser-bridge.js'

const argumentsSchema = z.object({
  tabId: z.string().min(1).max(128), navigationId: z.number().int().nonnegative(),
  path: z.string().min(1).max(4096), expectedHash: z.string().regex(/^(missing|sha256:[a-f0-9]{64})$/).default('missing'),
}).strict()
const failure = (code: string, message: string): ToolResult => ({ success: false, error: code,
  output: message, metadata: { code, fileMutationApplied: false } })

/** Explicit screenshot saves stay in the selected workspace, including in full
 * mode. A symlink must not redirect an image or its private staging bytes. */
function plainPath(root: string, input: string, ctx: AgentContext): string {
  const target = path.resolve(root, input), relative = path.relative(root, target)
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('截图路径必须位于当前工作区内')
  workspaceManager.resolveSafePath(ctx, target)
  let current = root
  for (const component of relative.split(path.sep)) {
    current = path.join(current, component)
    try { if (fs.lstatSync(current).isSymbolicLink()) throw new Error('截图路径不能包含符号链接') }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
  return target
}

export function createSaveScreenshotTool(normalize: (result: ToolResult) => ToolResult): Tool {
  return {
    name: 'browser_save_screenshot', displayName: '保存浏览器截图',
    description: '捕获真实标签当前视口并保存为工作区 PNG，可直接将回执 path 用于 PPT image.path。携带最新 navigationId；新文件 expectedHash=missing，覆盖须目标当前版本。返回图像及真实文件版本，不需转抄 base64。不提供全页截图。',
    parameters: { type: 'object', additionalProperties: false, properties: {
      tabId: { type: 'string', minLength: 1, maxLength: 128 }, navigationId: { type: 'integer', minimum: 0 },
      path: { type: 'string', minLength: 1, maxLength: 4096, description: '当前工作区内的 .png 路径。' },
      expectedHash: { type: 'string', pattern: '^(missing|sha256:[a-f0-9]{64})$', default: 'missing' },
    }, required: ['tabId', 'navigationId', 'path'] },
    async execute(input: unknown, ctx: AgentContext): Promise<ToolResult> {
      const parsed = argumentsSchema.safeParse(input)
      if (!parsed.success || path.extname(parsed.data.path).toLowerCase() !== '.png') return failure('BROWSER_INVALID_ARGUMENTS', '保存截图需要真实 tabId、最新 navigationId 和工作区内 .png 路径。')
      if (resolveCapabilities({ model: ctx.modelName, overrides: ctx.modelCaps ?? ctx.resolvedModel?.capabilities }).vision !== true) {
        return failure('BROWSER_VISION_UNAVAILABLE', '当前模型未启用视觉能力，未捕获或保存截图。')
      }
      const args = parsed.data
      let ownedStage: string | undefined, stageWorkspace: string | undefined, mutationApplied = false
      try {
        throwIfAborted(ctx.signal)
        const guard = workspaceManager.bindingReadGuard(ctx), root = fs.realpathSync.native(guard.snapshot.root)
        if (!fs.statSync(root).isDirectory() || guard.snapshot.epoch.startsWith('scratch:')) return failure('BROWSER_SCREENSHOT_WORKSPACE_REQUIRED', '请先选择当前任务的工作区，再保存截图。')
        const target = plainPath(root, args.path, ctx)
        try { if (fs.statSync(target).size > MAX_PPTX_IMAGE_BYTES) return failure('BROWSER_SCREENSHOT_TARGET_TOO_LARGE', '已有目标超过截图大小限制，未覆盖。') }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
        if (readFileVersionSync(target).hash !== args.expectedHash) return failure('WRITE_VERSION_CONFLICT', '目标已存在或版本变化，未捕获截图，也未覆盖文件。')
        const captured = await browserBridge.execute('screenshot', { tabId: args.tabId, navigationId: args.navigationId }, ctx)
        if (!captured.success) return captured
        const normalized = normalize(captured)
        if (!normalized.success) return normalized
        const image = JSON.parse(normalized.output) as Record<string, unknown>
        const source = JSON.parse(captured.output) as Record<string, unknown>
        const tab = source.tab as { tabId?: unknown; navigationId?: unknown } | undefined
        const bytes = Buffer.from(String(image.dataUrl).slice('data:image/png;base64,'.length), 'base64')
        let dimensions: ReturnType<typeof inspectPptxImage>
        try {
          dimensions = inspectPptxImage(bytes)
          if (dimensions.mime !== 'image/png' || dimensions.width !== source.width || dimensions.height !== source.height ||
            tab?.tabId !== args.tabId || tab?.navigationId !== args.navigationId) throw new Error('截图尺寸或页面身份不匹配')
        } catch { return failure('BROWSER_INVALID_SCREENSHOT', '浏览器返回的 PNG 不完整、尺寸或页面身份不匹配，未保存文件。') }
        guard.assertCurrent()
        throwIfAborted(ctx.signal)
        return await workspaceManager.withBindingLease(ctx, guard.snapshot, async lease => {
          lease.assertCurrent()
          plainPath(root, target, ctx)
          const identity = createHash('sha256').update(JSON.stringify([ctx.tenantId, ctx.sessionId, ctx.rootRunId, ctx.runId])).digest('hex')
          const stagingRoot = plainPath(root, projectDataPath(root, 'tmp', 'browser-screenshots', identity), ctx)
          plainPath(root, projectDataPath(root, 'tmp', 'file-writes'), ctx)
          // Check each existing component before mkdir so private data never follows a junction.
          fs.mkdirSync(stagingRoot, { recursive: true })
          plainPath(root, stagingRoot, ctx)
          ownedStage = fs.mkdtempSync(path.join(stagingRoot, 'capture-'))
          stageWorkspace = root
          const digest = hashFileContent(bytes), sourcePath = path.join(ownedStage, `${digest.slice(7)}.png`)
          fs.writeFileSync(sourcePath, bytes, { flag: 'wx' })
          lease.assertCurrent()
          const saved = await writeFileTool.execute({ path: target, expectedHash: args.expectedHash,
            copyFrom: { path: sourcePath, expectedHash: digest } }, ctx)
          mutationApplied = saved.metadata?.fileMutationApplied === true
          if (!saved.success) return saved
          const fileVersion = { path: target, expectedHash: digest, encoding: 'binary-or-non-utf8', lineEnding: 'none', utf8Bom: false }
          return { ...saved, output: JSON.stringify({ ...image, filename: path.basename(target), path: target, expectedHash: digest,
            fileVersion, width: dimensions.width, height: dimensions.height,
            description: `Saved current browser screenshot. Reuse fileVersion.path as PPT image.path. ${String(image.description ?? '')}` }),
            metadata: { ...saved.metadata, path: target, expectedHash: digest, screenshotSaved: true,
              browserTabId: args.tabId, navigationId: args.navigationId, width: dimensions.width, height: dimensions.height } }
        })
      } catch (error) {
        return { ...failure('BROWSER_SCREENSHOT_SAVE_FAILED', error instanceof Error ? error.message : String(error)),
          metadata: { code: 'BROWSER_SCREENSHOT_SAVE_FAILED', fileMutationApplied: mutationApplied } }
      }
      finally {
        if (ownedStage) {
          // Only remove the fresh invocation directory; other sessions and images remain untouched.
          try {
            if (!stageWorkspace || fs.lstatSync(stageWorkspace).isSymbolicLink() || !path.basename(ownedStage).startsWith('capture-') ||
              path.basename(path.dirname(path.dirname(ownedStage))) !== 'browser-screenshots') throw new Error('Invalid screenshot staging cleanup path')
            plainPath(stageWorkspace, ownedStage, ctx)
            const real = fs.realpathSync.native(ownedStage), same = process.platform === 'win32' ? real.toLowerCase() === ownedStage.toLowerCase() : real === ownedStage
            if (!same) throw new Error('Screenshot staging directory changed before cleanup')
            fs.rmSync(ownedStage, { recursive: true, force: true })
          }
          catch (error) { ctx.logger.warn({ err: error }, 'Screenshot staging cleanup failed') }
        }
      }
    },
  }
}
