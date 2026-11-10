import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import type { AgentContext, Tool, ToolResult } from '../../core/agent-context/index.js'
import { throwIfAborted } from '../../core/utils/abort.js'
import { boundedToolContext, getToolOutputLimit } from '../../core/agent-loop/tool-output-limit.js'
import { canonicalFilePathSync, hashFileContent, readFileVersionSync, withFileLocks } from '../../shared/file-version.js'
import { workspaceManager } from '../../workspace/index.js'
import { ChangeRecordingError, commitWriteChange, discardUnpublishedSnapshot, readOldSnapshot, type ChangeSnapshot } from '../file/change-recorder.js'
import { createDocx, editDocx, inspectDocx } from './docx.js'
import { createXlsx, editXlsx, inspectXlsx, appendXlsxSheets } from './xlsx.js'
import { createPdf, inspectPdf } from './pdf.js'
import { createPptx, editPptx, inspectPptx, type PptxEdit } from './pptx.js'
import { presentationSchema as presentation, presentationJsonSchema, type PptxInput } from './pptx-schema.js'
import { pptxImagePaths, inspectPptxImage, MAX_PPTX_IMAGE_BYTES, MAX_PPTX_ASSET_BYTES } from './pptx-design.js'
import { recalculateXlsx } from './recalculate.js'
import { MAX_OFFICE_FILE_BYTES } from './office-zip.js'
import { officeFailure, officeReceipt, type OfficeInspection } from './output.js'

const text = z.string().max(32_000)
const formula = z.object({ formula: z.string().min(1).max(2000) }).strict()
const cell = z.union([text, z.number().finite(), z.boolean(), z.null(), formula])
const textEdits = z.array(z.object({ oldText: z.string().min(1).max(32_000), newText: text,
  slide: z.number().int().min(1).max(40).optional(), textRun: z.number().int().min(1).max(100_000).optional(),
  target: z.literal('notes').optional(),
}).strict().refine(edit => (edit.slide === undefined) === (edit.textRun === undefined), 'slide and textRun must be supplied together')
  .refine(edit => edit.target !== 'notes' || edit.slide !== undefined, 'notes requires slide and textRun')).min(1).max(100)
const cellEdits = z.array(z.object({ sheet: z.string().min(1).max(31), cell: z.string().regex(/^[A-Z]{1,3}[1-9]\d{0,6}$/), value: cell }).strict()).min(1).max(1000)
const workbook = z.object({ sheets: z.array(z.object({
  name: z.string().min(1).max(31),
  columns: z.array(z.object({ header: z.string().min(1).max(255), key: z.string().min(1).max(128),
    type: z.enum(['text', 'number', 'date', 'percent']).optional(), width: z.number().min(8).max(80).optional() }).strict()).min(1).max(100),
  rows: z.array(z.record(z.string().min(1).max(128), cell)).max(10_000),
}).strict()).min(1).max(12) }).strict().superRefine((value, ctx) => {
  let count = 0
  const names = new Set<string>()
  value.sheets.forEach((sheet, sheetIndex) => {
    if (names.has(sheet.name.toLowerCase())) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['sheets', sheetIndex, 'name'], message: 'Sheet names must be unique' })
    names.add(sheet.name.toLowerCase())
    const keys = new Set(sheet.columns.map(column => column.key))
    if (keys.size !== sheet.columns.length) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['sheets', sheetIndex, 'columns'], message: 'Column keys must be unique' })
    for (const [rowIndex, row] of sheet.rows.entries()) {
      count += sheet.columns.length
      if (Object.keys(row).some(key => !keys.has(key))) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['sheets', sheetIndex, 'rows', rowIndex], message: 'Row contains a key absent from columns' })
    }
  })
  if (count > 100_000) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Workbook supports at most 100000 data cells' })
})
const filePath = z.string().min(1).max(4096).refine(value => value.trim().length > 0 && !value.includes('\0'), 'Invalid file path')
// DOCX allows 2 Mi characters of paragraph text plus separators; the package's
// 500000-element bound keeps their combined preview below 3 Mi UTF-16 units.
const maxContentOffset = 3 * 1024 * 1024
const inspectArguments = z.object({ operation: z.literal('inspect'), path: filePath,
  expectedHash: z.string().regex(/^sha256:[a-f0-9]{64}$/).optional(),
  contentOffset: z.number().int().min(0).max(maxContentOffset).optional(),
  contentLimit: z.number().int().min(2).max(32_000).optional(),
}).strict()
const readonlyInspectArguments = inspectArguments.omit({ operation: true })
const readonlyInspectBatchArguments = z.object({ files: z.array(readonlyInspectArguments).min(1).max(16) }).strict()
const readonlyInspectInput = z.union([readonlyInspectArguments, readonlyInspectBatchArguments])
const createArguments = z.object({ operation: z.literal('create'), path: filePath, expectedHash: z.literal('missing'),
  markdown: z.string().min(1).max(300_000).optional(), title: z.string().max(256).optional(), author: z.string().max(200).optional(), workbook: workbook.optional(), presentation: presentation.optional() }).strict()
const editArguments = z.object({ operation: z.literal('edit'), path: filePath, expectedHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  edits: z.union([textEdits, cellEdits]) }).strict()
const appendSheetsArguments = z.object({ operation: z.literal('append_sheets'), path: filePath,
  expectedHash: z.string().regex(/^sha256:[a-f0-9]{64}$/), workbook: workbook.refine(value => value.sheets.length <= 4, 'Append at most four sheets per call') }).strict()
