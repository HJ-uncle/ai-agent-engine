/** New navigation regression: exact region ownership, bounded directory text,
 * run/version isolation and real provider projection (no model request). */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { AgentContext, Message } from '../../../core/agent-context/types.js'
import type { BrowserExecutionContext } from '../../../core/browser-execution.js'
import { OpenAIAdapter } from '../../../core/llm-adapter/openai.js'
import { AnthropicAdapter } from '../../../core/llm-adapter/anthropic.js'
import { workbenchBridge } from '../bridge.js'
import { workbenchRenderTool } from '../render.js'
import { validateXlsxPreviewMetadata, XlsxNavigationDeliveryTracker, xlsxPreviewDescription, type XlsxPreviewMetadata } from '../xlsx-preview-navigation.js'

const metadata: XlsxPreviewMetadata = { currentRegion: { sheet: 2, name: '统计', kind: 'chart', title: '功能状态分布' },
  navigation: { sheets: [
    { sheet: 1, name: '功能清单', firstPage: 1, lastPage: 5, chartPages: [] },
    { sheet: 2, name: '统计', firstPage: 6, lastPage: 8, chartPages: [7, 8] },
    { sheet: 3, name: '项目文件', firstPage: 9, lastPage: 10, chartPages: [] },
  ] } }
const scope: BrowserExecutionContext = { tenantId: 'navigation', sessionId: 'chat', rootRunId: 'run' }
const hash = 'a'.repeat(64)
const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aDdwAAAAASUVORK5CYII='
let fixture: string | undefined
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllGlobals()
  if (fixture) {
    if (path.dirname(fixture) !== path.resolve(os.tmpdir()) || !path.basename(fixture).startsWith('xlsx-navigation-')) throw new Error('Unsafe cleanup')
    fs.rmSync(fixture, { recursive: true, force: true }); fixture = undefined
  }
})

it('validates complete worksheet ranges and current chart ownership, with old clients optional', () => {
  expect(validateXlsxPreviewMetadata(metadata as unknown as Record<string, unknown>, 7, 10)).toEqual(metadata)
  expect(validateXlsxPreviewMetadata({}, 1, 1)).toBeUndefined()
  for (const invalid of [
    { ...metadata, currentRegion: { ...metadata.currentRegion, name: '错误表' } },
    { ...metadata, currentRegion: { sheet: 2, name: '统计', kind: 'cells', range: 'A1:B2' } },
    { ...metadata, navigation: { sheets: metadata.navigation.sheets.slice(0, 2) } },
    { ...metadata, navigation: { sheets: metadata.navigation.sheets.map((sheet, i) => i === 1 ? { ...sheet, chartPages: [6, 8] } : sheet) } },
    { currentRegion: metadata.currentRegion },
  ]) expect(() => validateXlsxPreviewMetadata(invalid, 7, 10)).toThrow()
})

it('returns the directory once per identity/version and explicitly restores it', () => {
  const tracker = new XlsxNavigationDeliveryTracker()
  expect(tracker.include(scope, hash, metadata.navigation, false)).toBe(false)
  expect(tracker.include(scope, hash, metadata.navigation)).toBe(true)
  expect(tracker.include(scope, hash, metadata.navigation)).toBe(false)
  expect(tracker.include(scope, hash, metadata.navigation, true)).toBe(true)
  expect(tracker.include(scope, 'b'.repeat(64), metadata.navigation)).toBe(true)
  for (const change of [{ rootRunId: 'next-root' }, { tenantId: 'other' }, { sessionId: 'child', rootSessionId: 'chat', runId: 'child-run' }])
    expect(tracker.include({ ...scope, ...change }, hash, metadata.navigation)).toBe(true)
  expect(new XlsxNavigationDeliveryTracker().include(scope, hash, metadata.navigation)).toBe(true)
})

