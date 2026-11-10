/** Real Work table failures: actionable receipts, strict arguments and atomic repair. */
import fs from 'node:fs'
import path from 'node:path'
import { createClient, type Client } from '@libsql/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentContext } from '../../../core/agent-context/index.js'
import * as database from '../../../storage/sqlite/db.js'
import { ChangeStore } from '../../../storage/changes/index.js'
import { clearSecurityMode, setSecurityMode } from '../../../security/policy-engine.js'
import { officeDocumentTool } from '../index.js'
import type { PptxInput } from '../pptx-schema.js'
import { readOfficeZip } from '../office-zip.js'

const fixtures = path.resolve('.e2e-tmp')
let root: string, db: Client, ctx: AgentContext, store: ChangeStore
beforeEach(() => {
  fs.mkdirSync(fixtures, { recursive: true })
  root = fs.mkdtempSync(path.join(fixtures, 'pptx-recovery-'))
  vi.stubEnv('AUTH_ENABLED', 'false')
  vi.stubEnv('DATA_DIR', path.join(root, 'agent.db'))
  db = createClient({ url: 'file::memory:' })
  vi.spyOn(database, 'getDb').mockReturnValue(db)
  store = new ChangeStore()
  ctx = { tenantId: 'pptx-recovery', sessionId: path.basename(root), rootSessionId: path.basename(root), rootRunId: 'recovery-run', turnId: 'recovery-turn',
    workspacePaths: [root], projectRoot: root, cwd: root, scratchDir: path.join(root, 'scratch'),
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } } as unknown as AgentContext
  setSecurityMode(ctx.tenantId, ctx.sessionId, 'safe')
})
afterEach(() => {
  clearSecurityMode(ctx.tenantId, ctx.sessionId)
  db.close()
  vi.restoreAllMocks()
  if (path.dirname(path.resolve(root)) !== fixtures || !path.basename(root).startsWith('pptx-recovery-')) throw new Error('Unsafe fixture cleanup')
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
  vi.unstubAllEnvs()
})

describe('Work PPT failure recovery', () => {
  it('explains an unknown table field without silently stripping it or publishing a partial deck', async () => {
    const table = { headers: ['项目', '说明'], rows: [['2048', '规则说明']], rows_note: null }
    const input = { operation: 'create', path: 'invalid.pptx', expectedHash: 'missing', presentation: { slides: [
      { title: '项目说明', layout: 'custom', elements: [{ type: 'table', x: 0.8, y: 2, w: 8, h: 3, table }] },
    ] } }
    const failed = await officeDocumentTool.execute(input, ctx)
    expect(failed).toMatchObject({ success: false, error: 'OFFICE_INVALID_ARGUMENTS', metadata: { fileMutationApplied: false } })
    const diagnostic = JSON.parse(failed.output)
    expect(diagnostic.message).toContain('presentation.slides.0.elements.0.table')
    expect(diagnostic.message).toContain('rows_note')
    expect(diagnostic.message).toContain('headers, rows, colWidths')
    expect(diagnostic.message).toContain('presentation.slides.0.notes')
    expect(table).toHaveProperty('rows_note', null)
    expect(fs.existsSync(path.join(root, input.path))).toBe(false)
    expect(await store.list(ctx.tenantId, ctx.sessionId)).toHaveLength(0)
  })

  it('reports both production table failures in one receipt and preserves all cells after height-only repair', async () => {
    const controls = { type: 'table' as const, x: 0.8, y: 2.05, w: 6.3, h: 3.5, table: {
      headers: ['操作', '键盘', '触屏 / 鼠标'],
      rows: [['移动', '↑ ↓ ← → 或 W A S D', '在棋盘上朝任意方向滑动'], ['悔棋', 'Z', '点「悔棋」'], ['新游戏', 'R', '点「新游戏」'], ['静音', 'M', '点「音效」'], ['换主题', 'T', '点主题色板']],
      colWidths: [1.3, 2.5, 2.5],
    } }
    const quality = { type: 'table' as const, x: 0.8, y: 3.55, w: 11.7, h: 2.3, table: {
      headers: ['层级', '方式', '覆盖'],
      rows: [['规则与状态', 'node:test 直接跑，无需浏览器', '滑动合并边界、四个方向、无变化回滚、判死、悔棋、存档往返与损坏容错'],
        ['端到端', '无头 Chrome + CDP 驱动真实页面', '开局渲染、计分、胜负面板、刷新恢复、手机竖屏不溢出、四套主题与主题记忆、重开确认'],
        ['视觉', '按主题与手机尺寸截图，不做断言', '四套主题桌面图 + 四种手机尺寸，供人工看图']], colWidths: [1.8, 3.6, 6.3],
    } }
    const presentation: PptxInput = { slides: Array.from({ length: 7 }, (_, i) => ({ title: `保留第 ${i + 1} 页` })) }
    presentation.slides[2] = { title: '控制方式', layout: 'custom', elements: [controls] }
    presentation.slides[6] = { title: '质量现状', layout: 'custom', elements: [quality] }
    const input = { operation: 'create', path: 'repaired.pptx', expectedHash: 'missing', presentation }
    const before = structuredClone(input)
    const failed = await officeDocumentTool.execute(input, ctx)
    expect(failed).toMatchObject({ success: false, error: 'OFFICE_FORMAT_FAILED', metadata: { fileMutationApplied: false } })
    const diagnostic = JSON.parse(failed.output)
    expect(diagnostic.message).toContain('presentation.slides.2.elements.0.table')
    expect(diagnostic.message).toContain('presentation.slides.6.elements.0.table')
    expect(diagnostic.message).toContain('3.754')
    expect(diagnostic.message).toContain('3.142')
    expect(input).toEqual(before)
    expect(fs.existsSync(path.join(root, input.path))).toBe(false)
    expect(await store.list(ctx.tenantId, ctx.sessionId)).toHaveLength(0)

    controls.h = 3.754
    quality.h = 3.142
    const created = await officeDocumentTool.execute(input, ctx)
    expect(created).toMatchObject({ success: true, metadata: { format: 'pptx', fileMutationApplied: true, visualValidation: 'not-performed' } })
    const parts = readOfficeZip(fs.readFileSync(path.join(root, input.path)))
    for (const [number, table] of [[3, controls.table], [7, quality.table]] as const) {
      const xml = Buffer.from(parts[`ppt/slides/slide${number}.xml`]).toString('utf8')
      expect(xml).toContain('<a:tbl>')
      expect(xml.match(/<a:tr /g)).toHaveLength(table.rows.length + 1)
      for (const row of [table.headers, ...table.rows]) for (const cell of row) expect(xml).toContain(cell)
      expect(xml).toContain('sz="1700"')
    }
    expect(await store.list(ctx.tenantId, ctx.sessionId)).toHaveLength(1)
  })
})