const recalculateArguments = z.object({ operation: z.literal('recalculate'), path: filePath,
  expectedHash: z.string().regex(/^sha256:[a-f0-9]{64}$/) }).strict()
const argumentsSchema = z.discriminatedUnion('operation', [inspectArguments, createArguments, editArguments, appendSheetsArguments, recalculateArguments])
type Arguments = z.infer<typeof argumentsSchema>
type Inspection = OfficeInspection

function samePath(left: string, right: string): boolean {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
}
function boundedInput(value: unknown): boolean {
  let remainingBytes = 2 * 1024 * 1024, remainingValues = 220_000
  const seen = new WeakSet<object>()
  const visit = (item: unknown, depth: number): boolean => {
    if (--remainingValues < 0 || depth > 10) return false
    if (typeof item === 'string') { remainingBytes -= Buffer.byteLength(item, 'utf8'); return remainingBytes >= 0 }
    if (!item || typeof item !== 'object') return true
    if (seen.has(item)) return false
    seen.add(item)
    if (Array.isArray(item)) {
      if (item.length > 10_000) return false
      for (const entry of item) if (!visit(entry, depth + 1)) return false
    } else {
      for (const key in item) {
        if (!Object.hasOwn(item, key)) continue
        if (!visit(key, depth + 1) || !visit((item as Record<string, unknown>)[key], depth + 1)) return false
      }
    }
    return true
  }
  return visit(value, 0)
}
function readBoundedVersion(file: string) {
  try {
    const stat = fs.statSync(file)
    if (!stat.isFile()) throw new Error('Office document requires a regular file')
    if (stat.size > MAX_OFFICE_FILE_BYTES) throw new Error('Office document exceeds 32 MiB')
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  const version = readFileVersionSync(file)
  if (version.content && version.content.byteLength > MAX_OFFICE_FILE_BYTES) throw new Error('Office document exceeds 32 MiB')
  return version
}
function readPptxAssets(ctx: AgentContext, presentation: Pick<PptxInput, 'slides'>): Map<string, Buffer> {
  const assets = new Map<string, Buffer>()
  let total = 0
  for (const assetPath of pptxImagePaths(presentation)) {
    throwIfAborted(ctx.signal)
    const requested = workspaceManager.resolveSafePath(ctx, assetPath)
    const canonical = canonicalFilePathSync(requested)
    workspaceManager.resolveSafePath(ctx, canonical)
    const descriptor = fs.openSync(canonical, 'r')
    try {
      const stat = fs.fstatSync(descriptor)
      if (!stat.isFile() || !stat.size || stat.size > MAX_PPTX_IMAGE_BYTES) throw new Error('PPTX images require regular nonempty PNG/JPEG files up to 8 MiB')
      const checkPath = () => {
        const current = canonicalFilePathSync(workspaceManager.resolveSafePath(ctx, assetPath))
        workspaceManager.resolveSafePath(ctx, current)
        const currentStat = fs.statSync(current)
        if (!samePath(current, canonical) || currentStat.dev !== stat.dev || currentStat.ino !== stat.ino) throw new Error('PPTX image path changed during authorized read')
      }
      checkPath()
      // Bound the actual descriptor read as well as stat: an external writer
      // must not turn an approved small asset into an unbounded allocation.
      const buffer = Buffer.alloc(stat.size + 1)
      let length = 0
      while (length < buffer.length) {
        const count = fs.readSync(descriptor, buffer, length, buffer.length - length, length)
        if (!count) break
        length += count
      }
      const after = fs.fstatSync(descriptor)
      if (length !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) throw new Error('PPTX image changed during read; retry with a stable image')
      checkPath()
      const bytes = buffer.subarray(0, length)
      inspectPptxImage(bytes)
      total += bytes.length
      if (total > MAX_PPTX_ASSET_BYTES) throw new Error('PPTX images exceed 24 MiB in total')
      assets.set(assetPath, bytes)
    } finally { fs.closeSync(descriptor) }
  }
  return assets
}
function inspect(format: OfficeInspection['format'], bytes: Buffer): Promise<Inspection> {
  if (format === 'docx') return inspectDocx(bytes)
  if (format === 'xlsx') return inspectXlsx(bytes)
  return format === 'pdf' ? inspectPdf(bytes) : inspectPptx(bytes)
}

export const officeDocumentTool: Tool = {
  name: 'office_document', displayName: '办公文档',
  description: '原生创建/检查DOCX/XLSX/PPTX/PDF，无需WPS/COM/Python/shell/pip；先读aether-office技能。create：Word/PDF用markdown，PPTX用presentation.slides，Excel用workbook。edit必须用edits数组：Word/PPTX每项唯一oldText/newText，Excel每项sheet/cell/value。DOCX仅替换现有段落文字，不能用换行插段落或表行；结构新增用create新修订文件，保留原稿。PPTX可按inspect位置缩小匹配范围。PDF改版须新建，独立排版不等于Word/PPT转换。append_sheets保留旧表部件。recalculate仅XLSX，计算支持的常用公式/跨表引用并更新缓存；不支持、循环或外链拒绝且保留原文件，非全Excel兼容。公式例{formula:"SUM(B2:B4)"}。inspect返回文字/表格预览、warnings、expectedHash；Excel限2000格/格600字符，Word仅正文；分页非全文或视觉验收。写入前版本检查、原子发布并记录撤回快照；结构检查不证明业务正确。',
  parameters: {
    type: 'object', additionalProperties: false,
    properties: {
      operation: { type: 'string', enum: ['inspect', 'create', 'edit', 'append_sheets', 'recalculate'] },
      path: { type: 'string', minLength: 1, maxLength: 4096, description: '工作区 .docx/.xlsx/.pptx/.pdf 路径；PDF仅create/inspect，recalculate仅xlsx。' },
      expectedHash: { type: 'string', pattern: '^(missing|sha256:[a-f0-9]{64})$', description: 'create填missing；其他写入复用同文件最新sha256。inspect首次可省，分页须上一页sha256防混读。' },
      contentOffset: { type: 'integer', minimum: 0, maximum: maxContentOffset, description: '仅inspect：上页contentPage.nextOffset（UTF-16位置），覆盖提取预览。' },
      contentLimit: { type: 'integer', minimum: 2, maximum: 32000, description: '仅inspect：本页字符上限，仍受输出预算限制。' },
      markdown: { type: 'string', minLength: 1, maxLength: 300000, description: 'Word/PDF create正文：支持标题、段落、列表、表格。' },
      title: { type: 'string', maxLength: 256, description: '仅 DOCX/PDF/PPTX create 可用，Excel 必须省略。可选独立可见标题及文档属性；避免与 Markdown 首标题重复。' }, author: { type: 'string', maxLength: 200, description: '仅 DOCX/PDF/PPTX create 可用，Excel 必须省略。' },
      presentation: presentationJsonSchema,
      workbook: { type: 'object', additionalProperties: false, description: 'Excel create 或 append_sheets 新表：columns.header 写第1行，rows 从第2行开始；要求精确单元格时用 edit 的 sheet/cell/value 定点校正、null清除多余单元格，再 recalculate/inspect，不重复创建文档。短表能完整输出时一次create；大表/新增表用append_sheets，每次1–4张，不重复提交已有表。', properties: { sheets: { type: 'array', minItems: 1, maxItems: 12,
        items: { type: 'object', additionalProperties: false, properties: {
          name: { type: 'string', minLength: 1, maxLength: 31 },
          columns: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'object', additionalProperties: false, properties: {
            header: { type: 'string', minLength: 1, maxLength: 255 }, key: { type: 'string', minLength: 1, maxLength: 128 },
            type: { type: 'string', enum: ['text', 'number', 'date', 'percent'] }, width: { type: 'number', minimum: 8, maximum: 80 },
          }, required: ['header', 'key'] } },
          rows: { type: 'array', maxItems: 10000, items: { type: 'object', additionalProperties: { anyOf: [
            { type: 'string', maxLength: 32000 }, { type: 'number' }, { type: 'boolean' }, { type: 'null' },
            { type: 'object', additionalProperties: false, properties: { formula: { type: 'string', minLength: 1, maxLength: 2000 } }, required: ['formula'] },
          ] } } },
        }, required: ['name', 'columns', 'rows'] } } }, required: ['sheets'] },
      edits: { type: 'array', minItems: 1, maxItems: 1000, items: { anyOf: [
        { type: 'object', additionalProperties: false, properties: { oldText: { type: 'string', minLength: 1, maxLength: 32000 }, newText: { type: 'string', maxLength: 32000 } }, required: ['oldText', 'newText'] },
        { type: 'object', additionalProperties: false, description: '仅PPTX：复用inspect的slide/textRun，oldText在该普通节点内唯一；字段不可编辑。省略target只改正文；备注须target=notes及定位。', properties: {
          oldText: { type: 'string', minLength: 1, maxLength: 10000 }, newText: { type: 'string', maxLength: 10000 },
          slide: { type: 'integer', minimum: 1, maximum: 40, description: '幻灯片显示顺序，从 1 开始，与 ZIP 文件名顺序无关。' },
          textRun: { type: 'integer', minimum: 1, maximum: 100000, description: '所选正文或备注内的inspect节点编号，各自从1开始，需editable=true。' },
          target: { type: 'string', enum: ['notes'], description: '编辑已有备注必填notes；仅替换节点文字，不新增备注/段落。' },
        }, required: ['oldText', 'newText', 'slide', 'textRun'] },
        { type: 'object', additionalProperties: false, properties: { sheet: { type: 'string', minLength: 1, maxLength: 31 }, cell: { type: 'string', pattern: '^[A-Z]{1,3}[1-9][0-9]{0,6}$' }, value: { anyOf: [
          { type: 'string', maxLength: 32000 }, { type: 'number' }, { type: 'boolean' }, { type: 'null' },
          { type: 'object', additionalProperties: false, properties: { formula: { type: 'string', minLength: 1, maxLength: 2000 } }, required: ['formula'] },
        ] } }, required: ['sheet', 'cell', 'value'] },
      ] } },
    }, required: ['operation', 'path'],
  },
  // This mixed read/write implementation must remain trusted serial in the
  // registry. A model-supplied operation never changes its scheduling authority.
  async execute(raw: unknown, ctx: AgentContext): Promise<ToolResult> {
    const outputLimit = getToolOutputLimit(ctx.toolProfile, ctx)
    const failure = (code: string, message: string, metadata: Record<string, unknown> = {}) => officeFailure(code, message, metadata, outputLimit)
    const outputFailure = (result: { code: string; requiredChars?: number }, inspection: Inspection) => failure(result.code,
      result.code === 'OFFICE_INVALID_CONTENT_OFFSET' ? 'Use a valid contentPage.nextOffset from the same file version; the offset is outside the preview or splits a Unicode character.'
        : 'The output budget cannot hold the complete path, version, summary, warnings and a progressing preview page. Increase TOOL_OUTPUT_MAX_CHARS; no document bytes were published.',
      { requiredOutputChars: result.requiredChars, outputLimit, warnings: inspection.warnings })
    if (!boundedInput(raw)) return failure('OFFICE_INPUT_TOO_LARGE', 'Office arguments must fit within 2 MiB of text, 220000 values and bounded nesting.')
    const parsed = argumentsSchema.safeParse(raw)
    if (!parsed.success) return failure('OFFICE_INVALID_ARGUMENTS', parsed.error.issues.slice(0, 5).map(issue => `${issue.path.join('.') || 'arguments'}: ${issue.message}`).join('; '))
    const args: Arguments = parsed.data
    if (args.operation === 'inspect' && (args.contentOffset ?? 0) > 0 && !args.expectedHash) return failure('OFFICE_INSPECT_VERSION_REQUIRED', 'Continue inspection with the previous page expectedHash so pages cannot mix file versions.')
    const extension = path.extname(args.path).toLowerCase()
    if (!['.docx', '.xlsx', '.pdf', '.pptx'].includes(extension)) return failure('OFFICE_UNSUPPORTED_FORMAT', 'Only real .docx/.xlsx/.pptx/.pdf files are supported.')
    const format = extension.slice(1) as OfficeInspection['format']
    if (args.operation === 'create') {
      const valid = format === 'docx' || format === 'pdf' ? !!args.markdown && !args.workbook && !args.presentation
        : format === 'pptx' ? !!args.presentation && !args.markdown && !args.workbook
        : !!args.workbook && !args.markdown && !args.presentation && args.title === undefined && args.author === undefined
      if (!valid) return failure('OFFICE_INVALID_ARGUMENTS', 'Word/PDF creation requires markdown; Excel requires workbook; PPTX requires presentation. Do not mix format inputs.')
    }
    if (args.operation === 'edit' && (format === 'pdf' || !args.edits.every(edit => format === 'xlsx' ? 'cell' in edit : 'oldText' in edit))) return failure('OFFICE_INVALID_ARGUMENTS', 'Word/PPTX edits require unique oldText/newText; Excel edits require sheet/cell/value. PDF text editing is not supported; create a new revision from its source content.')
    if (args.operation === 'edit' && format !== 'pptx' && args.edits.some(edit => 'slide' in edit || 'textRun' in edit || 'target' in edit)) return failure('OFFICE_INVALID_ARGUMENTS', 'target/slide/textRun selectors are only supported for PPTX; Word edits still require globally unique oldText/newText.')
    if (args.operation === 'append_sheets' && format !== 'xlsx') return failure('OFFICE_INVALID_ARGUMENTS', 'append_sheets only adds new worksheets to an existing .xlsx file.')
    if (args.operation === 'recalculate' && format !== 'xlsx') return failure('OFFICE_INVALID_ARGUMENTS', 'recalculate only supports .xlsx workbooks.')
    let published = false
    try {
      throwIfAborted(ctx.signal)
      const requested = workspaceManager.resolveSafePath(ctx, args.path)
      return await withFileLocks([requested], async ([canonical]) => {
        workspaceManager.resolveSafePath(ctx, canonical)
        throwIfAborted(ctx.signal)
        const original = readBoundedVersion(canonical)
        if (args.operation === 'inspect') {
          if (!original.content) return failure('OFFICE_FILE_MISSING', 'The document does not exist. Use create with expectedHash="missing" for a new document.')
          if (args.expectedHash && args.expectedHash !== original.hash) return failure('OFFICE_VERSION_CONFLICT', 'The document changed between inspection pages. Restart at contentOffset=0 without the old hash.', { expectedHash: args.expectedHash, actualHash: original.hash })
          const inspection = await inspect(format, original.content)
          throwIfAborted(ctx.signal)
          workspaceManager.resolveSafePath(ctx, canonical)
          if (!samePath(canonicalFilePathSync(workspaceManager.resolveSafePath(ctx, args.path)), canonical) || readBoundedVersion(canonical).hash !== original.hash) return failure('OFFICE_VERSION_CONFLICT', 'The file changed during inspection. Inspect it again to obtain matching content and expectedHash.')
          const result = officeReceipt(canonical, original.hash, original.content.length, inspection, outputLimit, { offset: args.contentOffset, limit: args.contentLimit })
          if (!result.ok) return outputFailure(result, inspection)
          return { success: true, output: result.output, metadata: { path: canonical, expectedHash: original.hash, format, sizeBytes: original.content.length, fileMutationApplied: false, contentTruncated: result.contentTruncated } }
        }
        if (original.hash !== args.expectedHash) return failure('OFFICE_VERSION_CONFLICT', 'The destination changed or already exists. Inspect the current file before editing; generated bytes were not published.', { expectedHash: args.expectedHash, actualHash: original.hash })
        if (args.operation !== 'create' && !original.content) return failure('OFFICE_FILE_MISSING', 'The document does not exist; create requires expectedHash="missing".')
        let generated: Buffer
        try {
          if (args.operation === 'create') {
            if (format === 'docx') generated = await createDocx({ markdown: args.markdown!, title: args.title, author: args.author })
            else if (format === 'pdf') generated = await createPdf({ markdown: args.markdown!, title: args.title, author: args.author })
            else if (format === 'pptx') generated = await createPptx({ ...args.presentation!, title: args.title, author: args.author }, readPptxAssets(ctx, args.presentation!))
            else generated = await createXlsx(args.workbook!)
          } else if (args.operation === 'append_sheets') generated = await appendXlsxSheets(original.content!, args.workbook)
          else if (args.operation === 'recalculate') generated = await recalculateXlsx(original.content!, ctx.signal)
          else if (format === 'xlsx') generated = await editXlsx(original.content!, args.edits.filter((edit): edit is { sheet: string; cell: string; value: z.infer<typeof cell> } => 'cell' in edit))
          else {
            const edits = args.edits.filter((edit): edit is PptxEdit => 'oldText' in edit)
            generated = format === 'docx' ? await editDocx(original.content!, edits) : await editPptx(original.content!, edits)
          }
        } catch (error) { return failure('OFFICE_FORMAT_FAILED', error instanceof Error ? error.message : String(error)) }
        if (!generated.length || generated.length > MAX_OFFICE_FILE_BYTES) return failure('OFFICE_FILE_TOO_LARGE', 'Generated office document is empty or exceeds 32 MiB; original bytes were preserved.')
        const inspection = await inspect(format, generated)
        if (args.operation === 'recalculate') inspection.warnings.unshift('Aether内置公式引擎已重新计算并保存支持公式的缓存；保留原公式及其他包部件。这不代表业务假设或版式已经验收，不支持的公式会拒绝整次发布。')
        if (args.operation === 'append_sheets') inspection.warnings.unshift('已追加新工作表；原有工作表、图表/图片等部件内容保留。旧公式缓存未经重新计算，新增表可能改变依赖；交付前使用内置recalculate并读回，不得把旧缓存当最新结果。旧扩展属性/应用统计保留，不代表本次实际表数量。')
        throwIfAborted(ctx.signal)
        const noChange = original.content?.equals(generated) === true
        // Refuse before publication if mandatory identity or warning evidence cannot cross
        // the model channel. A successful mutation must never lose its actionable receipt.
        const preparedReceipt = officeReceipt(canonical, hashFileContent(generated), generated.length, inspection, outputLimit, undefined, noChange)
        if (!preparedReceipt.ok) return outputFailure(preparedReceipt, inspection)
        if (noChange) {
          workspaceManager.resolveSafePath(ctx, canonical)
          if (!samePath(canonicalFilePathSync(workspaceManager.resolveSafePath(ctx, args.path)), canonical) || readBoundedVersion(canonical).hash !== original.hash) return failure('OFFICE_VERSION_CONFLICT', 'The document changed during validation; inspect its current version before retrying.')
          return { success: true, output: preparedReceipt.output, metadata: { path: canonical, expectedHash: original.hash, noChange: true, fileMutationApplied: false } }
        }
        let snapshot: ChangeSnapshot | undefined, ownedStage: string | undefined
        try {
          snapshot = await readOldSnapshot(canonical)
          if (snapshot.oldHash !== args.expectedHash) return failure('OFFICE_VERSION_CONFLICT', 'The file changed during document generation. Inspect it again before editing.', { expectedHash: args.expectedHash, actualHash: snapshot.oldHash })
          workspaceManager.resolveSafePath(ctx, canonical)
          fs.mkdirSync(path.dirname(canonical), { recursive: true })
          workspaceManager.resolveSafePath(ctx, fs.realpathSync.native(path.dirname(canonical)))
          ownedStage = fs.mkdtempSync(path.join(path.dirname(canonical), '.aether-office-'))
          const temporary = path.join(ownedStage, path.basename(canonical))
          fs.writeFileSync(temporary, generated, { flag: 'wx' })
          throwIfAborted(ctx.signal)
          workspaceManager.resolveSafePath(ctx, canonical)
          const submitted = workspaceManager.resolveSafePath(ctx, args.path)
          if (!samePath(canonicalFilePathSync(canonical), canonical) || !samePath(canonicalFilePathSync(submitted), canonical)) return failure('OFFICE_PATH_CONFLICT', 'The destination path changed during generation. The document was not published.')
          const finalVersion = readBoundedVersion(canonical)
          if (finalVersion.hash !== args.expectedHash) return failure('OFFICE_VERSION_CONFLICT', 'The destination changed before publication. Its current bytes were preserved.', { expectedHash: args.expectedHash, actualHash: finalVersion.hash })
          // No await between the final version check and publication. A hard
          // link gives new files an atomic create-only guarantee. Existing file
          // replacement shares all in-process writer locks; it is not an OS CAS
          // lease against arbitrary external applications.
          if (args.expectedHash === 'missing') {
            try { fs.linkSync(temporary, canonical) }
            catch (error) {
              if ((error as NodeJS.ErrnoException).code === 'EEXIST') return failure('OFFICE_VERSION_CONFLICT', 'Another writer created the destination. Its bytes were preserved.')
              throw error
            }
          } else fs.renameSync(temporary, canonical)
          published = true
          const change = await commitWriteChange(ctx, args.path, canonical, snapshot)
          const expectedHash = change.newHash
          const committedReceipt = officeReceipt(canonical, String(expectedHash), generated.length, inspection, outputLimit)
          // commitWriteChange returns a SHA of the same fixed width checked before publication.
          if (!committedReceipt.ok) return failure('OFFICE_OUTPUT_BUDGET_TOO_SMALL', 'The document was published but its receipt exceeds the output budget; inspect the current version before further edits.', { fileMutationApplied: true, expectedHash, warnings: inspection.warnings })
          return { success: true, change, output: committedReceipt.output,
            metadata: { path: canonical, expectedHash, oldHash: original.hash, newHash: expectedHash, sizeBytes: generated.length, format,
              fileMutationApplied: true, rollbackAvailable: (snapshot.exists ? typeof change.oldSnapshotRef === 'string' : true) && typeof change.newSnapshotRef === 'string',
              validation: 'structure-checked', visualValidation: 'not-performed', generatedHash: hashFileContent(generated) } }
        } finally {
          if (snapshot && !published) discardUnpublishedSnapshot(snapshot)
          if (ownedStage) {
            // Only the fresh staging directory created by this invocation may
            // be recursively removed; never derive cleanup paths from args.
            const resolvedStage = path.resolve(ownedStage)
            if (path.dirname(resolvedStage) !== path.dirname(canonical) || !path.basename(resolvedStage).startsWith('.aether-office-')) throw new Error('Invalid owned Office staging directory')
            try { fs.rmSync(resolvedStage, { recursive: true, force: true }) }
            catch (error) { ctx.logger.warn({ err: error }, 'Office staging cleanup failed') }
          }
        }
      })
    } catch (error) {
      if (error instanceof ChangeRecordingError) return failure('OFFICE_RECORD_FAILED', error.message, { fileMutationApplied: true, rollbackAvailable: false })
      return failure('OFFICE_FAILED', error instanceof Error ? error.message : String(error), { fileMutationApplied: published })
    }
  },
}

