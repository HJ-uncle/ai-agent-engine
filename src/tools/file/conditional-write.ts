import fs from 'node:fs'
import path from 'node:path'
import type { AgentContext, ToolResult } from '../../core/agent-context/index.js'
import type { NormalizedWriteFileArgs } from '../../shared/write-file-args.js'
import { canonicalFilePathSync, readFileVersionSync } from '../../shared/file-version.js'
import { projectDataPath } from '../../core/project-storage.js'
import { workspaceManager } from '../../workspace/index.js'
import { throwIfAborted } from '../../core/utils/abort.js'
import { MAX_FILE_SIZE } from './constants.js'
import { handlerRegistry } from './handlers/registry.js'
import { commitWriteChangeWithReceipt, discardUnpublishedSnapshot, readOldSnapshot, type ChangeSnapshot } from './change-recorder.js'
import { formatWriteReceipt } from './write-receipt.js'
import { captureSourceFiles, resolveSourceChangeChoice, sourceChangePendingAction, type SourceChangeChoice, type SourceFileSnapshot } from '../../runtime/source-change-protocol.js'

const failure = (code: string, output: string, details: Record<string, unknown> = {}): ToolResult => ({
  success: false, error: code, output: `${code}: ${output}`, metadata: { code, fileMutationApplied: false, ...details },
})
function version(file: string): string {
  try { if (fs.statSync(file).size > MAX_FILE_SIZE) throw new Error('Conditional writes require a bounded original file') }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  return readFileVersionSync(file).hash
}

/** Internal only: obtained while the caller holds both source and target locks. */
export interface CopySourceSnapshot {
  path: string
  submittedPath: string
  expectedHash: string
  content: Buffer
}

/** Caller owns the canonical process lock. Async format generation is staged so
 * a version conflict/cancellation cannot publish partial bytes over the target.
 * This is not a filesystem lease against arbitrary external writers. */
