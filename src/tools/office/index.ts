import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import type { AgentContext, Tool, ToolResult } from '../../core/agent-context/index.js'
import { throwIfAborted } from '../../core/utils/abort.js'
import { getToolOutputLimit } from '../../core/agent-loop/tool-output-limit.js'
import { canonicalFilePathSync, hashFileContent, readFileVersionSync, withFileLocks } from '../../shared/file-version.js'
import { workspaceManager } from '../../workspace/index.js'
import { ChangeRecordingError, commitWriteChange, discardUnpublishedSnapshot, readOldSnapshot, type ChangeSnapshot } from '../file/change-recorder.js'
import { createDocx, editDocx, inspectDocx } from './docx.js'
import { createXlsx, editXlsx, inspectXlsx, appendXlsxSheets } from './xlsx.js'
import { createPdf, inspectPdf } from './pdf.js'
import { createPptx, editPptx, inspectPptx, type PptxEdit } from './pptx.js'
import { recalculateXlsx } from './recalculate.js'
import { MAX_OFFICE_FILE_BYTES } from './office-zip.js'
import { officeFailure, officeReceipt, type OfficeInspection } from './output.js'

const text = z.string().max(32_000)
const formula = z.object({ formula: z.string().min(1).max(2000) }).strict()
const cell = z.union([text, z.number().finite(), z.boolean(), z.null(), formula])
const textEdits = z.array(z.object({ oldText: z.string().min(1).max(32_000), newText: text,
  slide: z.number().int().min(1).max(40).optional(), textRun: z.number().int().min(1).max(100_000).optional(),
}).strict().refine(edit => (edit.slide === undefined) === (edit.textRun === undefined), 'slide and textRun must be supplied together')).min(1).max(100)
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
const presentation = z.object({ slides: z.array(z.object({
  title: z.string().min(1).max(100),
  bullets: z.array(z.string().min(1).max(160)).max(6).optional(),
  table: z.object({ headers: z.array(z.string().min(1).max(100)).min(1).max(6),
    rows: z.array(z.array(z.union([z.string().max(100), z.number().finite()])).min(1).max(6)).max(8) }).strict().optional(),
  notes: z.string().max(3000).optional(),
}).strict()).min(1).max(40) }).strict()
// DOCX allows 2 Mi characters of paragraph text plus separators; the package's
// 500000-element bound keeps their combined preview below 3 Mi UTF-16 units.
const maxContentOffset = 3 * 1024 * 1024
const inspectArguments = z.object({ operation: z.literal('inspect'), path: filePath,
  expectedHash: z.string().regex(/^sha256:[a-f0-9]{64}$/).optional(),
  contentOffset: z.number().int().min(0).max(maxContentOffset).optional(),
  contentLimit: z.number().int().min(2).max(32_000).optional(),
}).strict()
const readonlyInspectArguments = inspectArguments.omit({ operation: true })
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
function inspect(format: OfficeInspection['format'], bytes: Buffer): Promise<Inspection> {
  if (format === 'docx') return inspectDocx(bytes)
  if (format === 'xlsx') return inspectXlsx(bytes)
  return format === 'pdf' ? inspectPdf(bytes) : inspectPptx(bytes)
}

