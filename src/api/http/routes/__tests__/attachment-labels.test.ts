/** Model-input evidence: labels remain beside their actual image bytes, including
 * a missing middle image, and history keeps labels without copying file content. */
import { describe, expect, it, vi } from 'vitest'
import type { AgentContext } from '../../../../core/agent-context/index.js'

vi.mock('node:fs', () => ({ default: { existsSync: (path: string) => !path.includes('missing'), readFileSync: (path: string) => Buffer.from(path) } }))
vi.mock('../../../../workspace/index.js', () => ({ workspaceManager: { resolveSafePath: (_ctx: unknown, path: string) => path } }))
vi.mock('../../../../tools/file/index.js', () => ({ readFileTool: { execute: async ({ path }: { path: string }) => ({ success: true, output: 'text of ' + path }) } }))
vi.mock('../../../../tools/file/vision-proxy.js', () => ({ isVisionProxyConfigured: () => false, describeImageWithVisionProxy: vi.fn() }))

import { autoProcessAttachments } from '../attachment-auto-processor.js'
import { attachmentHistoryMetadata } from '../../../../core/attachment-input.js'

const context = { logger: { warn: vi.fn() } } as unknown as AgentContext

describe('attachment reference labels', () => {
  it('keeps image label and bytes adjacent without renumbering after a failed image', async () => {
    const result = await autoProcessAttachments(context, '比较图1和图3', '比较图1和图3', [
      { name: 'first.png', referenceLabel: '图1', attachmentId: 'one' },
      { name: 'missing.png', referenceLabel: '图2', attachmentId: 'two' },
      { name: 'third.png', referenceLabel: '图3', attachmentId: 'three' }
    ], { isVisionModel: true, messageText: '比较图1和图3' })
    expect(result.visionInlined).toBe(true)
    expect(result.processedFiles).toEqual(['first.png', 'third.png'])
    expect(result.prompt).toEqual([
      expect.objectContaining({ type: 'text' }),
      { type: 'text', text: '【图1（文件：first.png）】' },
      { type: 'image_url', image_url: { url: `data:image/png;base64,${Buffer.from('first.png').toString('base64')}` } },
      { type: 'text', text: '【图3（文件：third.png）】' },
      { type: 'image_url', image_url: { url: `data:image/png;base64,${Buffer.from('third.png').toString('base64')}` } },
      { type: 'text', text: expect.stringContaining('【图2（文件：missing.png）】\n附件读取失败') }
    ])
  })

  it('keeps labels in OCR and ordinary file text when native vision is unavailable', async () => {
    const result = await autoProcessAttachments(context, '', '', [
      { name: 'first.png', referenceLabel: '图1' }, { name: 'notes.txt', referenceLabel: '附件1' }
    ], { isVisionModel: false, messageText: '' })
    expect(result.visionInlined).toBe(false)
    expect(result.prompt).toContain('【图1（文件：first.png） 内容】\ntext of first.png')
    expect(result.prompt).toContain('【附件1（文件：notes.txt） 内容】\ntext of notes.txt')
  })

  it('persists original display name, stable identity and frozen label without inline bytes', () => {
    expect(attachmentHistoryMetadata({ name: '.ae/a.png', displayName: '原图.png', type: 'image/png', attachmentId: 'a', referenceLabel: '图10', size: 42, content: 'secret-bytes', encoding: 'base64' }))
      .toEqual({ name: '.ae/a.png', displayName: '原图.png', type: 'image/png', attachmentId: 'a', referenceLabel: '图10', size: 42 })
    expect(attachmentHistoryMetadata({ name: 'legacy.png' })).toEqual({ name: 'legacy.png' })
  })
})