export async function writeConditionalFile(args: NormalizedWriteFileArgs, canonicalPath: string, ctx: AgentContext, copySource?: CopySourceSnapshot): Promise<ToolResult> {
  if (args.copyFrom && !copySource) return failure('WRITE_INVALID_ARGUMENTS', 'copyFrom requires the caller to lock and validate its source snapshot.')
  const requestedExpected = args.expectedHash ?? 'missing'
  let expected = requestedExpected
  let sourceChoice: SourceChangeChoice | undefined
  const resumeAction = ctx.resumeToolCall?.pendingAction
  if (resumeAction?.type === 'source_change') sourceChoice = resolveSourceChangeChoice(resumeAction, ctx.resumeToolCall?.output)
  const initial = version(canonicalPath)
  if (initial !== expected) {
    if (!sourceChoice) return failure('WRITE_VERSION_CONFLICT', 'File changed or already exists. Read its current version before writing.', { expectedHash: expected, actualHash: initial })
    const resumedSourceAction = resumeAction?.type === 'source_change' ? resumeAction : undefined
    const frozenAfter = resumedSourceAction?.after && typeof resumedSourceAction.after === 'object'
      && Array.isArray((resumedSourceAction.after as { files?: unknown }).files) ? (resumedSourceAction.after as { files: Array<{ hash?: unknown }> }).files[0]?.hash : undefined
    if (typeof frozenAfter === 'string' && frozenAfter !== initial) {
      const after = captureSourceFiles([canonicalPath], path.dirname(canonicalPath))
      const previous = resumedSourceAction!.after as SourceFileSnapshot
      const check = { changed: true, before: previous, after,
        changes: [{ path: canonicalPath, before: previous.files[0], after: after.files[0], kind: previous.files[0].hash === 'missing' ? 'created' as const : after.files[0].hash === 'missing' ? 'deleted' as const : 'modified' as const }] }
      const pending = sourceChangePendingAction(check, { phase: 'write', operation: 'write_file' })
      return { success: false, status: 'waiting', needsConfirmation: true, output: '恢复前源码又发生变化，请重新选择处理方式；未写入目标文件。',
        error: 'SOURCE_CHANGED_DURING_WRITE', pendingAction: pending, metadata: { code: 'SOURCE_CHANGED_DURING_WRITE', fileMutationApplied: false } }
    }
    if (sourceChoice === 'pause') return { success: false, status: 'interrupted', output: '已暂停写入：外部源码变化仍需重新检查。', error: 'SOURCE_CHANGE_PAUSED', metadata: { sourceChange: { choice: sourceChoice, risk: false }, fileMutationApplied: false } }
    if (sourceChoice === 'recheck') return failure('WRITE_VERSION_CONFLICT', '已重新检查到新版本；请使用最新文件版本再次提交写入。', { expectedHash: expected, actualHash: initial, sourceChange: { choice: sourceChoice, risk: false } })
    // rebuild and skip are explicit choices. Both use the observed current
    // version as their new base; skip is retained as a visible risk receipt.
    expected = initial
  }
  let baseline: SourceFileSnapshot
  try { baseline = captureSourceFiles([canonicalPath], path.dirname(canonicalPath)) }
  catch (error) { return failure('SOURCE_SNAPSHOT_FAILED', error instanceof Error ? error.message : String(error)) }
  let snapshot: ChangeSnapshot | undefined, staging: string | undefined, published = false
  try {
    snapshot = await readOldSnapshot(canonicalPath)
    if (snapshot.oldHash !== expected) {
      if (sourceChoice) {
        const after = captureSourceFiles([canonicalPath], path.dirname(canonicalPath))
        const check = { changed: true, before: baseline, after, changes: [{ path: canonicalPath,
          before: baseline.files[0], after: after.files[0], kind: baseline.files[0].hash === 'missing' ? 'created' as const : after.files[0].hash === 'missing' ? 'deleted' as const : 'modified' as const }] }
        const pending = sourceChangePendingAction(check, { phase: 'write', operation: 'write_file' })
        return { success: false, status: 'waiting', needsConfirmation: true, output: '恢复写入前源码再次变化，请重新选择处理方式；未写入目标文件。',
          error: 'SOURCE_CHANGED_DURING_WRITE', pendingAction: pending, metadata: { code: 'SOURCE_CHANGED_DURING_WRITE', previousChoice: sourceChoice, fileMutationApplied: false } }
      }
      return failure('WRITE_VERSION_CONFLICT', 'File changed while preparing its rollback snapshot.', { expectedHash: expected, actualHash: snapshot.oldHash })
    }
    const root = workspaceManager.resolveSafePath(ctx, projectDataPath(workspaceManager.getWorkingDirectory(ctx), 'tmp', 'file-writes'))
    fs.mkdirSync(root, { recursive: true })
    const safeRoot = workspaceManager.resolveSafePath(ctx, fs.realpathSync.native(root))
    const ownedStage: string = fs.mkdtempSync(path.join(safeRoot, 'write-'))
    staging = ownedStage
    const temporary = path.join(ownedStage, path.basename(canonicalPath))
    try {
      if (copySource) fs.writeFileSync(temporary, copySource.content)
      else await handlerRegistry.getHandler(canonicalPath).write(temporary, args.data, ctx)
    }
    catch (error) { return failure('WRITE_FORMAT_FAILED', error instanceof Error ? error.message : String(error)) }
    throwIfAborted(ctx.signal)
    if (!fs.statSync(temporary).isFile() || fs.statSync(temporary).size > MAX_FILE_SIZE) return failure('WRITE_FILE_TOO_LARGE', 'Generated file exceeds the conditional write size limit; original bytes were preserved.')
    workspaceManager.resolveSafePath(ctx, canonicalPath)
    const samePath = (left: string, right: string) => process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
    const submittedPath = workspaceManager.resolveSafePath(ctx, args.path)
    if (!samePath(canonicalFilePathSync(canonicalPath), canonicalPath) || !samePath(canonicalFilePathSync(submittedPath), canonicalPath)) return failure('WRITE_PATH_CONFLICT', 'Target path changed during format generation.')
    const current = version(canonicalPath)
    if (current !== expected) {
      const after = captureSourceFiles([canonicalPath], path.dirname(canonicalPath))
      const check = { changed: true, before: baseline, after, changes: [{ path: canonicalPath,
        before: baseline.files[0], after: after.files[0], kind: baseline.files[0].hash === 'missing' ? 'created' as const : after.files[0].hash === 'missing' ? 'deleted' as const : 'modified' as const }] }
      const pending = sourceChangePendingAction(check, { phase: 'write', operation: 'write_file' })
      return { success: false, status: 'waiting', needsConfirmation: true,
        output: sourceChoice ? '恢复写入期间源码再次变化，请重新选择处理方式；未写入目标文件。' : '写入期间检测到外部源码变化。请选择 pause、recheck、rebuild 或 skip；未写入目标文件。',
        error: 'SOURCE_CHANGED_DURING_WRITE', pendingAction: pending,
        metadata: { code: 'SOURCE_CHANGED_DURING_WRITE', previousChoice: sourceChoice, fileMutationApplied: false } }
    }
    if (copySource) {
      const resolvedSource = workspaceManager.resolveSafePath(ctx, copySource.submittedPath)
      workspaceManager.resolveSafePath(ctx, copySource.path)
      if (!samePath(canonicalFilePathSync(resolvedSource), copySource.path) || !samePath(canonicalFilePathSync(copySource.path), copySource.path)) {
        return failure('COPY_SOURCE_PATH_CONFLICT', 'Source path changed while preparing the copy.')
      }
      let sourceStat: fs.Stats
      try { sourceStat = fs.statSync(copySource.path) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return failure('COPY_SOURCE_MISSING', 'Source disappeared while preparing the copy.')
        throw error
      }
      if (!sourceStat.isFile()) return failure('COPY_SOURCE_NOT_FILE', 'Source is no longer a regular file.')
      if (sourceStat.size > MAX_FILE_SIZE) return failure('COPY_SOURCE_TOO_LARGE', 'Source now exceeds the copy size limit.')
      const currentSource = readFileVersionSync(copySource.path)
      if (currentSource.content !== null && currentSource.content.byteLength > MAX_FILE_SIZE) return failure('COPY_SOURCE_TOO_LARGE', 'Source now exceeds the copy size limit.')
      if (currentSource.hash !== copySource.expectedHash) return failure('COPY_SOURCE_VERSION_CONFLICT', 'Source changed while preparing the copy; destination was preserved.',
        { sourcePath: copySource.path, expectedHash: copySource.expectedHash, actualHash: currentSource.hash })
      throwIfAborted(ctx.signal)
    }
    // There is no await from the final version read to publication. Hard-link
    // creation is atomic create-only even if a non-cooperating writer races it.
    if (expected === 'missing') {
      fs.mkdirSync(path.dirname(canonicalPath), { recursive: true })
      try { fs.linkSync(temporary, canonicalPath) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') return failure('WRITE_VERSION_CONFLICT', 'Another writer created the destination; its bytes were preserved.', { expectedHash: expected })
        throw error
      }
    } else fs.renameSync(temporary, canonicalPath)
    published = true
    const { change, receipt } = await commitWriteChangeWithReceipt(ctx, args.path, canonicalPath, snapshot)
    if (copySource && receipt.expectedHash !== copySource.expectedHash) return {
      success: false, error: 'COPY_VERIFICATION_FAILED',
      output: `COPY_VERIFICATION_FAILED: The observed destination bytes do not match the source snapshot.\n${formatWriteReceipt(receipt)}`,
      change, metadata: { ...receipt, code: 'COPY_VERIFICATION_FAILED', sourcePath: copySource.path, sourceExpectedHash: copySource.expectedHash,
        copyVerified: false, fileMutationApplied: true, rollbackAvailable: !change.truncated } }
    const confirmation = copySource
      ? `Successfully copied to ${args.path}\nsourcePath: ${copySource.path}\nsourceExpectedHash: ${copySource.expectedHash}\ncopyVerified: true`
      : `Successfully written to ${args.path}`
    const sourceChange = sourceChoice ? { choice: sourceChoice, risk: sourceChoice === 'skip' } : undefined
    return { success: true, output: `${confirmation}\n${formatWriteReceipt(receipt)}` + (sourceChange ? `\n[source-change] choice=${sourceChoice}; risk=${sourceChange.risk}` : ''), change,
      metadata: { ...receipt, fileMutationApplied: true, rollbackAvailable: !change.truncated,
        ...(sourceChange ? { sourceChange } : {}),
        ...(copySource ? { sourcePath: copySource.path, sourceExpectedHash: copySource.expectedHash, copyVerified: true } : {}),
        ...(args.usedContentAlias ? { compatibilityAlias: 'content' } : {}) } }
  } finally {
    if (snapshot && !published) discardUnpublishedSnapshot(snapshot)
    if (staging) {
      const parent = path.dirname(staging)
      if (!path.basename(staging).startsWith('write-') || path.dirname(parent).split(path.sep).pop() !== 'tmp') throw new Error('Invalid owned write staging path')
      try { fs.rmSync(staging, { recursive: true, force: true }) }
      catch (error) { ctx.logger.warn({ err: error }, 'Conditional write temporary cleanup failed') }
    }
  }
}
