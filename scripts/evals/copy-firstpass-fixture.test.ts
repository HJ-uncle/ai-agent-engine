import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { checkCopyFirstPass, copyFirstPassPrompt } from './copy-firstpass-fixture.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })
const hash = (text: string | Buffer) => `sha256:${createHash('sha256').update(text).digest('hex')}`
let serial = 0
function operation(workspace: string, name: string, args: Record<string, unknown>, resultHash: string): any[] {
  const id = `copy-case-${++serial}`, metadata = { rootRunId: 'copy-run', turnId: 'copy-turn' }
  return [
    { role: 'assistant', metadata, toolCall: { id, name, args } },
    { role: 'tool', toolCallId: id, toolName: name, metadata: { ...metadata, success: true, status: 'succeeded',
      path: path.resolve(workspace, String(args.path)), expectedHash: resultHash } },
  ]
}
function fixture(source = '\uFEFF开头\r\nbeta\r\n末尾🙂\r\n\r\n') {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'copy-firstpass-eval-')); roots.push(workspace)
  const expectedBytes = Buffer.from(source.replace('beta', 'gamma'), 'utf8'), expectedHash = hash(expectedBytes)
  fs.writeFileSync(path.join(workspace, 'input.txt'), expectedBytes)
  fs.writeFileSync(path.join(workspace, 'output.txt'), expectedBytes)
  const current = { workspace, turnFinalAnswers: [`SHA-256: ${expectedHash.slice(7)}`], messages: [
    ...operation(workspace, 'read_file', { path: 'input.txt', mode: 'exact' }, hash(source)),
    ...operation(workspace, 'edit_file', { path: 'input.txt', expectedHash: hash(source), edits: [{ oldText: 'beta', newText: 'gamma' }] }, expectedHash),
    ...operation(workspace, 'write_file', { path: 'output.txt', copyFrom: { path: './input.txt', expectedHash }, expectedHash: 'missing' }, expectedHash),
  ] }
  return { current, expectedBytes, expectedHash }
}
function passed(check: Record<string, unknown>): boolean { return Object.values(check).filter(value => typeof value === 'boolean').every(Boolean) }

