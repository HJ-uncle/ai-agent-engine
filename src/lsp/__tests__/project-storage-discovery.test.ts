/** Real TypeScript discovery must not treat generated .ae scripts as project source. */
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { workspaceManager } from '../../workspace/index.js'
import { disposeLanguageProject, handleLanguageRequest } from '../language-service.js'

const ctx = { tenantId: 'storage-discovery', sessionId: 'storage-discovery' }
let root = ''
afterEach(() => {
  disposeLanguageProject(ctx)
  vi.restoreAllMocks()
  if (!root) return
  if (path.dirname(root) !== path.resolve('.e2e-tmp')) throw new Error('Unsafe discovery fixture')
  fs.rmSync(root, { recursive: true, force: true })
})

it('keeps real workspace declarations in completion and excludes attachment declarations', () => {
  root = path.resolve('.e2e-tmp', 'storage-discovery-' + randomUUID())
  fs.mkdirSync(path.join(root, '.ae', 'attachments'), { recursive: true })
  fs.writeFileSync(path.join(root, 'main.ts'), '\n')
  fs.writeFileSync(path.join(root, 'project.ts'), 'const workspaceVisible = 1;\n')
  fs.writeFileSync(path.join(root, '.ae', 'attachments', 'copied.ts'), 'const runtimeAttachmentOnly = 1;\n')
  vi.spyOn(workspaceManager, 'getWorkingDirectory').mockReturnValue(root)
  const result = handleLanguageRequest(ctx, 'textDocument/completion', {
    textDocument: { uri: path.join(root, 'main.ts') }, position: { line: 0, character: 0 },
  }) as { items: Array<{ label: string }> }
  expect(result.items.map(item => item.label)).toContain('workspaceVisible')
  expect(result.items.map(item => item.label)).not.toContain('runtimeAttachmentOnly')
})


it('accepts advisory cancellation without a document and retains document validation', () => {
  root = path.resolve('.e2e-tmp', 'lsp-cancellation-' + randomUUID())
  fs.mkdirSync(root, { recursive: true })
  vi.spyOn(workspaceManager, 'getWorkingDirectory').mockReturnValue(root)
  expect(handleLanguageRequest(ctx, '$/cancelRequest', { id: 42 })).toBeNull()
  expect(handleLanguageRequest(ctx, '$/cancelRequest', {})).toBeNull()
  expect(() => handleLanguageRequest(ctx, 'textDocument/hover', {})).toThrow('缺少 textDocument.uri')
  expect(() => handleLanguageRequest(ctx, 'textDocument/hover', { textDocument: { uri: path.join(root, '..', 'outside.ts') } })).toThrow('文件路径不在当前工作区内')
})