type ReadonlyInspectArguments = z.infer<typeof readonlyInspectArguments>
interface InspectionBatchPlan {
  files: ReadonlyInspectArguments[]
  canonicalPaths: string[]
  allowances: number[]
  outputLimit: number
}
interface InspectionBatchItem {
  path: string
  success: boolean
  executed: boolean
  output: unknown
  error?: string
}
const batchEnvelope = (files: InspectionBatchItem[], cancelled = false) => ({ batch: true,
  files, totalFiles: files.length, completedFiles: files.filter(file => file.success).length,
  cancelled, fileMutationApplied: false })
function inspectionBatchFailure(ctx: AgentContext, code: string, message: string, metadata: Record<string, unknown> = {}) {
  const result = officeFailure(code, message, { ...metadata, batch: true, executed: false, completedFiles: 0, fileMutationApplied: false }, getToolOutputLimit(ctx.toolProfile, ctx))
  return code === 'OFFICE_INSPECT_CANCELLED' ? { ...result, status: 'cancelled' as const } : result
}
function inspectBatchInput(raw: unknown): boolean {
  return !!raw && typeof raw === 'object' && Object.hasOwn(raw, 'files')
}

/** Check the complete batch before any document bytes are read. Called both by
 * the registry's whole-response preflight and again at actual execution. */
