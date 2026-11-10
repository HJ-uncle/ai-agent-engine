import { z } from 'zod'
import { XLSX_CHART_TYPES } from './xlsx-charts.js'

export const xlsxChartSchema = z.object({
  type: z.enum(XLSX_CHART_TYPES),
  title: z.string().max(200).optional(),
  categoryKey: z.string().min(1).max(128),
  series: z.array(z.object({ key: z.string().min(1).max(128), name: z.string().max(200).optional(), color: z.string().regex(/^[a-f0-9]{6}$/i).optional() }).strict()).min(1).max(8),
  startRow: z.number().int().min(2).max(10001).optional(),
  endRow: z.number().int().min(2).max(10001).optional(),
  anchor: z.object({ cell: z.string().regex(/^[A-Z]{1,3}[1-9]\d{0,6}$/i), width: z.number().min(320).max(1600).optional(), height: z.number().min(240).max(1200).optional() }).strict().optional(),
  legend: z.boolean().optional(),
}).strict().superRefine((chart, ctx) => {
  if ((chart.type === 'pie' || chart.type === 'doughnut') && chart.series.length !== 1)
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['series'], message: 'Pie/doughnut charts require one series' })
  if (chart.startRow !== undefined && chart.endRow !== undefined && (chart.endRow < chart.startRow || chart.endRow - chart.startRow >= 1000))
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['endRow'], message: 'Use an ordered data range of at most 1000 points' })
})

export const xlsxChartJsonSchema = {
  type: 'object', additionalProperties: false,
  description: '原生可编辑图表，引用本表列key，不重复提供数据。每图最多1000点；默认覆盖全部数据行并放在表格右侧。饼/环仅单系列且无负值，scatter分类列为数值X坐标。',
  properties: {
    type: { type: 'string', enum: [...XLSX_CHART_TYPES] },
    title: { type: 'string', maxLength: 200 }, categoryKey: { type: 'string', minLength: 1, maxLength: 128 },
    series: { type: 'array', minItems: 1, maxItems: 8, items: { type: 'object', additionalProperties: false,
      properties: { key: { type: 'string', minLength: 1, maxLength: 128 }, name: { type: 'string', maxLength: 200 }, color: { type: 'string', pattern: '^[a-fA-F0-9]{6}$' } }, required: ['key'] } },
    startRow: { type: 'integer', minimum: 2, maximum: 10001, description: 'Excel实际行号，默认2；第1行为列头。' },
    endRow: { type: 'integer', minimum: 2, maximum: 10001, description: '含此行，默认最后一条数据行。' },
    anchor: { type: 'object', additionalProperties: false, properties: { cell: { type: 'string', pattern: '^[A-Za-z]{1,3}[1-9][0-9]{0,6}$' },
      width: { type: 'number', minimum: 320, maximum: 1600 }, height: { type: 'number', minimum: 240, maximum: 1200 } }, required: ['cell'] },
    legend: { type: 'boolean' },
  }, required: ['type', 'categoryKey', 'series'],
}
