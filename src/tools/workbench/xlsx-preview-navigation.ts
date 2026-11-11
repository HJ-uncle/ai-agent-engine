import { createHash } from 'node:crypto'
import { z } from 'zod'
import { browserExecutionIdentity, type BrowserExecutionContext } from '../../core/browser-execution.js'

const pageNumber = z.number().int().min(1).max(100)
const regionBase = { sheet: z.number().int().min(1).max(24), name: z.string().min(1).max(128) }
const regionSchema = z.discriminatedUnion('kind', [
  z.object({ ...regionBase, kind: z.literal('cells'), range: z.string().regex(/^[A-Z]{1,3}[1-9]\d{0,4}:[A-Z]{1,3}[1-9]\d{0,4}$/) }).strict(),
  z.object({ ...regionBase, kind: z.literal('chart'), title: z.string().max(512) }).strict(),
])
const navigationSchema = z.object({ sheets: z.array(z.object({ ...regionBase, firstPage: pageNumber, lastPage: pageNumber,
  chartPages: z.array(pageNumber).max(96) }).strict()).min(1).max(24) }).strict()
export type XlsxPreviewRegion = z.infer<typeof regionSchema>
export type XlsxPreviewNavigation = z.infer<typeof navigationSchema>
export interface XlsxPreviewMetadata { currentRegion: XlsxPreviewRegion; navigation: XlsxPreviewNavigation }

/** Optional for older clients. New directories must cover every region once;
 * charts are emitted after the cell regions of their own worksheet. */
export function validateXlsxPreviewMetadata(value: Record<string, unknown>, page: number, pageCount: number): XlsxPreviewMetadata | undefined {
  if (value.currentRegion === undefined && value.navigation === undefined) return undefined
  const currentRegion = regionSchema.parse(value.currentRegion), navigation = navigationSchema.parse(value.navigation)
  let nextPage = 1
  for (const [index, sheet] of navigation.sheets.entries()) {
    if (sheet.sheet !== index + 1 || sheet.firstPage !== nextPage || sheet.lastPage < sheet.firstPage || sheet.lastPage > pageCount ||
      sheet.chartPages.some((number, chart) => number !== sheet.lastPage - sheet.chartPages.length + chart + 1 || number <= sheet.firstPage))
      throw new Error('XLSX 预览目录与区域编号不一致。')
    nextPage = sheet.lastPage + 1
  }
  const sheet = navigation.sheets[currentRegion.sheet - 1]
  if (nextPage !== pageCount + 1 || !sheet || sheet.name !== currentRegion.name || page < sheet.firstPage || page > sheet.lastPage ||
    sheet.chartPages.includes(page) !== (currentRegion.kind === 'chart')) throw new Error('XLSX 当前区域与工作表目录不一致。')
  return { currentRegion, navigation }
}

export class XlsxNavigationDeliveryTracker {
  private readonly delivered = new Set<string>()
  include(ctx: BrowserExecutionContext, hash: string, navigation: XlsxPreviewNavigation, requested?: boolean): boolean {
    if (requested === false) return false
    const execution = browserExecutionIdentity(ctx)
    // Without an authenticated run identity, do not hide a directory on the
    // assumption that an earlier request belongs to the same model context.
    if (!execution) return true
    const key = createHash('sha256').update(JSON.stringify([ctx.tenantId ?? 'default', ctx.browserPrincipal?.userId ?? null,
      ctx.sessionId, execution.rootSessionId, execution.rootRunId, execution.ownerRunId, hash, navigation])).digest('hex')
    const first = !this.delivered.has(key)
    this.delivered.delete(key); this.delivered.add(key)
    if (this.delivered.size > 256) this.delivered.delete(this.delivered.values().next().value!)
    return requested === true || first
  }
}
export const xlsxNavigationDelivery = new XlsxNavigationDeliveryTracker()

const rangeText = (first: number, last: number): string => first === last ? String(first) : `${first}–${last}`
function label(text: string, maximum: number): string {
  const clean = text.replace(/[\u0000-\u001f\u007f]/g, ' ')
  return clean.length <= maximum ? clean : clean.slice(0, Math.max(0, maximum - 1)) + '…'
}

/** Provider image adapters keep only the first 1024 description characters.
 * Reserve the fidelity boundary, then shorten labels explicitly, never drop a
 * worksheet or a chart region to make the directory appear complete. */
export function xlsxPreviewDescription(metadata: XlsxPreviewMetadata, page: number, pageCount: number, include: boolean): string {
  const region = metadata.currentRegion
  const current = `原始 XLSX 第 ${page}/${pageCount} 预览区域：表${region.sheet}「${label(region.name, 64)}」·${region.kind === 'cells' ? region.range : `图表「${label(region.title, 96)}」`}。`
  const boundary = 'Aether 960×540 内容分区，编号不是原生打印页码；非 Excel 原生渲染。目录只供定位，截图成功不代表验收通过；请检查布局、重叠、裁切和可读性。'
  if (!include) return `${current}${boundary}需要目录可传 includeNavigation=true。`
  const budget = 1024 - current.length - boundary.length
  const directory = (limit: number) => '目录（区域号；…为名称缩写）：' + metadata.navigation.sheets.map(sheet =>
    `${sheet.sheet}:${label(sheet.name, limit)}[${rangeText(sheet.firstPage, sheet.lastPage)}${sheet.chartPages.length ? `;图${rangeText(sheet.chartPages[0], sheet.chartPages.at(-1)!)}` : ''}]`).join('；') + '。'
  let limit = 128, compact = directory(limit)
  while (compact.length > budget && limit > 1) compact = directory(--limit)
  if (compact.length > budget) throw new Error('XLSX 预览目录超过文本预算，未省略工作表。')
  return current + compact + boundary
}