async function prepareInspectionBatch(files: ReadonlyInspectArguments[], ctx: AgentContext): Promise<InspectionBatchPlan | { failure: ToolResult }> {
  const outputLimit = getToolOutputLimit(ctx.toolProfile, ctx)
  const refuse = (code: string, message: string, metadata: Record<string, unknown> = {}) => ({ failure: inspectionBatchFailure(ctx, code, message, metadata) })
  if (ctx.signal?.aborted) return refuse('OFFICE_INSPECT_CANCELLED', 'Batch cancelled before execution; no documents were read.', { cancelled: true })
  if (!ctx.tools?.preflight) return refuse('OFFICE_BATCH_PREFLIGHT_UNAVAILABLE', 'Batch inspection requires the current tool registry preflight; no documents were read.')
  const canonicalPaths: string[] = []
  try {
    for (const [index, args] of files.entries()) {
      if ((args.contentOffset ?? 0) > 0 && !args.expectedHash) return refuse('OFFICE_INSPECT_VERSION_REQUIRED', 'Each continuation needs that file\'s previous expectedHash; no documents were read.', { fileIndex: index })
      if (!['.docx', '.xlsx', '.pptx', '.pdf'].includes(path.extname(args.path).toLowerCase())) return refuse('OFFICE_UNSUPPORTED_FORMAT', 'Every batch item must be a .docx/.xlsx/.pptx/.pdf file; no documents were read.', { fileIndex: index })
      const canonical = canonicalFilePathSync(workspaceManager.resolveSafePath(ctx, args.path))
      workspaceManager.resolveSafePath(ctx, canonical)
      canonicalPaths.push(canonical)
    }
  } catch (error) {
    return refuse('OFFICE_BATCH_PATH_REJECTED', `Batch path validation failed; no documents were read. ${error instanceof Error ? error.message : String(error)}`)
  }
  // Reserve complete per-item identity and error framing before dividing the
  // remaining channel. Parsed receipt objects avoid a second JSON escaping pass.
  const skeleton = files.map(args => ({ path: args.path, success: false, executed: false, output: null, error: 'x'.repeat(80) }))
  const overhead = JSON.stringify({ ...batchEnvelope(skeleton), completedFiles: files.length }).length - files.length * 4
  const minimums = canonicalPaths.map(file => 768 + JSON.stringify(file).length)
  const requiredOutputChars = overhead + minimums.reduce((sum, value) => sum + value, 0)
  if (requiredOutputChars > outputLimit) return refuse('OFFICE_BATCH_OUTPUT_BUDGET_TOO_SMALL',
    'The shared output budget cannot hold every file identity and a useful inspection receipt. Use a smaller batch or increase the output budget; no documents were read.',
    { requiredOutputChars, outputLimit })
  const extra = Math.floor((outputLimit - requiredOutputChars) / files.length)
  try {
    for (const [index, args] of files.entries()) {
      if (ctx.signal?.aborted) return refuse('OFFICE_INSPECT_CANCELLED', 'Batch cancelled during preflight; no documents were read.', { cancelled: true })
      const blocked = await ctx.tools.preflight('office_inspect', args, ctx)
      if (blocked) {
        const failure = inspectionBatchFailure(ctx, 'OFFICE_BATCH_PREFLIGHT_BLOCKED',
          `File ${index + 1} did not pass inspection preflight; no documents were read. ${blocked.error ?? blocked.output}`,
          { ...blocked.metadata, fileIndex: index })
        return { failure: { ...blocked, ...failure, status: blocked.status, needsConfirmation: blocked.needsConfirmation } }
      }
    }
  } catch (error) {
    return refuse(ctx.signal?.aborted ? 'OFFICE_INSPECT_CANCELLED' : 'OFFICE_BATCH_PREFLIGHT_FAILED',
      `Batch preflight did not complete; no documents were read. ${error instanceof Error ? error.message : String(error)}`,
      { cancelled: ctx.signal?.aborted === true })
  }
  return { files, canonicalPaths, allowances: minimums.map(value => value + extra), outputLimit }
}

