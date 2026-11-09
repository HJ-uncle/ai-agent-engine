import fs from 'node:fs'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import type { Tool, AgentContext, ToolResult } from '../../core/agent-context/index.js'
import { workspaceManager } from '../../workspace/index.js'
import { MAX_FILE_SIZE } from './constants.js'
import { handlerRegistry } from './handlers/registry.js'
import { readOldSnapshot, commitWriteChange, commitWriteChangeWithReceipt, ChangeRecordingError, decodeEditableText, restoreSnapshot } from './change-recorder.js'
import { formatWriteReceipt } from './write-receipt.js'
import { readFileVersionSync, withFileLocks } from '../../shared/file-version.js'
import { normalizeWriteFileArgs } from '../../shared/write-file-args.js'
import { throwIfAborted } from '../../core/utils/abort.js'
import { writeConditionalFile } from './conditional-write.js'
import { getToolOutputLimit } from '../../core/agent-loop/tool-output-limit.js'
import { TextHandler } from './handlers/text-handler.js'
import { readTextPage } from './text-page.js'
import { fileBatchSchema, hasFileBatch, isFileBatchReadContext, readFileBatch, preflightFileReadBatch, preflightFileWriteBatch, writeFileBatch } from './file-batch.js'

const singleReadFileTool: Tool = {
  name: 'read_file',
  displayName: '读取文件',
  description: '按确切路径读取支持格式的文件（JSON, CSV, XLSX, PDF, DOCX, 代码, 文本），支持分页。路径不存在则失败，不搜索或替换成其他目录/版本的同名文件；路径不确定时先用 list_files 或搜索工具定位。默认返回行号及完整字节 expectedHash；行号和格式化展示不是源文件原文。精确编辑前使用 mode="exact"：返回 JSON，其 content 为无行号的原始 UTF-8 文本（保留 CRLF/BOM）。逐字节复制优先 write_file copyFrom:{path,expectedHash}，直接保留源文件字节，无需读取并转写全文；仅手动重写时才要求完整 content（contentIsComplete=true），不 trim，不删尾部换行。expectedHash 的 sha256: 后 64 位就是工具实际计算的整文件 SHA-256，可直接报告，无需另运行命令。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '确切文件路径；相对路径基于当前工作区解析，不按文件名猜测其他目录。' },
      start_line: { type: 'number', description: '起始行号（从 1 开始），默认 1' },
      end_line: { type: 'number', description: '结束行号。Work 普通文本默认按输出预算连续分页，参考 hasMore/nextStartLine/nextStartColumn；其他模式默认最多300行，full/exact按各自约定。' },
      start_column: { type: 'integer', minimum: 1, description: '仅 Work 普通文本 auto 模式可用；1 起 UTF-16 列偏移，不得落在代理对中间。超长行按 nextStartLine/nextStartColumn 续读。' },
      mode: { type: 'string', enum: ['auto', 'full', 'summary', 'vision', 'ocr', 'exact'], description: 'auto(默认), full(全文), summary(摘要/签名), vision(图片预览), ocr(文本提取), exact(原始UTF-8 JSON，含完整expectedHash，可按行分页)' },
    },
    required: ['path'],
  },
  async execute(rawArgs: unknown, ctx: AgentContext): Promise<ToolResult> {
    const { path: filePath, mode = 'auto', start_line, end_line, start_column } = rawArgs as { path: string; mode?: any; start_line?: number; end_line?: number; start_column?: number }
    const startTime = performance.now()
    
    try {
      // A missing revision must not resolve to another task's newest namesake.
      // Keep path discovery explicit, avoiding cross-task evidence substitution
      // and an unbounded directory walk on every failed read.
      const targetPath = workspaceManager.resolveSafePath(ctx, filePath)
      if (!fs.existsSync(targetPath)) return {
        success: false, error: 'FILE_NOT_FOUND',
        output: `File not found: ${filePath}. Reading requires the specified file and does not guess another path. Use list_files or a search tool to locate it, then read its exact path.`,
        metadata: { code: 'FILE_NOT_FOUND', requestedPath: filePath, fileMutationApplied: false },
      }
      
      return await withFileLocks([targetPath], async ([canonicalPath]) => {
        throwIfAborted(ctx.signal)
        workspaceManager.resolveSafePath(ctx, canonicalPath)
        const stat = fs.statSync(canonicalPath)
        if (!stat.isFile()) return { success: false, output: `Path is not a regular file: ${filePath}` }
        if (stat.size > MAX_FILE_SIZE) return { success: false, output: `File too large (${stat.size} bytes, max ${MAX_FILE_SIZE} bytes)` }
        const before = readFileVersionSync(canonicalPath)
        if (!before.content) return { success: false, output: `File not found: ${filePath}` }
        if (before.content.byteLength > MAX_FILE_SIZE) return { success: false, output: `File too large (${before.content.byteLength} bytes, max ${MAX_FILE_SIZE} bytes)` }
        const text = decodeEditableText(canonicalPath, before.content)
        const handler = handlerRegistry.getHandler(canonicalPath)
        if (start_column !== undefined && ((ctx.toolProfile !== 'general' && !isFileBatchReadContext(ctx)) || mode !== 'auto' || !(handler instanceof TextHandler) || text === null)) {
          return { success: false, error: 'COLUMN_PAGING_UNSUPPORTED', output: 'start_column is supported only by Work ordinary UTF-8 text in auto mode; Code, exact and format-specific readers do not support column paging.' }
        }
        const endings = text?.match(/\r\n|\r|\n/g) ?? []
        const endingKinds = [...new Set(endings)]
        const version = { path: canonicalPath, expectedHash: before.hash, encoding: text === null ? 'binary-or-non-utf8' : 'utf-8',
          lineEnding: endingKinds.length > 1 ? 'mixed' : endingKinds[0] === '\r\n' ? 'CRLF' : endingKinds[0] === '\n' ? 'LF' : endingKinds[0] === '\r' ? 'CR' : 'none',
          utf8Bom: text?.startsWith('\uFEFF') ?? false }
        if (mode === 'exact') {
          if (text === null) return { success: false, output: 'Exact reading requires a valid UTF-8 text file; use its format-specific read mode for binary files.' }
          if ([start_line, end_line].some(value => value !== undefined && (!Number.isInteger(value) || value < 1))) return { success: false, output: 'start_line and end_line must be positive integers.' }
          const lineStarts = [0, ...Array.from(text.matchAll(/\r\n|\r|\n/g), match => match.index! + match[0].length)]
          const totalLines = lineStarts.length
          const startLine = Math.min(start_line ?? 1, totalLines)
          const endLine = Math.min(end_line ?? totalLines, totalLines)
          if (endLine < startLine) return { success: false, output: 'end_line must not be before start_line.' }
          const content = text.slice(lineStarts[startLine - 1], lineStarts[endLine] ?? text.length)
          // These byte facts describe the entire UTF-8 file, even for a page.
          // A page must never be mistaken for a complete copy source.
          const exactVersion = { ...version, sha256: before.hash.slice('sha256:'.length), byteLength: before.content.byteLength,
            trailingLineEnding: text.endsWith('\r\n') ? 'CRLF' : text.endsWith('\n') ? 'LF' : text.endsWith('\r') ? 'CR' : 'none' }
          return { success: true, output: JSON.stringify({ ...exactVersion, startLine, endLine, totalLines, contentIsComplete: startLine === 1 && endLine === totalLines, content }), metadata: exactVersion }
        }
        // PPTX has no legacy text handler. Returning its ZIP bytes as numbered
        // UTF-8 lines polluted model context and prompted ad-hoc decompression.
        // Keep this an explicit diagnostic: line ranges are not Office offsets.
        if (text === null && path.extname(canonicalPath).toLowerCase() === '.pptx') {
          const reader = ctx.tools?.has('office_inspect') === true
          const message = reader
            ? 'PPTX is a binary Office package. Use office_inspect with this exact path to read slide text and notes. Start without contentOffset; read_file line ranges are not Office preview offsets.'
            : 'PPTX is a binary Office package and read_file has no PPTX text parser. This tool selection does not expose office_inspect; report the missing reader instead of treating ZIP bytes or empty output as document text.'
          return { success: false, error: 'FORMAT_READER_REQUIRED', output: JSON.stringify({ ...version, code: 'FORMAT_READER_REQUIRED', message }),
            metadata: { ...version, code: 'FORMAT_READER_REQUIRED', fileMutationApplied: false, ...(reader ? { suggestedTool: 'office_inspect' } : {}) } }
        }
        if (text === null && ['.csv', '.tsv'].includes(path.extname(canonicalPath).toLowerCase())) {
          return { success: false, error: 'TEXT_ENCODING_UNSUPPORTED',
            output: JSON.stringify({ ...version, code: 'TEXT_ENCODING_UNSUPPORTED', message: 'CSV/TSV reading requires valid UTF-8 source text. This file is binary or uses another encoding; no spreadsheet conversion or lossy decoding was attempted.' }),
            metadata: { ...version, code: 'TEXT_ENCODING_UNSUPPORTED', fileMutationApplied: false } }
        }
        if ((ctx.toolProfile === 'general' || isFileBatchReadContext(ctx)) && handler instanceof TextHandler && text !== null && (mode === 'auto' || mode === 'full')) {
          const page = readTextPage({ text, version: { ...version, byteLength: before.content.byteLength },
            maxChars: getToolOutputLimit(ctx.toolProfile, ctx), mode, startLine: start_line, endLine: end_line, startColumn: start_column })
          if (readFileVersionSync(canonicalPath).hash !== before.hash) return { success: false, output: 'File changed while being read; read it again to obtain a matching content and expectedHash.' }
          ctx.logger.info(`[read_file] ${canonicalPath} - ${before.content.byteLength}B, ${page.output.length} output chars, ${(performance.now() - startTime).toFixed(2)}ms`)
          return page
        }
        const result = await handler.read(canonicalPath, ctx, { mode, startLine: start_line, endLine: end_line })
        if (readFileVersionSync(canonicalPath).hash !== before.hash) return { success: false, output: 'File changed while being read; read it again to obtain a matching content and expectedHash.' }
        const timeMs = performance.now() - startTime
        const originalBytes = before.content.byteLength
        const outputContent = result.content || ''
        const compressedBytes = Buffer.byteLength(outputContent, 'utf8')
        const compressionRatio = originalBytes > 0 ? ((1 - compressedBytes / originalBytes) * 100).toFixed(2) + '%' : '0%'
        const report = `[读取监控] 耗时: ${timeMs.toFixed(2)}ms | 原始大小: ${originalBytes}B | 压缩后: ${compressedBytes}B | 压缩率: ${compressionRatio}`
        ctx.logger.info(`[read_file] ${canonicalPath} - ${report}`)
        // The native image contract must remain whole JSON. Prefixing the
        // display report turns pixels into text and breaks both wire adapters.
        // A file containing similar JSON cannot opt in: only the handler can.
        if (result.type === 'image_vision' && result.image) return {
          success: true, output: JSON.stringify({ ...result.image, fileVersion: version }), metadata: version,
        }
        return { success: true, output: `${report}\n[文件版本] ${JSON.stringify(version)}\n[精确编辑] 展示行号和格式化内容不是原文；edit_file 前可用 mode="exact" 获取无行号 content。\n\n${outputContent}`, metadata: version }
      })
    } catch (err) {
      return { success: false, output: `Read error: ${err instanceof Error ? err.message : 'Unknown error'}` }
    }
  },
}

