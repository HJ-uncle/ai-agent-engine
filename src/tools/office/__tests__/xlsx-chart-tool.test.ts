/** New chart API acceptance: actual tool publication/version protection and
 * recalculation refresh of native chart data, including missing formula caches. */
import fs from 'node:fs'
import path from 'node:path'
import { createClient, type Client } from '@libsql/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentContext } from '../../../core/agent-context/index.js'
import { hashFileContent } from '../../../shared/file-version.js'
import * as database from '../../../storage/sqlite/db.js'
import { clearSecurityMode, setSecurityMode } from '../../../security/policy-engine.js'
import { officeDocumentTool } from '../index.js'
import { createXlsx, type XlsxInput } from '../xlsx.js'
import { readOfficeZip, writeOfficeZip } from '../office-zip.js'
import { recalculateXlsx } from '../recalculate.js'
import { xlsxChartSchema } from '../xlsx-chart-schema.js'

const tempRoot = path.resolve('.e2e-tmp')
let root: string, db: Client, ctx: AgentContext
beforeEach(() => {
  fs.mkdirSync(tempRoot, { recursive: true }); root = fs.mkdtempSync(path.join(tempRoot, 'xlsx-chart-tool-'))
  vi.stubEnv('AUTH_ENABLED', 'false'); vi.stubEnv('DATA_DIR', path.join(root, 'agent.db'))
  db = createClient({ url: 'file::memory:' }); vi.spyOn(database, 'getDb').mockReturnValue(db)
  ctx = { tenantId: 'chart-test', sessionId: path.basename(root), rootSessionId: path.basename(root), rootRunId: 'chart-run', turnId: 'chart-turn',
    workspacePaths: [root], projectRoot: root, cwd: root, scratchDir: path.join(root, 'scratch'),
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } } as unknown as AgentContext
  setSecurityMode(ctx.tenantId, ctx.sessionId, 'safe')
})
afterEach(() => {
  clearSecurityMode(ctx.tenantId, ctx.sessionId); db.close(); vi.restoreAllMocks(); vi.unstubAllEnvs()
  if (path.dirname(path.resolve(root)) !== tempRoot || !path.basename(root).startsWith('xlsx-chart-tool-')) throw new Error('Unsafe fixture cleanup')
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})
const input = (name = '数据'): XlsxInput => ({ sheets: [{ name, columns: [{ header: '项目', key: 'item' }, { header: '原值', key: 'base', type: 'number' }, { header: '结果', key: 'value', type: 'number' }],
  rows: [{ item: '甲', base: 5, value: { formula: 'B2*2' } }, { item: '乙', base: 8, value: { formula: 'B3*2' } }],
  charts: [{ type: 'column', title: '结果比较', categoryKey: 'item', series: [{ key: 'value' }] }],
}] })
const chart = (bytes: Buffer): string => {
  const entries = readOfficeZip(bytes), file = Object.keys(entries).find(file => /^xl\/charts\/[^/]+\.xml$/.test(file))!
  return Buffer.from(entries[file]).toString()
}

describe('chart tool and recalculation integration', () => {
  it('publishes real native charts through the model contract and retains version protection on append', async () => {
    const created = await officeDocumentTool.execute({ operation: 'create', path: 'report.xlsx', expectedHash: 'missing', workbook: input() }, ctx)
    expect(created.success, created.output).toBe(true)
    const file = path.join(root, 'report.xlsx'), original = fs.readFileSync(file)
    expect(chart(original)).toContain('<c:barChart>')
    const inspected = await officeDocumentTool.execute({ operation: 'inspect', path: 'report.xlsx' }, ctx)
    expect(inspected.success, inspected.output).toBe(true)
    expect(JSON.parse(inspected.output).summary.charts).toBe(1)
    const appended = await officeDocumentTool.execute({ operation: 'append_sheets', path: 'report.xlsx', expectedHash: hashFileContent(original), workbook: input('追加') }, ctx)
    expect(appended.success, appended.output).toBe(true)
    const after = fs.readFileSync(file)
    expect(Object.keys(readOfficeZip(after)).filter(name => /^xl\/charts\/[^/]+\.xml$/.test(name))).toHaveLength(2)
    const stale = await officeDocumentTool.execute({ operation: 'append_sheets', path: 'report.xlsx', expectedHash: hashFileContent(original), workbook: input('过期') }, ctx)
    expect(stale).toMatchObject({ success: false, error: 'OFFICE_VERSION_CONFLICT' })
    expect(fs.readFileSync(file)).toEqual(after)
  })

  it('recalculates referenced formulas before refreshing chart caches without replacing chart configuration', async () => {
    const original = await createXlsx(input()), before = chart(original)
    expect(before).toContain('<c:ptCount val="2"/>')
    expect(before).not.toContain('<c:v>10</c:v>')
    const result = await recalculateXlsx(original), actual = chart(result)
    expect(actual).toContain('<c:pt idx="0"><c:v>10</c:v></c:pt>')
    expect(actual).toContain('<c:pt idx="1"><c:v>16</c:v></c:pt>')
    expect(actual).toContain('<c:title>'); expect(actual).toContain('<c:barChart>')
    const source = readOfficeZip(original), changed = readOfficeZip(result)
    for (const file of Object.keys(source).filter(file => !/^xl\/(?:worksheets|charts)\//.test(file))) expect(changed[file]).toEqual(source[file])
  })

  it('refreshes a stale ordinary chart cache even if a workbook contains no formulas', async () => {
    const source = input(); source.sheets[0].rows = [{ item: '甲', base: 5, value: 42 }]
    const entries = readOfficeZip(await createXlsx(source)), file = Object.keys(entries).find(name => /^xl\/charts\/[^/]+\.xml$/.test(name))!
    entries[file] = Buffer.from(Buffer.from(entries[file]).toString().replace('<c:v>42</c:v>', '<c:v>999</c:v>'))
    const result = chart(await recalculateXlsx(writeOfficeZip(entries)))
    expect(result).toContain('<c:v>42</c:v>'); expect(result).not.toContain('<c:v>999</c:v>')
  })

  it('rejects unknown chart keys before writing a file and bounds the advertised schema', async () => {
    const source = input(); source.sheets[0].charts![0].categoryKey = 'absent'
    const result = await officeDocumentTool.execute({ operation: 'create', path: 'invalid.xlsx', expectedHash: 'missing', workbook: source }, ctx)
    expect(result.success).toBe(false); expect(fs.existsSync(path.join(root, 'invalid.xlsx'))).toBe(false)
    expect(xlsxChartSchema.safeParse({ type: 'pie', categoryKey: 'a', series: [{ key: 'b' }, { key: 'c' }] }).success).toBe(false)
    expect(xlsxChartSchema.safeParse({ type: 'line', categoryKey: 'a', series: [{ key: 'b' }], startRow: 2, endRow: 1002 }).success).toBe(false)
    const workbook = officeDocumentTool.parameters.properties!.workbook as { properties: { sheets: { items: { properties: Record<string, unknown> } } } }
    expect(workbook.properties.sheets.items.properties.charts).toMatchObject({ type: 'array', maxItems: 8 })
  })
})
