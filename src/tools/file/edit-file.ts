import fs from 'node:fs'
import type { AgentContext, Tool, ToolResult } from '../../core/agent-context/index.js'
import { workspaceManager } from '../../workspace/index.js'
import { hashFileContent, readFileVersionSync, withFileLocks } from '../../shared/file-version.js'
import { throwIfAborted } from '../../core/utils/abort.js'
import { ChangeRecordingError, commitWriteChange, decodeEditableText, MAX_CHANGE_CONTENT_BYTES, type ChangeSnapshot } from './change-recorder.js'

interface TextEdit { oldText: string; newText: string }
interface EditFileArgs { path: string; expectedHash: string; edits: TextEdit[] }

function failure(code: string, message: string, metadata: Record<string, unknown> = {}): ToolResult {
  return { success: false, output: `${code}: ${message}`, error: code,
    metadata: { code, fileMutationApplied: false, ...metadata } }
}

function validArgs(value: unknown): value is EditFileArgs {
  if (!value || typeof value !== 'object') return false
  const args = value as EditFileArgs
  return typeof args.path === 'string' && args.path.trim().length > 0 &&
    typeof args.expectedHash === 'string' && /^sha256:[a-f0-9]{64}$/.test(args.expectedHash) &&
    Array.isArray(args.edits) && args.edits.length > 0 && args.edits.every(edit => edit &&
      typeof edit.oldText === 'string' && edit.oldText.length > 0 && typeof edit.newText === 'string')
}