describe('first-pass exact copy acceptance', () => {
  it.each(['\uFEFF开头\r\nbeta\r\n末尾🙂\r\n\r\n', '开头🙂\nbeta\n末尾  '])('preserves exact bytes for %j', source => {
    const { current, expectedBytes } = fixture(source)
    expect(passed(checkCopyFirstPass(current, expectedBytes))).toBe(true)
    expect(copyFirstPassPrompt).toBe('读取 input.txt，把其中 beta 原地替换为 gamma，其他内容保持原样，再复制保存为 output.txt。计算 output.txt 的 SHA-256 并报告。')
  })

  it('accepts either the successful edit version or a subsequent successful source read', () => {
    const { current, expectedBytes, expectedHash } = fixture()
    const reread = operation(current.workspace, 'read_file', { path: path.join(current.workspace, 'input.txt'), mode: 'exact' }, expectedHash)
    current.messages.splice(4, 0, ...reread)
    expect(checkCopyFirstPass(current, expectedBytes)).toMatchObject({ modifiedSourceVersionObservedBeforeCopy: true,
      firstCopyEvidence: { referencedSourceCallId: reread[0].toolCall.id } })
    expect(passed(checkCopyFirstPass(current, expectedBytes))).toBe(true)
  })

  it('rejects reconstructed data, conflicting payloads, stale versions and wrong source paths', () => {
    for (const mutation of ['dataOnly', 'data', 'content', 'stale', 'wrongPath']) {
      const { current, expectedBytes } = fixture(), args = current.messages[4].toolCall.args
      if (mutation === 'dataOnly') { delete args.copyFrom; args.data = expectedBytes.toString('utf8') }
      if (mutation === 'data') args.data = expectedBytes.toString('utf8')
      if (mutation === 'content') args.content = expectedBytes.toString('utf8')
      if (mutation === 'stale') args.copyFrom.expectedHash = current.messages[1].metadata.expectedHash
      if (mutation === 'wrongPath') args.copyFrom.path = 'output.txt'
      expect(checkCopyFirstPass(current, expectedBytes), mutation).toMatchObject({ exact: true, firstOutputUsesVersionedCopy: false })
    }
  })

  it('does not accept final-byte correctness as proof of a correct first copy receipt', () => {
    for (const mutation of ['hash', 'path', 'failure', 'scope', 'duplicateId', 'priorFailure']) {
      const { current, expectedBytes } = fixture(), result = current.messages[5]
      if (mutation === 'hash') result.metadata.expectedHash = hash('wrong first copy')
      if (mutation === 'path') result.metadata.path = path.join(current.workspace, 'input.txt')
      if (mutation === 'failure') Object.assign(result.metadata, { success: false, status: 'failed' })
      if (mutation === 'scope') result.metadata.rootRunId = 'other-run'
      if (mutation === 'duplicateId') current.messages[0].toolCall.id = current.messages[4].toolCall.id
      if (mutation === 'priorFailure') current.messages.splice(5, 0, { role: 'tool', toolCallId: result.toolCallId,
        metadata: { success: false, status: 'failed' } })
      expect(checkCopyFirstPass(current, expectedBytes), mutation).toMatchObject({ exact: true, firstOutputReceiptMatches: false })
    }
  })

  it('requires the successful modified source version before the copy invocation', () => {
    const { current, expectedBytes } = fixture()
    const beforeEdit = { ...current, messages: [current.messages[0], current.messages[1], current.messages[4], current.messages[5], current.messages[2], current.messages[3]] }
    expect(checkCopyFirstPass(beforeEdit, expectedBytes)).toMatchObject({ inputEditCompletedBeforeCopy: false, modifiedSourceVersionObservedBeforeCopy: false })
    const earlyCopy = { ...current, messages: [current.messages[0], current.messages[1], current.messages[2], current.messages[4], current.messages[3], current.messages[5]] }
    expect(checkCopyFirstPass(earlyCopy, expectedBytes)).toMatchObject({ inputEditCompletedBeforeCopy: false, modifiedSourceVersionObservedBeforeCopy: false })
    current.messages[3].metadata.expectedHash = hash('stale source')
    expect(checkCopyFirstPass(current, expectedBytes)).toMatchObject({ inputEditedOnce: false, modifiedSourceVersionObservedBeforeCopy: false })
  })

  it('rejects output repairs and repeated source mutations even if final files are exact', () => {
    for (const [name, target] of [['write_file', 'output.txt'], ['edit_file', 'output.txt'], ['edit_file', 'input.txt'], ['write_file', 'input.txt']]) {
      const { current, expectedBytes, expectedHash } = fixture()
      current.messages.push(...operation(current.workspace, name, { path: target }, expectedHash))
      const check = checkCopyFirstPass(current, expectedBytes)
      expect(check).toMatchObject({ exact: true, inputEdited: true })
      expect(passed(check)).toBe(false)
      expect(target === 'input.txt' ? check.inputEditedOnce : check.noOutputCorrection).toBe(false)
    }
  })

  it('checks final source and target bytes including BOM, repeated endings and trailing spaces', () => {
    for (const source of ['\uFEFF开头\r\nbeta\r\n末尾🙂\r\n\r\n', '开头🙂\nbeta\n末尾  ']) {
      const { current, expectedBytes } = fixture(source)
      fs.writeFileSync(path.join(current.workspace, 'output.txt'), expectedBytes.toString('utf8').trim())
      expect(checkCopyFirstPass(current, expectedBytes)).toMatchObject({ exact: false, inputEdited: true, firstOutputReceiptMatches: true })
      fs.writeFileSync(path.join(current.workspace, 'input.txt'), source)
      expect(checkCopyFirstPass(current, expectedBytes)).toMatchObject({ inputEdited: false })
      current.turnFinalAnswers = ['done']
      expect(checkCopyFirstPass(current, expectedBytes)).toMatchObject({ reportedHashCorrect: false })
    }
  })
})
