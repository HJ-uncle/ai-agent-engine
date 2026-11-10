import { z } from 'zod'

const color = z.string().regex(/^[0-9a-fA-F]{6}$/, 'Use six hexadecimal digits without #')
const short = z.string().min(1).max(100)
const assetPath = z.string().min(1).max(4096).refine(value => !value.includes('\0') && !/^[a-z][a-z\d+.-]*:/i.test(value.replace(/^[a-z]:[\\/]/i, '')), 'Use a local workspace image path')
const fit = z.enum(['contain', 'cover'])
const box = { x: z.number().finite().min(0), y: z.number().finite().min(0), w: z.number().finite().positive(), h: z.number().finite().positive() }
const table = z.object({ headers: z.array(short).min(1).max(6), rows: z.array(z.array(z.union([z.string().max(100), z.number().finite()])).min(1).max(6)).max(8), colWidths: z.array(z.number().finite().positive().max(100)).min(1).max(6).optional() }).strict()
const image = z.object({ path: assetPath, fit: fit.optional(), caption: z.string().max(180).optional() }).strict()
const chart = z.object({ type: z.enum(['bar', 'line', 'pie']), categories: z.array(z.string().min(1).max(40)).min(1).max(12), series: z.array(z.object({ name: z.string().min(1).max(60), values: z.array(z.number().finite()).min(1).max(12) }).strict()).min(1).max(4) }).strict()
const element = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), ...box, text: z.string().min(1).max(1500), fontSize: z.number().min(12).max(72).optional(), bold: z.boolean().optional(), color: color.optional(), align: z.enum(['left', 'center', 'right']).optional() }).strict(),
  z.object({ type: z.literal('shape'), ...box, shape: z.enum(['rect', 'ellipse', 'line']), fill: color.optional(), line: color.optional() }).strict(),
  z.object({ type: z.literal('image'), ...box, path: assetPath, fit: fit.optional() }).strict(),
  z.object({ type: z.literal('chart'), ...box, chart }).strict(),
  z.object({ type: z.literal('table'), ...box, table }).strict(),
])
export const presentationSchema = z.object({
  theme: z.object({ background: color.optional(), foreground: color.optional(), accent: color.optional(), muted: color.optional(), fontFace: z.string().min(1).max(80).optional(), footer: z.string().max(100).optional(), pageNumbers: z.boolean().optional() }).strict().optional(),
  slides: z.array(z.object({
    title: short, background: color.optional(), layout: z.enum(['auto', 'cover', 'section', 'bullets', 'columns', 'image', 'chart', 'table', 'quote', 'timeline', 'custom']).optional(),
    subtitle: z.string().max(240).optional(), bullets: z.array(z.string().min(1).max(160)).max(6).optional(), table: table.optional(),
    columns: z.array(z.object({ title: short, body: z.string().min(1).max(500) }).strict()).min(2).max(3).optional(),
    image: image.optional(), chart: chart.optional(), quote: z.object({ text: z.string().min(1).max(500), attribution: short.optional() }).strict().optional(),
    steps: z.array(z.object({ title: short, body: z.string().max(160).optional() }).strict()).min(2).max(5).optional(),
    elements: z.array(element).min(1).max(30).optional(), notes: z.string().max(4000).optional(),
  }).strict()).min(1).max(40),
}).strict()
export type PresentationDesign = z.infer<typeof presentationSchema>
export type PptxSlide = PresentationDesign['slides'][number]
export type PptxInput = PresentationDesign & { title?: string; author?: string }