async function executeInspectionBatch(plan: InspectionBatchPlan, ctx: AgentContext): Promise<ToolResult> {
  const items: InspectionBatchItem[] = new Array(plan.files.length)
  const metadata: Record<string, unknown>[] = new Array(plan.files.length)
  let cursor = 0, waiting: ToolResult | undefined
  const worker = async () => {
    for (;;) {
      const index = cursor++
      if (index >= plan.files.length) return
      const args = plan.files[index], itemCtx = boundedToolContext(ctx, plan.allowances[index])
      let executed = false, result: ToolResult
      try {
        if (ctx.signal?.aborted) result = officeFailure('OFFICE_INSPECT_CANCELLED', 'Cancelled before this file was read.', { cancelled: true }, plan.allowances[index])
        else if (waiting) result = officeFailure('OFFICE_BATCH_PENDING_INPUT', 'A batch item now requires permission; this queued file was not read.', {}, plan.allowances[index])
        else {
          // Recheck mutable permissions immediately before each queued read.
          const blocked = await ctx.tools.preflight!('office_inspect', args, itemCtx)
          if (blocked) {
            if (blocked.status === 'waiting' || blocked.needsConfirmation) waiting ??= blocked
            result = officeFailure('OFFICE_BATCH_PREFLIGHT_BLOCKED', blocked.error ?? blocked.output,
              { ...blocked.metadata, blocked: true, fileMutationApplied: false }, plan.allowances[index])
          }
          else if (ctx.signal?.aborted) result = officeFailure('OFFICE_INSPECT_CANCELLED', 'Cancelled before this file was read.', { cancelled: true }, plan.allowances[index])
          else if (waiting) result = officeFailure('OFFICE_BATCH_PENDING_INPUT', 'A batch item now requires permission; this queued file was not read.', {}, plan.allowances[index])
          else {
            const current = canonicalFilePathSync(workspaceManager.resolveSafePath(itemCtx, args.path))
            if (!samePath(current, plan.canonicalPaths[index])) result = officeFailure('OFFICE_PATH_CONFLICT', 'The file path changed after batch preflight; this file was not read.', {}, plan.allowances[index])
            else {
              executed = true
              result = await officeDocumentTool.execute({ ...args, operation: 'inspect' }, itemCtx)
              if (!result.success && ctx.signal?.aborted) result = officeFailure('OFFICE_INSPECT_CANCELLED',
                'Inspection was cancelled; no validated preview is available for this file.', { cancelled: true }, plan.allowances[index])
            }
          }
        }
      } catch (error) {
        result = officeFailure(ctx.signal?.aborted ? 'OFFICE_INSPECT_CANCELLED' : 'OFFICE_FAILED',
          error instanceof Error ? error.message : String(error), { cancelled: ctx.signal?.aborted === true }, plan.allowances[index])
      }
      let output: unknown
      try { output = JSON.parse(result.output) }
      catch {
        result = officeFailure('OFFICE_INVALID_RECEIPT', 'The inspection did not return a complete JSON receipt.', {}, plan.allowances[index])
        output = JSON.parse(result.output)
      }
      items[index] = { path: args.path, success: result.success, executed, output,
        ...(result.success ? {} : { error: (result.error ?? 'OFFICE_FAILED').slice(0, 80) }) }
      const receipt = output && typeof output === 'object' ? output as Record<string, unknown> : {}
      metadata[index] = { ...result.metadata, path: result.metadata?.path ?? plan.canonicalPaths[index], success: result.success, executed,
        ...(result.success ? { contentIncluded: receipt.contentIncluded, contentTruncated: receipt.contentTruncated, contentPage: receipt.contentPage } : { error: items[index].error }),
        fileMutationApplied: false }
    }
  }
  // Parse at most two Office packages concurrently; queued files observe abort.
  await Promise.all(Array.from({ length: Math.min(2, plan.files.length) }, worker))
  const cancelled = items.some(item => item.error === 'OFFICE_INSPECT_CANCELLED')
  const envelope = batchEnvelope(items, cancelled), output = JSON.stringify(envelope)
  if (output.length > plan.outputLimit) return officeFailure('OFFICE_BATCH_OUTPUT_OVERFLOW',
    'Inspection receipts exceeded their reserved framing; no complete batch preview was returned. Retry fewer files.',
    { batch: true, executed: items.some(item => item.executed), files: metadata, cancelled }, plan.outputLimit)
  const success = items.every(item => item.success)
  return { ...waiting, success, output, ...(success ? {} : { error: cancelled ? 'OFFICE_INSPECT_CANCELLED' : 'OFFICE_BATCH_PARTIAL_FAILURE' }),
    ...(cancelled ? { status: 'cancelled' as const, needsConfirmation: false } : {}),
    metadata: { batch: true, files: metadata, completedFiles: envelope.completedFiles, cancelled, fileMutationApplied: false } }
}

