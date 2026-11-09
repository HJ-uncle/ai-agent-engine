import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'

export const copyFirstPassPrompt = '读取 input.txt，把其中 beta 原地替换为 gamma，其他内容保持原样，再复制保存为 output.txt。计算 output.txt 的 SHA-256 并报告。'

function workspaceFile(workspace: string, candidate: unknown): string | undefined {
  if (typeof candidate !== 'string' || !candidate) return undefined
  try {
    const root = fs.realpathSync(workspace), file = fs.realpathSync(path.resolve(root, candidate))
    const relative = path.relative(root, file)
    if (!relative || path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)
      || !fs.statSync(file).isFile()) return undefined
    return process.platform === 'win32' ? file.toLowerCase() : file
  } catch { return undefined }
}

/** Verify the first copy's recorded bytes, rather than accepting a later repair. */
export function checkCopyFirstPass(current: any, expectedBytes: Uint8Array): Record<string, unknown> {
  const expected = Buffer.from(expectedBytes), sha256 = createHash('sha256').update(expected).digest('hex')
  const expectedHash = `sha256:${sha256}`
  const input = workspaceFile(current.workspace, 'input.txt'), output = workspaceFile(current.workspace, 'output.txt')
  const messages: any[] = current.messages || []
  const records = messages.flatMap((message, index) => message.role === 'assistant' && message.toolCall
    ? [{ call: message.toolCall, index, message, resultIndex: messages.findIndex((result, resultIndex) => resultIndex > index
      && result.role === 'tool' && result.toolCallId === message.toolCall.id) }] : [])
  type CallRecord = typeof records[number]
  const targetOf = (record: CallRecord) => workspaceFile(current.workspace, record.call.args?.path)
  const receiptMatches = (record: CallRecord | undefined, target: string | undefined): boolean => {
    if (!record || !target || record.resultIndex < 0 || typeof record.call.id !== 'string' || !record.call.id
      || records.filter(candidate => candidate.call.id === record.call.id).length !== 1) return false
    const result = messages[record.resultIndex]
    return result.metadata?.success === true && result.metadata?.status === 'succeeded'
      && (!result.toolName || result.toolName === record.call.name)
      && ['rootRunId', 'turnId'].every(key => !record.message.metadata?.[key] || !result.metadata?.[key]
        || record.message.metadata[key] === result.metadata[key])
      && workspaceFile(current.workspace, result.metadata?.path) === target
      && result.metadata?.expectedHash === expectedHash
  }
  const inputEdits = records.filter(record => record.call.name === 'edit_file' && input && targetOf(record) === input)
  const inputWrites = records.filter(record => record.call.name === 'write_file' && input && targetOf(record) === input)
  const outputWrites = records.filter(record => record.call.name === 'write_file' && output && targetOf(record) === output)
  const outputEdits = records.filter(record => record.call.name === 'edit_file' && output && targetOf(record) === output)
  const edit = inputEdits[0], copy = outputWrites[0], copyFrom = copy?.call.args?.copyFrom
  const copyFromMatches = !!input && !!copyFrom && typeof copyFrom === 'object' && !Array.isArray(copyFrom)
    && workspaceFile(current.workspace, copyFrom.path) === input && copyFrom.expectedHash === expectedHash
    && !Object.hasOwn(copy!.call.args, 'data') && !Object.hasOwn(copy!.call.args, 'content')
  // A successful edit receipt is itself a source version. An optional later
  // read is also valid, but neither may be borrowed from after the copy call.
  const observedVersion = records.findLast(record => ['read_file', 'edit_file'].includes(record.call.name)
    && edit && copy && record.index >= edit.index && record.resultIndex < copy.index
    && receiptMatches(record, input))
  const outputBytes = output ? fs.readFileSync(output) : undefined
  const finalText = current.turnFinalAnswers?.at(-1) ?? current.answer ?? ''
  return {
    exists: !!outputBytes,
    exact: !!outputBytes?.equals(expected),
    inputEdited: !!input && fs.readFileSync(input).equals(expected),
    reportedHashCorrect: typeof finalText === 'string' && finalText.toLowerCase().includes(sha256),
    inputEditedOnce: inputEdits.length === 1 && inputWrites.length === 0 && receiptMatches(edit, input),
    inputEditCompletedBeforeCopy: !!edit && !!copy && edit.resultIndex >= 0 && edit.resultIndex < copy.index,
    firstOutputUsesVersionedCopy: copyFromMatches,
    modifiedSourceVersionObservedBeforeCopy: !!observedVersion,
    firstOutputReceiptMatches: receiptMatches(copy, output),
    noOutputCorrection: outputWrites.length === 1 && outputEdits.length === 0,
    sha256, expectedBytes: expected.length, actualBytes: outputBytes?.length,
    firstCopyEvidence: { callId: copy?.call.id, referencedSourceCallId: observedVersion?.call.id,
      sourceExpectedHash: copyFrom?.expectedHash, resultExpectedHash: copy ? messages[copy.resultIndex]?.metadata?.expectedHash : undefined },
  }
}