// Keep the tool description compact: one schema describes the only generation
// path; there is no parallel legacy/quick template for the model to choose.
type JsonSchema = Record<string, unknown>
const s = (maxLength: number, minLength = 0): JsonSchema => ({ type: 'string', minLength, maxLength })
const a = (items: JsonSchema, maxItems: number, minItems = 0): JsonSchema => ({ type: 'array', items, minItems, maxItems })
const o = (properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema => ({ type: 'object', additionalProperties: false, properties, required })
const c: JsonSchema = { type: 'string', pattern: '^[0-9a-fA-F]{6}$' }
const f: JsonSchema = { type: 'string', enum: ['contain', 'cover'] }
const geometry = { x: { type: 'number', minimum: 0 }, y: { type: 'number', minimum: 0 }, w: { type: 'number', exclusiveMinimum: 0 }, h: { type: 'number', exclusiveMinimum: 0 } }
const tableJsonSchema = { ...o({ headers: a(s(100, 1), 6, 1), rows: a(a({ anyOf: [s(100), { type: 'number' }] }, 6, 1), 8), colWidths: { ...a({ type: 'number', exclusiveMinimum: 0, maximum: 100 }, 6, 1), description: 'Optional relative column widths, one per header.' } }, ['headers', 'rows']), description: 'Native editable table, 17pt. Minimum height is 0.58 inches per row INCLUDING header; wrapped cells need more. In custom, reserve sufficient h. On overflow use reported required height and exact field paths; do not shrink h or drop data to bypass overflow. Notes belong to slide.notes, not table.' }
const chartJsonSchema = o({ type: { type: 'string', enum: ['bar', 'line', 'pie'] }, categories: { ...a(s(40, 1), 12, 1), description: 'Short labels: at most 24 Latin-width units each (CJK characters count as 2).' }, series: a(o({ name: s(60, 1), values: a({ type: 'number' }, 12, 1) }, ['name', 'values']), 4, 1) }, ['type', 'categories', 'series'])
export const presentationJsonSchema: JsonSchema = {
  ...o({
    theme: o({ background: c, foreground: c, accent: c, muted: c, fontFace: s(80, 1), footer: s(100), pageNumbers: { type: 'boolean' } }),
    slides: a(o({
      title: s(100, 1), background: c, layout: { type: 'string', enum: ['auto', 'cover', 'section', 'bullets', 'columns', 'image', 'chart', 'table', 'quote', 'timeline', 'custom'] },
      subtitle: s(240), bullets: a(s(160, 1), 6),
      table: tableJsonSchema,
      columns: a(o({ title: s(100, 1), body: s(500, 1) }, ['title', 'body']), 3, 2),
      image: o({ path: s(4096, 1), fit: f, caption: s(180) }, ['path']),
      chart: chartJsonSchema,
      quote: o({ text: s(500, 1), attribution: s(100, 1) }, ['text']),
      steps: a(o({ title: s(100, 1), body: s(160) }, ['title']), 5, 2),
      elements: { ...a({ anyOf: [
        o({ type: { const: 'text' }, ...geometry, text: s(1500, 1), fontSize: { type: 'number', minimum: 12, maximum: 72 }, bold: { type: 'boolean' }, color: c, align: { type: 'string', enum: ['left', 'center', 'right'] } }, ['type', 'x', 'y', 'w', 'h', 'text']),
        o({ type: { const: 'shape' }, ...geometry, shape: { type: 'string', enum: ['rect', 'ellipse', 'line'] }, fill: c, line: c }, ['type', 'x', 'y', 'w', 'h', 'shape']),
        o({ type: { const: 'image' }, ...geometry, path: s(4096, 1), fit: f }, ['type', 'x', 'y', 'w', 'h', 'path']),
        o({ type: { const: 'chart' }, ...geometry, chart: chartJsonSchema }, ['type', 'x', 'y', 'w', 'h', 'chart']),
        o({ type: { const: 'table' }, ...geometry, table: tableJsonSchema }, ['type', 'x', 'y', 'w', 'h', 'table']),
      ] }, 30, 1), description: 'custom only. Absolute inches on a 13.333 × 7.5 slide; title is metadata. Combine text, images and editable chart/table objects. No automatic title/footer. Keep boxes on canvas.' },
      notes: s(4000),
    }, ['title']), 40, 1),
  }, ['slides']),
  description: 'PPTX create. Content-driven layouts; auto selects from fields. Select one main content field (bullets may accompany table only). Images use authorized workspace PNG/JPEG paths. Chart/table remain native editable objects. Colors: 6-digit HEX. No default branding/footer. Split dense pages; incompatible fields and overflowing text are rejected.',
}