export const editFileTool: Tool = {
  name: 'edit_file', displayName: '精确编辑文件',
  description: '对已有 UTF-8 文本文件做精确替换（修改前后均不超过 100000 bytes）。先 read_file mode="exact" 获取完整字节 expectedHash 和无行号 content；正文必须逐字匹配，保留 CRLF、Unicode 和 BOM，不自动格式化。所有 edits 都匹配同一原文件：每个 oldText 必须非空且唯一，多项不可重叠。版本不一致、匹配不存在或不唯一时整次修改失败，不猜位置。',
  parameters: {
    type: 'object', additionalProperties: false,
    properties: {
      path: { type: 'string', minLength: 1, description: '目标文件路径，使用 read_file 返回的 path。' },
      expectedHash: { type: 'string', pattern: '^sha256:[a-f0-9]{64}$', description: 'read_file 返回的完整文件字节 SHA-256 版本，不是片段 hash。' },
      edits: { type: 'array', minItems: 1, description: '在同一原文件上同时定位；不使用前一个替换产生的内容定位后一个。', items: {
        type: 'object', additionalProperties: false,
        properties: {
          oldText: { type: 'string', minLength: 1, description: '无行号的精确原文。必须在原文件中仅出现一次，换行和空白也必须相同。' },
          newText: { type: 'string', description: '替换后的原文，可为空以删除该片段；需要保留的 CRLF/BOM 请原样保留。' },
        }, required: ['oldText', 'newText'],
      } },
    }, required: ['path', 'expectedHash', 'edits'],
  },
  async execute(rawArgs: unknown, ctx: AgentContext): Promise<ToolResult> {
    if (!validArgs(rawArgs)) return failure('EDIT_INVALID_ARGUMENTS', 'Expected path, a sha256 expectedHash, and one or more non-empty oldText/newText pairs.')
    const args = rawArgs
    try {
      const target = workspaceManager.resolveSafePath(ctx, args.path)
      return await withFileLocks([target], async ([canonicalPath]) => {
        throwIfAborted(ctx.signal)
        workspaceManager.resolveSafePath(ctx, canonicalPath)
        let stat: fs.Stats
        try { stat = fs.statSync(canonicalPath) }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return failure('EDIT_FILE_MISSING', 'The file does not exist; use write_file to create it.')
          throw error
        }
        if (!stat.isFile()) return failure('EDIT_NOT_TEXT', 'Exact editing requires a regular text file, not a directory or device.')
        if (stat.size > MAX_CHANGE_CONTENT_BYTES) return failure('EDIT_FILE_TOO_LARGE', `Exact editing supports at most ${MAX_CHANGE_CONTENT_BYTES} bytes so every edit can be reviewed and reverted.`)
        const before = readFileVersionSync(canonicalPath)
        if (!before.content) return failure('EDIT_FILE_MISSING', 'The file does not exist; use write_file to create it.')
        if (before.hash !== args.expectedHash) return failure('EDIT_VERSION_CONFLICT', 'File changed after it was read. Read it again before editing.', {
          expectedHash: args.expectedHash, actualHash: before.hash,
        })
        if (before.content.byteLength > MAX_CHANGE_CONTENT_BYTES) return failure('EDIT_FILE_TOO_LARGE', `Exact editing supports at most ${MAX_CHANGE_CONTENT_BYTES} bytes so every edit can be reviewed and reverted.`)
        const original = decodeEditableText(canonicalPath, before.content)
        if (original === null) return failure('EDIT_NOT_TEXT', 'The file must be valid UTF-8 text, without binary content.')

        const matches: Array<{ start: number; end: number; newText: string; index: number }> = []
        for (const [index, edit] of args.edits.entries()) {
          const start = original.indexOf(edit.oldText)
          if (start < 0) return failure('EDIT_NO_MATCH', `edits[${index}].oldText does not occur in the original file.`, { editIndex: index })
          // Search from the next character, not the end, so overlapping duplicate matches are ambiguous too.
          if (original.indexOf(edit.oldText, start + 1) >= 0) return failure('EDIT_AMBIGUOUS_MATCH', `edits[${index}].oldText occurs more than once; supply a larger unique context.`, { editIndex: index })
          matches.push({ start, end: start + edit.oldText.length, newText: edit.newText, index })
        }
        matches.sort((a, b) => a.start - b.start)
        for (let index = 1; index < matches.length; index++) {
          if (matches[index].start < matches[index - 1].end) return failure('EDIT_OVERLAPPING_MATCHES', 'Two edits refer to overlapping original text; combine them into one replacement.', {
            editIndices: [matches[index - 1].index, matches[index].index],
          })
        }
        let updated = original
        for (const match of [...matches].reverse()) updated = updated.slice(0, match.start) + match.newText + updated.slice(match.end)
        const afterBytes = Buffer.from(updated, 'utf8')
        if (afterBytes.toString('utf8') !== updated || afterBytes.includes(0)) return failure('EDIT_NOT_TEXT', 'Replacement must remain valid UTF-8 text without binary content.')
        if (afterBytes.byteLength > MAX_CHANGE_CONTENT_BYTES) return failure('EDIT_FILE_TOO_LARGE', `The edited file would exceed ${MAX_CHANGE_CONTENT_BYTES} bytes; no changes were written.`)
        if (before.content.equals(afterBytes)) return { success: true, output: `No change: ${canonicalPath}\nexpectedHash: ${before.hash}`, metadata: { noChange: true, oldHash: before.hash, newHash: before.hash } }

        // No await from the full-byte version read above through this write. In-process
        // editor writes, agent writes and reverts also hold this canonical path lock.
        throwIfAborted(ctx.signal)
        const snapshot: ChangeSnapshot = { oldContent: original, oldHash: before.hash, exists: true, truncated: false }
        try { fs.writeFileSync(canonicalPath, afterBytes) }
        catch (error) {
          const actual = readFileVersionSync(canonicalPath)
          if (actual.hash !== before.hash) {
            const change = await commitWriteChange(ctx, args.path, canonicalPath, snapshot)
            return { success: false, error: 'EDIT_WRITE_FAILED', output: `Write failed after changing the file; its actual bytes were recorded: ${error instanceof Error ? error.message : String(error)}`,
              change, metadata: { code: 'EDIT_WRITE_FAILED', fileMutationApplied: true, rollbackAvailable: !change.truncated } }
          }
          throw error
        }
        const change = await commitWriteChange(ctx, args.path, canonicalPath, snapshot)
        return { success: true, output: `Edited ${canonicalPath}: ${matches.length} replacement(s)\nexpectedHash: ${hashFileContent(afterBytes)}`,
          change, metadata: { oldHash: before.hash, newHash: change.newHash, replacements: matches.length, fileMutationApplied: true, rollbackAvailable: !change.truncated } }
      })
    } catch (error) {
      if (error instanceof ChangeRecordingError) return failure('EDIT_RECORD_FAILED', error.message, { fileMutationApplied: true, rollbackAvailable: false })
      return failure('EDIT_FAILED', error instanceof Error ? error.message : String(error))
    }
  },
}