it('keeps every worksheet and chart interval plus verification boundaries inside 1024 characters', () => {
  const large: XlsxPreviewMetadata = {
    currentRegion: { sheet: 24, name: '长工作表名称'.repeat(20), kind: 'chart', title: '长图表标题'.repeat(100) },
    navigation: { sheets: Array.from({ length: 24 }, (_, i) => ({ sheet: i + 1, name: '长工作表名称'.repeat(20), firstPage: i * 4 + 1, lastPage: i * 4 + 4, chartPages: [i * 4 + 3, i * 4 + 4] })) },
  }
  const description = xlsxPreviewDescription(large, 96, 96, true)
  expect(description.length).toBeLessThanOrEqual(1024)
  expect(description).toContain('…为名称缩写')
  for (const sheet of large.navigation.sheets) {
    expect(description).toContain(`${sheet.sheet}:`)
    expect(description).toContain(`[${sheet.firstPage}–${sheet.lastPage};图${sheet.chartPages[0]}–${sheet.chartPages[1]}]`)
  }
  expect(description).toContain('不是原生打印页码')
  expect(description).toContain('截图成功不代表验收通过')
  expect(large.currentRegion.name).toHaveLength(120)
  expect(large.currentRegion.kind === 'chart' && large.currentRegion.title).toHaveLength(500)
})

it('the tool returns accurate current region on every image, suppresses repeats and accepts old clients', async () => {
  fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'xlsx-navigation-'))
  const file = path.join(fixture, 'source.xlsx'); fs.writeFileSync(file, 'one version')
  const ctx = { ...scope, sessionId: path.basename(fixture), modelCaps: { vision: true }, modelName: 'fixture',
    workspaceDir: fixture, workspacePaths: [fixture], cwd: fixture, projectRoot: fixture } as AgentContext
  const bridge = vi.spyOn(workbenchBridge, 'execute').mockResolvedValue({ success: true, output: JSON.stringify({ ...metadata,
    renderer: 'aether-xlsx-preview-2.0.0', pageCount: 10, dataUrl: image }) })
  const render = async (options = {}) => {
    const result = await workbenchRenderTool.execute({ path: file, page: 7, ...options }, ctx)
    expect(result.success).toBe(true); return JSON.parse(result.output)
  }
  expect((await render()).navigation).toEqual(metadata.navigation)
  const repeated = await render()
  expect(repeated.navigation).toBeUndefined()
  expect(repeated.currentRegion).toEqual(metadata.currentRegion)
  expect(repeated.description).toContain('功能状态分布')
  expect(repeated.description).not.toContain('目录（')
  expect((await render({ includeNavigation: true })).navigation).toEqual(metadata.navigation)
  fs.writeFileSync(file, 'changed version')
  expect((await render()).navigation).toEqual(metadata.navigation)
  bridge.mockResolvedValue({ success: true, output: JSON.stringify({ renderer: 'aether-xlsx-preview-1.0.0', pageCount: 10, dataUrl: image }) })
  const old = await render({ includeNavigation: true })
  expect(old.navigation).toBeUndefined(); expect(old.currentRegion).toBeUndefined()
  expect(old.description).toContain('旧版客户端')
})

it.each(['openai', 'anthropic'] as const)('%s actual image projection retains the directory and boundary without raising its text cap', async provider => {
  const bodies: Array<{ messages: unknown[] }> = []
  vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)))
    return provider === 'openai'
      ? Response.json({ choices: [{ message: { content: 'checked' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } })
      : Response.json({ id: 'a', type: 'message', role: 'assistant', model: 'claude-test', content: [{ type: 'text', text: 'checked' }], usage: { input_tokens: 1, output_tokens: 1 }, stop_reason: 'end_turn' })
  }))
  const description = xlsxPreviewDescription(metadata, 7, 10, true)
  const messages: Message[] = [{ role: 'user', content: 'Inspect spreadsheet.' },
    { role: 'assistant', content: '', toolCall: { id: 'render', name: 'workbench_render', args: { path: 'source.xlsx', page: 7 } } },
    { role: 'tool', toolName: 'workbench_render', toolCallId: 'render', content: JSON.stringify({ filename: 'source.xlsx', dataUrl: image, description }) }]
  const adapter = provider === 'openai' ? new OpenAIAdapter('gpt-4o', 'fixture-key', 'http://model.invalid', true)
    : new AnthropicAdapter('claude-test', 'fixture-key', 'http://model.invalid', undefined, true)
  await adapter.complete(messages, { model: adapter.model })
  expect(bodies).toHaveLength(1)
  const actual = JSON.stringify(bodies[0].messages)
  expect(actual).toContain('2:统计[6–8;图7–8]')
  expect(actual).toContain('功能状态分布')
  expect(actual).toContain('截图成功不代表验收通过')
})
