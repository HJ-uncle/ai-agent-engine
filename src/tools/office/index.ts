import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import type { AgentContext, Tool, ToolResult } from '../../core/agent-context/index.js'
import { throwIfAborted } from '../../core/utils/abort.js'
import { canonicalFilePathSync, hashFileContent, readFileVersionSync, withFileLocks } from '../../shared/file-version.js'
import { workspaceManager } from '../../workspace/index.js'
import { ChangeRecordingError, commitWriteChange, discardUnpublishedSnapshot, readOldSnapshot, type ChangeSnapshot } from '../file/change-recorder.js'
import { createDocx, editDocx, inspectDocx } from './docx.js'
import { createXlsx, editXlsx, inspectXlsx } from './xlsx.js'
import { MAX_OFFICE_FILE_BYTES } from './office-zip.js'

const text = z.string().max(32_000)
const formula = z.object({ formula: z.string().min(1).max(2000) }).strict()
const cell = z.union([text, z.number().finite(), z.boolean(), z.null(), formula])
const textEdits = z.array(z.object({ oldText: z.string().min(1).max(32_000), newText: text }).strict()).min(1).max(100)
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
const inspectArguments = z.object({ operation: z.literal('inspect'), path: filePath }).strict()
const createArguments = z.object({ operation: z.literal('create'), path: filePath, expectedHash: z.literal('missing'),
  markdown: z.string().min(1).max(300_000).optional(), title: z.string().max(256).optional(), author: z.string().max(200).optional(), workbook: workbook.optional() }).strict()
const editArguments = z.object({ operation: z.literal('edit'), path: filePath, expectedHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  edits: z.union([textEdits, cellEdits]) }).strict()
const argumentsSchema = z.discriminatedUnion('operation', [inspectArguments, createArguments, editArguments])
type Arguments = z.infer<typeof argumentsSchema>
type Inspection = Awaited<ReturnType<typeof inspectDocx>> | Awaited<ReturnType<typeof inspectXlsx>>

function failure(code: string, message: string, metadata: Record<string, unknown> = {}): ToolResult {
  const details = { code, fileMutationApplied: false, ...metadata }
  return { success: false, error: code, output: JSON.stringify({ message, ...details }), metadata: details }
}
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
function inspect(format: 'docx' | 'xlsx', bytes: Buffer): Promise<Inspection> {
  return format === 'docx' ? inspectDocx(bytes) : inspectXlsx(bytes)
}
function receipt(file: string, hash: string, bytes: number, inspection: Inspection, includeContent: boolean) {
  const previewLimit = 120_000
  return { path: file, expectedHash: hash, sizeBytes: bytes, ...inspection,
    content: includeContent ? inspection.content.slice(0, previewLimit) : undefined,
    contentTruncated: includeContent && inspection.content.length > previewLimit,
    validation: 'structure-checked', visualValidation: 'not-performed' }
}