const singleWriteFileTool: Tool = {
  name: 'write_file',
  displayName: '写入文件',
  description: '将数据写入指定格式的文件。保留文本、JSON 和旧版办公写入兼容。当前会话提供 office_document 时，Word/Excel 的结构化创建、版本保护和定点编辑优先使用该工具；可用 aether-office 技能提供写作与排版指引。成功返回实际落盘文件的 expectedHash，sha256: 后 64 位就是实际 SHA-256，可直接报告，无需另运行命令。后续精确文本编辑复用版本，不自行计算或猜测 hash。UTF-8 原文不确定时先 read_file mode="exact"。原地修改必须改源文件，另存副本不能替代；修改后复制使用 copyFrom:{path,expectedHash}，源版本来自最新文件回执，无需转写全文。copyFrom与data互斥，保留所有源字节并校验目标hash；目标未指定expectedHash时只创建新文件，覆盖须传目标版本。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件路径，格式按用户要求选择。Word/Excel 创建与编辑优先使用可用的 office_document 工具。' },
      expectedHash: { type: 'string', pattern: '^(missing|sha256:[a-f0-9]{64})$', description: '覆盖已有文件时传最近一次 read_file/write_file/edit_file 返回的完整文件版本；不匹配则拒绝覆盖。新文件可传 missing。共享项目写入必须使用版本条件。' },
      createOnly: { type: 'boolean', description: '为 true 时只创建不存在的文件，已有文件会被保留。' },
      copyFrom: { type: 'object', additionalProperties: false, properties: {
        path: { type: 'string', minLength: 1, description: '绑定工作区内的源文件路径；直接复制实读字节，保留BOM、换行、尾空格和二进制。' },
        expectedHash: { type: 'string', pattern: '^sha256:[a-f0-9]{64}$', description: '源文件最近一次工具回执的完整版本，变化则拒绝复制。' },
      }, required: ['path', 'expectedHash'], description: '与data互斥。目标未传expectedHash时只创建新文件；覆盖已有目标必须传目标版本。' },
      trailingNewline: { type: 'string', enum: ['preserve', 'LF', 'CRLF', 'none'], description: '普通 UTF-8 文本字符串：用户明确要求尾换行时必须显式选择 LF/CRLF/none，末尾连续 CR/LF 会变成恰好一个指定换行或零个；保留内部换行、空格、Tab、BOM。默认/preserve 逐字不变，精确复制必须省略或 preserve。JSON/Office/二进制不支持格式调整。' },
      data: { 
        type: ['string', 'object', 'array', 'number', 'boolean', 'null'],
        description: `写入数据。精确文本复制须逐字使用完整 exact content，保留尾部换行、CRLF及BOM，不 trim；例如源 content="a\\n" 时 data 也必须是 "a\\n"，不是 "a"。
- **Excel (.xlsx) - 全控模板**: 
  \`{ theme: "business", autoWidth: true, headerBg: "6B21A8", headerColor: "FFFFFF", images: [{path: "path/to/logo.png", range: "A1:B2"}], sheets: [...] }\`
  - \`headerBg/headerColor/rowAlternateBg\`: 十六进制颜色码（不带#）。
  - \`autoWidth\`: 自动适配列宽。
  - \`images\`: 插入图片，指定路径和单元格范围。
- **Word (.docx) - 全控模板**: 
  \`{ theme: "business", primaryColor: "6B21A8", font: "楷体", sections: [{ children: [{ type: "paragraph", children: [{ type: "image", path: "img.png", width: 100, height: 100 }] }] }] }\`
  - \`primaryColor\`: 控制标题、表头背景色。
  - \`font\`: 字体名称。
  - \`margin\`: 页边距对象 {top, right, bottom, left}（单位：缇，1440=1英寸）。
  - \`image\`: 在段落中插入图片。`
      } as any,
    },
    required: ['path'],
    oneOf: [{ required: ['data'], not: { required: ['copyFrom'] } }, { required: ['copyFrom'], not: { required: ['data'] } }],
  },
  async execute(rawArgs: unknown, ctx: AgentContext): Promise<ToolResult> {
    const normalized = normalizeWriteFileArgs(rawArgs)
    if (!normalized.ok) {
      return { success: false, output: normalized.error.message, error: normalized.error.code,
        metadata: { code: normalized.error.code, fileMutationApplied: false } }
    }
    const { path: filePath, data, copyFrom, usedContentAlias, expectedHash, createOnly, trailingNewline } = normalized.args
    try {
      const safePath = workspaceManager.resolveSafePath(ctx, filePath)
      const sourcePath = copyFrom ? workspaceManager.resolveSafePath(ctx, copyFrom.path) : undefined
      return await withFileLocks(sourcePath ? [safePath, sourcePath] : [safePath], async ([canonicalPath, canonicalSource]) => {
        throwIfAborted(ctx.signal)
        workspaceManager.resolveSafePath(ctx, canonicalPath)
        if (copyFrom && canonicalSource) {
          workspaceManager.resolveSafePath(ctx, canonicalSource)
          const failCopy = (code: string, message: string, details: Record<string, unknown> = {}): ToolResult => ({
            success: false, error: code, output: `${code}: ${message}`, metadata: { code, fileMutationApplied: false, ...details } })
          const samePath = (a: string, b: string) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
          if (samePath(canonicalPath, canonicalSource)) return failCopy('COPY_SAME_FILE', 'Source and destination must be different files.')
          let sourceStat: fs.Stats
          try { sourceStat = fs.statSync(canonicalSource) }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return failCopy('COPY_SOURCE_MISSING', 'The source file does not exist.')
            throw error
          }
          if (!sourceStat.isFile()) return failCopy('COPY_SOURCE_NOT_FILE', 'The source must be a regular file.')
          if (sourceStat.size > MAX_FILE_SIZE) return failCopy('COPY_SOURCE_TOO_LARGE', `Source exceeds ${MAX_FILE_SIZE} bytes.`)
          try {
            const destinationStat = fs.statSync(canonicalPath)
            if (sourceStat.ino !== 0 && sourceStat.ino === destinationStat.ino && sourceStat.dev === destinationStat.dev) {
              return failCopy('COPY_SAME_FILE', 'Source and destination refer to the same file identity.')
            }
          } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
          const source = readFileVersionSync(canonicalSource)
          if (source.content === null) return failCopy('COPY_SOURCE_MISSING', 'The source file disappeared before it could be read.')
          if (source.content.byteLength > MAX_FILE_SIZE) return failCopy('COPY_SOURCE_TOO_LARGE', `Source exceeds ${MAX_FILE_SIZE} bytes.`)
          if (source.hash !== copyFrom.expectedHash) return failCopy('COPY_SOURCE_VERSION_CONFLICT', 'Source changed; use its current file version before copying.',
            { sourcePath: canonicalSource, expectedHash: copyFrom.expectedHash, actualHash: source.hash })
          return writeConditionalFile(normalized.args, canonicalPath, ctx,
            { path: canonicalSource, submittedPath: copyFrom.path, expectedHash: source.hash, content: source.content })
        }
        let prepared = normalized.args
        if (trailingNewline !== undefined && trailingNewline !== 'preserve') {
          if (!(handlerRegistry.getHandler(canonicalPath) instanceof TextHandler) || typeof data !== 'string' ||
              decodeEditableText(canonicalPath, Buffer.from(data, 'utf8')) !== data) {
            return { success: false, error: 'WRITE_INVALID_ARGUMENTS', output: 'trailingNewline formatting requires an ordinary UTF-8 text string; JSON, Office and binary data do not support it.',
              metadata: { code: 'WRITE_INVALID_ARGUMENTS', fileMutationApplied: false } }
          }
          // Opt-in only; never trim whitespace or infer formatting from file names.
          prepared = { ...normalized.args, data: data.replace(/[\r\n]+$/, '') + (trailingNewline === 'LF' ? '\n' : trailingNewline === 'CRLF' ? '\r\n' : '') }
        }
        if (expectedHash !== undefined || createOnly === true) return writeConditionalFile(prepared, canonicalPath, ctx)
        const snapshot = await readOldSnapshot(canonicalPath)
        fs.mkdirSync(path.dirname(canonicalPath), { recursive: true })
        const handler = handlerRegistry.getHandler(canonicalPath)
        try {
          await handler.write(canonicalPath, prepared.data, ctx)
        } catch (error) {
          // Some format writers can fail after touching the destination. Keep
          // evidence of those bytes too, while preserving the failed outcome.
          try {
            if (fs.statSync(canonicalPath).size > MAX_FILE_SIZE) {
              restoreSnapshot(canonicalPath, snapshot)
              return { success: false, output: `Write failed and produced an oversized file; the original was restored: ${error instanceof Error ? error.message : String(error)}`,
                error: 'WRITE_FILE_TOO_LARGE', metadata: { code: 'WRITE_FILE_TOO_LARGE', fileMutationApplied: false } }
            }
          } catch (sizeError) {
            if ((sizeError as NodeJS.ErrnoException).code !== 'ENOENT') {
              return { success: false, output: `Write failed and its result could not be inspected: ${error instanceof Error ? error.message : String(error)}`,
                error: 'WRITE_FAILED', metadata: { code: 'WRITE_FAILED', fileMutationApplied: true, rollbackAvailable: false } }
            }
          }
          const after = await readOldSnapshot(canonicalPath)
          if (after.oldHash !== snapshot.oldHash) {
            const change = await commitWriteChange(ctx, filePath, canonicalPath, snapshot)
            return {
              success: false,
              output: `Write failed after changing ${filePath}; the actual change was recorded: ${error instanceof Error ? error.message : String(error)}`,
              change,
              metadata: { fileMutationApplied: true, rollbackAvailable: !change.truncated },
            }
          }
          throw error
        }
        const written = fs.statSync(canonicalPath)
        if (written.size > MAX_FILE_SIZE) {
          // Format writers may expand structured input substantially. Restore
          // the pre-write state before returning so a rejected oversized
          // artifact cannot leave an untracked mutation on disk.
          try {
            restoreSnapshot(canonicalPath, snapshot)
            return { success: false, output: `File too large: write_file supports files up to ${MAX_FILE_SIZE} bytes.`,
              error: 'WRITE_FILE_TOO_LARGE', metadata: { code: 'WRITE_FILE_TOO_LARGE', fileMutationApplied: false } }
          } catch (restoreError) {
            return { success: false, output: `File too large and could not be restored: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`,
              error: 'WRITE_FILE_TOO_LARGE', metadata: { code: 'WRITE_FILE_TOO_LARGE', fileMutationApplied: true, rollbackAvailable: false } }
          }
        }
        const { change, receipt } = await commitWriteChangeWithReceipt(ctx, filePath, canonicalPath, snapshot)
        // Return the recorded on-disk version: format handlers may change the input bytes.
        // Metadata alone is not sent to the model in the next tool-result message.
        return { success: true, output: `Successfully written to ${filePath}\n${formatWriteReceipt(receipt)}`, change,
          metadata: { ...receipt, fileMutationApplied: true, rollbackAvailable: !change.truncated,
            ...(usedContentAlias ? { compatibilityAlias: 'content' } : {}) } }
      })
    } catch (err) {
      return {
        success: false,
        output: `Write error: ${err instanceof Error ? err.message : 'Unknown error'}`,
        ...(err instanceof ChangeRecordingError ? { metadata: { fileMutationApplied: true, rollbackAvailable: false } } : {}),
      }
    }
  },
}

export const readFileTool: Tool = {
  ...singleReadFileTool,
  parameters: fileBatchSchema(singleReadFileTool.parameters),
  description: singleReadFileTool.description + ' 已知且互不依赖的多个文件可用 files:[{path,...}] 一次读取并返回合并回执；每项单独分页和版本，总输出受同一预算约束。图片/vision/OCR必须单独调用。',
  preflight: preflightFileReadBatch,
  execute: (args, ctx) => hasFileBatch(args) ? readFileBatch(args, ctx, singleReadFileTool) : singleReadFileTool.execute(args, ctx),
}

export const writeFileTool: Tool = {
  ...singleWriteFileTool,
  parameters: fileBatchSchema(singleWriteFileTool.parameters),
  description: singleWriteFileTool.description + ' 互不依赖的多个目标可用 files:[{path,data或copyFrom,...}] 一次写入；先全批预检，再顺序执行并合并全部回执。目标不可重复，copyFrom源不可是本批目标；不是跨文件原子事务，逐项核对成功状态。',
  preflight: preflightFileWriteBatch,
  execute: (args, ctx) => hasFileBatch(args) ? writeFileBatch(args, ctx, singleWriteFileTool) : singleWriteFileTool.execute(args, ctx),
}