const readonlyInspectionProperties = {
  path: { type: 'string', minLength: 1, maxLength: 4096, description: '当前工作区中的 .docx/.xlsx/.pptx/.pdf 文件路径。' },
  expectedHash: { type: 'string', pattern: '^sha256:[a-f0-9]{64}$', description: '首次可省略；分页须该文件上页sha256，防混读版本。' },
  contentOffset: { type: 'integer', minimum: 0, maximum: maxContentOffset, description: '该文件上页contentPage.nextOffset（UTF-16字符位置），仅覆盖已提取预览。' },
  contentLimit: { type: 'integer', minimum: 2, maximum: 32000, description: '本页预览字符上限，仍受共享工具输出预算限制。' },
}

export const officeInspectTool: Tool = {
  name: 'office_inspect', displayName: '检查办公文档',
  description: '只读提取DOCX/XLSX/PPTX/PDF文字/表格预览，返回warnings、expectedHash。单文件path或批量files二选一；files最多16项，共享输出预算、逐文件分页，预算不足先拒绝未执行，失败逐项报告；需更完整内容按各文件游标及版本续读。Excel限2000格/格600字符；保存的错误计数覆盖全表，位置有界；不重算公式，不保证业务/视觉正确。Word仅正文。PPTX附1起始slide/textRun及editable；备注额外标target=notes，供定点编辑。分页仅覆盖已提取预览，非全文；写入/重算用获授权的office_document。',
  parameters: {
    type: 'object', additionalProperties: false,
    properties: {
      ...readonlyInspectionProperties,
      files: { type: 'array', minItems: 1, maxItems: 16, description: '独立文件同批检查；不能与顶层path/expectedHash/contentOffset/contentLimit混用。每项权限先检，通过后有界并发读取，结果按输入顺序返回。',
        items: { type: 'object', additionalProperties: false, properties: readonlyInspectionProperties, required: ['path'] } },
    }, oneOf: [{ required: ['path'], not: { required: ['files'] } },
      { required: ['files'], not: { anyOf: ['path', 'expectedHash', 'contentOffset', 'contentLimit'].map(field => ({ required: [field] })) } }],
  },
  async preflight(raw: unknown, ctx: AgentContext): Promise<ToolResult | undefined> {
    if (!inspectBatchInput(raw)) return undefined
    if (!boundedInput(raw)) return inspectionBatchFailure(ctx, 'OFFICE_INPUT_TOO_LARGE', 'Office batch arguments exceed their bounded input limits; no documents were read.')
    const parsed = readonlyInspectBatchArguments.safeParse(raw)
    if (!parsed.success) return inspectionBatchFailure(ctx, 'OFFICE_INVALID_ARGUMENTS', 'Use 1–16 readonly files, without top-level single-file or write arguments; no documents were read.')
    const prepared = await prepareInspectionBatch(parsed.data.files, ctx)
    return 'failure' in prepared ? prepared.failure : undefined
  },
  async execute(raw: unknown, ctx: AgentContext): Promise<ToolResult> {
    const outputLimit = getToolOutputLimit(ctx.toolProfile, ctx)
    const failure = (code: string, message: string) => inspectBatchInput(raw)
      ? inspectionBatchFailure(ctx, code, message + ' No documents were read.') : officeFailure(code, message, {}, outputLimit)
    if (!boundedInput(raw)) return failure('OFFICE_INPUT_TOO_LARGE', 'Office arguments must fit within 2 MiB of text, 220000 values and bounded nesting.')
    const parsed = readonlyInspectInput.safeParse(raw)
    if (!parsed.success) return failure('OFFICE_INVALID_ARGUMENTS', parsed.error.issues.slice(0, 5).map(issue => `${issue.path.join('.') || 'arguments'}: ${issue.message}`).join('; '))
    // Parse a strict read-only contract before fixing the operation. The shared
    // inspect branch retains the same byte, workspace, version and paging fences.
    if ('files' in parsed.data) {
      const prepared = await prepareInspectionBatch(parsed.data.files, ctx)
      return 'failure' in prepared ? prepared.failure : executeInspectionBatch(prepared, ctx)
    }
    return officeDocumentTool.execute({ ...parsed.data, operation: 'inspect' }, ctx)
  },
}