export const officeDocumentTool: Tool = {
  name: 'office_document', displayName: '办公文档',
  description: '创建、检查和定点编辑真实 Word(.docx) 与 Excel(.xlsx) 文件。办公写作/排版优先读取 aether-office skill；已有 read_file 读取能力保留。inspect 返回真实正文/表格摘要、warnings 和完整字节 expectedHash；create 必须传 expectedHash="missing"，不覆盖已有文件；edit 必须使用同文件最近一次 inspect/read_file/create/edit 返回的 sha256 版本。Word 新建用 markdown（标题/列表/表格），编辑用唯一 oldText/newText；Excel 新建用 workbook，编辑用 sheet/cell/value。公式值用 {formula:"SUM(B2:B4)"}，禁止以普通字符串冒充已计算结果。内部生成、结构校验、版本检查完成后才原子发布，并记录真实改动及撤回快照；结构检查不等于视觉排版或公式重算验证。只支持 docx/xlsx，不生成伪装扩展名文件，不需要 Python、shell 或 pip。',
  parameters: {
    type: 'object', additionalProperties: false,
    properties: {
      operation: { type: 'string', enum: ['inspect', 'create', 'edit'] },
      path: { type: 'string', minLength: 1, maxLength: 4096, description: '当前工作区中的 .docx 或 .xlsx 目标路径。' },
      expectedHash: { type: 'string', pattern: '^(missing|sha256:[a-f0-9]{64})$', description: 'create 必须为 missing；edit 必须复用同文件最近一次工具返回的 sha256；inspect 无需此参数。' },
      markdown: { type: 'string', minLength: 1, maxLength: 300000, description: '仅 Word create 使用，支持标题、正文、列表、表格。' },
      title: { type: 'string', maxLength: 256, description: '可选的独立可见标题，同时写入文档属性；避免与 Markdown 首标题重复。' }, author: { type: 'string', maxLength: 200 },
      workbook: { type: 'object', additionalProperties: false, properties: { sheets: { type: 'array', minItems: 1, maxItems: 12,
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
    if (!boundedInput(raw)) return failure('OFFICE_INPUT_TOO_LARGE', 'Office arguments must fit within 2 MiB of text, 220000 values and bounded nesting.')
    const parsed = argumentsSchema.safeParse(raw)
    if (!parsed.success) return failure('OFFICE_INVALID_ARGUMENTS', parsed.error.issues.slice(0, 5).map(issue => `${issue.path.join('.') || 'arguments'}: ${issue.message}`).join('; '))
    const args: Arguments = parsed.data
    const extension = path.extname(args.path).toLowerCase()
    if (extension !== '.docx' && extension !== '.xlsx') return failure('OFFICE_UNSUPPORTED_FORMAT', 'Only real .docx and .xlsx files are supported. Existing read_file still reads other supported office formats.')
    const format = extension === '.docx' ? 'docx' : 'xlsx'
    if (args.operation === 'create' && (format === 'docx' ? !args.markdown || args.workbook !== undefined : !args.workbook || args.markdown !== undefined || args.title !== undefined || args.author !== undefined)) return failure('OFFICE_INVALID_ARGUMENTS', 'Word creation requires markdown; Excel creation requires workbook. Do not mix the two inputs.')
    if (args.operation === 'edit' && !args.edits.every(edit => format === 'docx' ? 'oldText' in edit : 'cell' in edit)) return failure('OFFICE_INVALID_ARGUMENTS', 'Word edits require oldText/newText; Excel edits require sheet/cell/value.')
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
          const inspection = await inspect(format, original.content)
          throwIfAborted(ctx.signal)
          workspaceManager.resolveSafePath(ctx, canonical)
          if (!samePath(canonicalFilePathSync(workspaceManager.resolveSafePath(ctx, args.path)), canonical) || readBoundedVersion(canonical).hash !== original.hash) return failure('OFFICE_VERSION_CONFLICT', 'The file changed during inspection. Inspect it again to obtain matching content and expectedHash.')
          const result = receipt(canonical, original.hash, original.content.length, inspection, true)
          return { success: true, output: JSON.stringify(result), metadata: { path: canonical, expectedHash: original.hash, format, sizeBytes: original.content.length, fileMutationApplied: false } }
        }
        if (original.hash !== args.expectedHash) return failure('OFFICE_VERSION_CONFLICT', 'The destination changed or already exists. Inspect the current file before editing; generated bytes were not published.', { expectedHash: args.expectedHash, actualHash: original.hash })
        if (args.operation === 'edit' && !original.content) return failure('OFFICE_FILE_MISSING', 'The document does not exist; create requires expectedHash="missing".')
        let generated: Buffer
        try {
          generated = args.operation === 'create'
            ? format === 'docx' ? await createDocx({ markdown: args.markdown!, title: args.title, author: args.author }) : await createXlsx(args.workbook!)
            : format === 'docx'
              ? await editDocx(original.content!, args.edits.filter((edit): edit is { oldText: string; newText: string } => 'oldText' in edit))
              : await editXlsx(original.content!, args.edits.filter((edit): edit is { sheet: string; cell: string; value: z.infer<typeof cell> } => 'cell' in edit))
        } catch (error) { return failure('OFFICE_FORMAT_FAILED', error instanceof Error ? error.message : String(error)) }
        if (!generated.length || generated.length > MAX_OFFICE_FILE_BYTES) return failure('OFFICE_FILE_TOO_LARGE', 'Generated office document is empty or exceeds 32 MiB; original bytes were preserved.')
        const inspection = await inspect(format, generated)
        throwIfAborted(ctx.signal)
        if (original.content?.equals(generated)) {
          workspaceManager.resolveSafePath(ctx, canonical)
          if (!samePath(canonicalFilePathSync(workspaceManager.resolveSafePath(ctx, args.path)), canonical) || readBoundedVersion(canonical).hash !== original.hash) return failure('OFFICE_VERSION_CONFLICT', 'The document changed during validation; inspect its current version before retrying.')
          return { success: true, output: JSON.stringify({ ...receipt(canonical, original.hash, generated.length, inspection, false), noChange: true }), metadata: { path: canonical, expectedHash: original.hash, noChange: true, fileMutationApplied: false } }
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
          return { success: true, change, output: JSON.stringify(receipt(canonical, String(expectedHash), generated.length, inspection, false)),
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