export const officeDocumentTool: Tool = {
  name: 'office_document', displayName: '办公文档',
  description: 'Aether内置办公文档：原生创建/检查DOCX、XLSX、PPTX、PDF，无需WPS、Office COM、Python、shell或pip。先读aether-office技能。create必须expectedHash="missing"；其他写入必须复用同文件最近返回sha256。Word/PDF创建用markdown；PPTX用presentation.slides（title、bullets、table、notes）；Excel用workbook。Word/PPTX edit用唯一oldText/newText；PPTX重复文字可成对指定inspect返回的slide/textRun（均从1开始），仍须在目标普通文本节点内唯一。Excel edit用sheet/cell/value。PDF只支持创建和检查，修改请新建版本。append_sheets每次添加1-4张Excel表，保留旧表部件。recalculate仅XLSX：内置有界计算常用公式及跨表引用并更新缓存，不支持/循环/外链会拒绝，原文件保留；不是全Excel计算兼容。公式用{formula:"SUM(B2:B4)"}。inspect返回真实文字/表格预览、warnings及expectedHash；按contentPage.nextOffset+同文件hash分页。Excel最多2000单元格、单格600字符，Word仅主文档文字；分页不代表全文/视觉完整。发布前版本检查、原子写入、记录改动及撤回快照。PDF由Aether独立排版，不等于Word/PPT转换。结构检查不等于视觉或业务验收。',
  parameters: {
    type: 'object', additionalProperties: false,
    properties: {
      operation: { type: 'string', enum: ['inspect', 'create', 'edit', 'append_sheets', 'recalculate'] },
      path: { type: 'string', minLength: 1, maxLength: 4096, description: '当前工作区中的 .docx/.xlsx/.pptx/.pdf 目标路径。PDF支持create/inspect，其他格式也支持定点edit；recalculate只支持xlsx。' },
      expectedHash: { type: 'string', pattern: '^(missing|sha256:[a-f0-9]{64})$', description: 'create 必须为 missing；edit/append_sheets/recalculate 必须复用同文件最近一次工具返回的 sha256；inspect 首次可省略，contentOffset>0时必须传同文件上一页的 sha256，防止混读不同版本。' },
      contentOffset: { type: 'integer', minimum: 0, maximum: maxContentOffset, description: '仅 inspect：使用上页 contentPage.nextOffset（UTF-16字符位置）；只分页检查预览，不代表完整文档。' },
      contentLimit: { type: 'integer', minimum: 2, maximum: 32000, description: '仅 inspect：本页预览字符上限，实际会按工具输出预算进一步缩短。' },
      markdown: { type: 'string', minLength: 1, maxLength: 300000, description: 'Word/PDF create 使用，支持标题、正文、列表、表格。PDF由Aether直接排版，并非从Word/PPT转换。' },
      title: { type: 'string', maxLength: 256, description: '可选的独立可见标题，同时写入文档属性；避免与 Markdown 首标题重复。' }, author: { type: 'string', maxLength: 200 },
      presentation: { type: 'object', additionalProperties: false, description: '仅PPTX create：分页的演示内容，过长内容拆成多页，不缩成不可读小字。', properties: {
        slides: { type: 'array', minItems: 1, maxItems: 40, items: { type: 'object', additionalProperties: false, properties: {
          title: { type: 'string', minLength: 1, maxLength: 100, description: '单行短标题，最多94个英文字符宽度（中文约47字）。' },
          bullets: { type: 'array', maxItems: 6, description: '每页最多6条，含表格时最多2条；每条不换行，最多140英文字符宽度（中文约70字）。', items: { type: 'string', minLength: 1, maxLength: 160 } },
          table: { type: 'object', additionalProperties: false, description: '最多6列、8行；同页有要点时最多5行。单元格不换行，英文字符宽度最多100/列数，中文按2计；长内容拆页。', properties: {
            headers: { type: 'array', minItems: 1, maxItems: 6, items: { type: 'string', minLength: 1, maxLength: 100 } },
            rows: { type: 'array', maxItems: 8, items: { type: 'array', minItems: 1, maxItems: 6, items: { anyOf: [{ type: 'string', maxLength: 100 }, { type: 'number' }] } } },
          }, required: ['headers', 'rows'] },
          notes: { type: 'string', maxLength: 3000 },
        }, required: ['title'] } },
      }, required: ['slides'] },
      workbook: { type: 'object', additionalProperties: false, description: 'Excel create 或 append_sheets 的新增表内容。append_sheets 每次最多4张（建议一张），不重复提交已存在的表。', properties: { sheets: { type: 'array', minItems: 1, maxItems: 12,
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
        { type: 'object', additionalProperties: false, description: '仅 PPTX：复用 inspect 返回的 slide/textRun 定位，oldText 必须在该普通文本节点内唯一；字段不可编辑。省略定位时仍要求全稿唯一。', properties: {
          oldText: { type: 'string', minLength: 1, maxLength: 10000 }, newText: { type: 'string', maxLength: 10000 },
          slide: { type: 'integer', minimum: 1, maximum: 40, description: '幻灯片显示顺序，从 1 开始，与 ZIP 文件名顺序无关。' },
          textRun: { type: 'integer', minimum: 1, maximum: 100000, description: '该页 inspect 标记的文本节点编号，从 1 开始，需 editable=true。' },
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
    const outputLimit = getToolOutputLimit(ctx.toolProfile)
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
    if (args.operation === 'edit' && format !== 'pptx' && args.edits.some(edit => 'slide' in edit || 'textRun' in edit)) return failure('OFFICE_INVALID_ARGUMENTS', 'slide/textRun selectors are only supported for PPTX; Word edits still require globally unique oldText/newText.')
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
            else if (format === 'pptx') generated = await createPptx({ ...args.presentation!, title: args.title, author: args.author })
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

export const officeInspectTool: Tool = {
  name: 'office_inspect', displayName: '检查办公文档',
  description: '只读检查真实DOCX/XLSX/PPTX/PDF，返回已提取文字/表格的有界预览、warnings及expectedHash；不写文件。Excel最多预览2000单元格、单格600字符，已保存错误计数遍历全部工作表但只列有限位置；不重算公式、不保证业务或视觉正确。Word仅主文档文字。PPTX正文附slide/textRun定位（均从1开始）及editable标记，供office_document定点编辑重复文字。按contentPage.nextOffset+同文件expectedHash分页；只覆盖已提取预览，不能宣称全文。只接受path、expectedHash、contentOffset、contentLimit；写入/重算使用获授权的office_document。',
  parameters: {
    type: 'object', additionalProperties: false,
    properties: {
      path: { type: 'string', minLength: 1, maxLength: 4096, description: '当前工作区中的 .docx/.xlsx/.pptx/.pdf 文件路径。' },
      expectedHash: { type: 'string', pattern: '^sha256:[a-f0-9]{64}$', description: '首次可省略；分页时必须复用同文件上一页返回的 sha256，防止混读不同版本。' },
      contentOffset: { type: 'integer', minimum: 0, maximum: maxContentOffset, description: '上页 contentPage.nextOffset（UTF-16字符位置），仅覆盖已提取预览。' },
      contentLimit: { type: 'integer', minimum: 2, maximum: 32000, description: '本页预览字符上限，仍受工具输出预算限制。' },
    }, required: ['path'],
  },
  async execute(raw: unknown, ctx: AgentContext): Promise<ToolResult> {
    const outputLimit = getToolOutputLimit(ctx.toolProfile)
    if (!boundedInput(raw)) return officeFailure('OFFICE_INPUT_TOO_LARGE', 'Office arguments must fit within 2 MiB of text, 220000 values and bounded nesting.', {}, outputLimit)
    const parsed = readonlyInspectArguments.safeParse(raw)
    if (!parsed.success) return officeFailure('OFFICE_INVALID_ARGUMENTS', parsed.error.issues.slice(0, 5).map(issue => `${issue.path.join('.') || 'arguments'}: ${issue.message}`).join('; '), {}, outputLimit)
    // Parse a strict read-only contract before fixing the operation. The shared
    // inspect branch retains the same byte, workspace, version and paging fences.
    return officeDocumentTool.execute({ ...parsed.data, operation: 'inspect' }, ctx)
  },
}
