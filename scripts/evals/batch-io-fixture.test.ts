import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it } from 'vitest'
import { Document, Packer, Paragraph } from 'docx'
import ExcelJS from 'exceljs'
import { captureProviderToolEvidence, checkBatchFiles, checkBatchFilesContract, checkBatchFilesFirstPass, checkBatchOffice, setupBatchFiles,
  setupBatchOfficeInspect, batchOfficeInspectHashes, checkBatchOfficeInspect, officeInspectFactsCorrect } from './batch-io-fixture.js'
import { officeInspectTool } from '../../src/tools/office/index.js'
import type { AgentContext } from '../../src/core/agent-context/index.js'
const PptxGenJS: typeof import('pptxgenjs').default = createRequire(import.meta.url)('pptxgenjs')

const roots: string[] = []
function workspace() { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-io-eval-')); roots.push(root); return root }
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })
let serial = 0
function batch(names: string[], tool: string, operation?: string) {
  const calls = names.map(name => ({ role: 'assistant', toolCall: { id: `call-${++serial}`, name: tool,
    args: { path: name, ...(operation ? { operation } : {}) } } }))
  return [...calls, ...calls.map(message => ({ role: 'tool', toolCallId: message.toolCall.id,
    metadata: { success: true, status: 'succeeded' } }))]
}
function allChecksPass(check: Record<string, unknown>) { return Object.values(check).filter(value => typeof value === 'boolean').every(Boolean) }

function fileFixture() {
  const root = workspace(), names = ['a', 'b', 'c', 'd', 'e', 'f'].map(letter => `${letter}.txt`)
  setupBatchFiles(root)
  names.forEach(name => fs.writeFileSync(path.join(root, `out-${name}`), `${Number(fs.readFileSync(path.join(root, name), 'utf8')) * 2}\n`))
  return { workspace: root, turnFinalAnswers: ['六个结果总和为488。'], messages: [
    ...fileBatch(root, names, 'read_file'), ...fileBatch(root, names.map(name => `out-${name}`), 'write_file'),
  ] }
}
function fileBatch(root: string, names: string[], tool: string): any[] {
  const rows: any[] = batch(names, tool)
  for (const message of rows.filter(message => message.toolCall)) {
    const call = message.toolCall, content = fs.readFileSync(path.join(root, call.args.path), 'utf8')
    if (tool === 'write_file') Object.assign(call.args, { data: content.replace(/\n$/, ''), trailingNewline: 'LF' })
    const result = rows.find(result => result.toolCallId === call.id)
    Object.assign(result.metadata, { path: path.join(root, call.args.path),
      expectedHash: `sha256:${createHash('sha256').update(content, 'utf8').digest('hex')}` })
  }
  return rows
}

function explicitFileBatch(root: string, names: string[], tool: string): any[] {
  const singles = fileBatch(root, names, tool), id = `batch-${++serial}`
  const args = { files: singles.filter(row => row.toolCall).map(row => row.toolCall.args) }
  const receipts = singles.filter(row => row.role === 'tool')
  const files = receipts.map(row => ({ path: row.metadata.path, success: true, output: { content: fs.readFileSync(row.metadata.path, 'utf8'), expectedHash: row.metadata.expectedHash } }))
  return [{ role: 'assistant', toolCall: { id, name: tool, args } },
    { role: 'tool', toolCallId: id, content: JSON.stringify({ batch: true, files }),
      metadata: { success: true, status: 'succeeded', batch: true, files: receipts.map(row => ({ ...row.metadata, success: true })) } }]
}
function withWireEvidence(current: any, format = 'anthropic'): any {
  const attempts: any[] = [{ attempt: 1, toolCount: 2, ...captureProviderToolEvidence({ messages: [] }) }]
  const history: any[] = []
  for (const row of current.messages) {
    if (row.toolCall) history.push(format === 'anthropic'
      ? { role: 'assistant', content: [{ type: 'tool_use', id: row.toolCall.id, name: row.toolCall.name, input: row.toolCall.args }] }
      : { role: 'assistant', tool_calls: [{ id: row.toolCall.id, function: { name: row.toolCall.name, arguments: JSON.stringify(row.toolCall.args) } }] })
    else if (row.role === 'tool') {
      history.push(format === 'anthropic'
        ? { role: 'user', content: [{ type: 'tool_result', tool_use_id: row.toolCallId, content: row.content }] }
        : { role: 'tool', tool_call_id: row.toolCallId, content: row.content })
      attempts.push({ attempt: attempts.length + 1, toolCount: 2, ...captureProviderToolEvidence({ messages: history }) })
    }
  }
  return { ...current, attempts }
}

function explicitFixture(count = 6, format = 'anthropic') {
  const current = fileFixture(), names = ['a', 'b', 'c', 'd', 'e', 'f'].slice(0, count).map(letter => `${letter}.txt`)
  current.messages = [...explicitFileBatch(current.workspace, names, 'read_file'), ...explicitFileBatch(current.workspace, names.map(name => `out-${name}`), 'write_file')]
  current.turnFinalAnswers = [count === 3 ? '166' : '488']
  return withWireEvidence(current, format)
}

async function officeFixture() {
  const root = workspace()
  const facts = '甲组完成12项。乙组完成30项。合计42项。合计项为甲组与乙组完成项数之和，共42项。'
  await fs.promises.writeFile(path.join(root, 'batch.docx'), await Packer.toBuffer(new Document({
    sections: [{ children: [new Paragraph(facts)] }],
  })))
  const deck = new PptxGenJS()
  deck.addSlide().addText(facts, { x: 1, y: 1, w: 7, h: 2 })
  deck.addSlide().addText(facts, { x: 1, y: 1, w: 7, h: 2 })
  await deck.writeFile({ fileName: path.join(root, 'batch.pptx') })
  const book = new ExcelJS.Workbook(), sheet = book.addWorksheet('事实')
  sheet.addRows([['组别', '完成项数'], ['甲组', 12], ['乙组', 30], ['合计', { formula: 'SUM(B2:B3)', result: 42 }]])
  await book.xlsx.writeFile(path.join(root, 'batch.xlsx'))
  const names = ['batch.docx', 'batch.pptx', 'batch.xlsx']
  const deliveryId = `delivery-${++serial}`
  return { workspace: root, messages: [
    ...batch(names, 'office_document', 'create'), ...batch(['batch.xlsx'], 'office_document', 'recalculate'),
    { role: 'assistant', toolCall: { id: deliveryId, name: 'deliver_files', args: { items: names.map(name => ({ path: name })) } } },
    { role: 'tool', toolCallId: deliveryId, metadata: { success: true, status: 'succeeded' } },
  ] as any[], postconditions: { deliveries: [{ publishedAt: 1, items: names.map(name => ({ path: path.join(root, name),
    sha256: createHash('sha256').update(fs.readFileSync(path.join(root, name))).digest('hex') })) }] } }
}

describe('batch I/O evaluation acceptance', () => {
  it('matches Office table columns and every file row, rejecting wrong numbers and misleading context', () => {
    const table = '| 文件 | 识别码 | 甲组 | 乙组 | 合计 |\n|---|---|---|---|---|\n'
      + '| inspect.docx | WORD-EVAL-317 | 12 | 30 | 42 |\n'
      + '| inspect.xlsx | SHEET-EVAL-683（A1） | 12（B2） | 30（B3） | 42（B4） |\n'
      + '| inspect.pptx | SLIDES-EVAL-529 | 12 | 30 | 42 |'
    expect(officeInspectFactsCorrect(table)).toBe(true)
    expect(officeInspectFactsCorrect('甲组12，乙组30，合计42。')).toBe(true)
    for (const bad of [table.replace('| 12 |', '| 112 |'), table.replace('30（B3）', '130（B3）'),
      table.replace('42（B4）', '142（B4）'), table.replace('| 甲组 | 乙组 |', '| 乙组 | 甲组 |'),
      table.replace('inspect.pptx', 'inspect.docx'), table.split('\n').slice(0, -1).join('\n'),
      table.replace('12（B2）', '12 或 99'), table.replace('30（B3）', '30-130'),
      table.replace('| 12 | 30 | 42 |', '| 99 | 30 | 42 |') + '\n甲组12，乙组30，合计42。']) {
      expect(officeInspectFactsCorrect(bad), bad).toBe(false)
    }
  })

  it('distinguishes one explicit 3/6-file invocation from several calls in one model response', () => {
    for (const count of [3, 6]) for (const format of ['anthropic', 'openai']) {
      const current = explicitFixture(count, format), check = checkBatchFilesContract(current, count)
      expect(allChecksPass(check)).toBe(true)
      expect(check).toMatchObject({ physicalProviderRequests: 3, modelToolBatches: 2, toolInvocations: 2,
        readBatch: { maxFilesPerCall: count, invocations: 1 }, writeBatch: { maxFilesPerCall: count, invocations: 1 } })
      if (count === 6) expect(allChecksPass(checkBatchFilesFirstPass(current))).toBe(true)
    }
    const legacy = fileFixture()
    expect(checkBatchFilesContract(legacy)).toMatchObject({ sixExactOutputs: true, sixReadsInOneModelResponse: true,
      allReadsInOneExplicitCall: false, allWritesInOneExplicitCall: false, completeReadReceiptInNextRequest: false })
  })

  it('rejects missing, split, duplicated or truncated output in the first next request despite correct files', () => {
    for (const defect of ['missing', 'partial', 'duplicate', 'late', 'absent-wire']) {
      const current = explicitFixture(), firstResult = current.attempts[1].requestToolResults[0]
      if (defect === 'missing' || defect === 'late') current.attempts[1].requestToolResults = []
      if (defect === 'partial') Object.assign(firstResult, { bytes: 12, sha256: '0'.repeat(64) })
      if (defect === 'duplicate') current.attempts[1].requestToolResults.push({ ...firstResult })
      if (defect === 'absent-wire') current.attempts = []
      expect(checkBatchFilesContract(current), defect).toMatchObject({ sixExactOutputs: true, completeReadReceiptInNextRequest: false })
    }
  })

  it('does not accept individual failures or mismatched paths as a successful aggregate', () => {
    for (const defect of ['failed', 'path', 'missing-output', 'duplicate-target', 'mixed-single-batch']) {
      const current = explicitFixture(), result = current.messages[1], output = JSON.parse(result.content)
      if (defect === 'failed') output.files[1].success = false
      if (defect === 'path') output.files[1].path = output.files[0].path
      if (defect === 'missing-output') output.files.splice(1, 1)
      if (defect === 'duplicate-target') current.messages[0].toolCall.args.files[1].path = current.messages[0].toolCall.args.files[0].path
      if (defect === 'mixed-single-batch') current.messages[0].toolCall.args.path = 'a.txt'
      result.content = JSON.stringify(output)
      expect(checkBatchFilesContract(current), defect).toMatchObject({ sixExactOutputs: true, allReadsInOneExplicitCall: false })
    }
  })

  it('verifies real small Office inspection content, hashes and the complete provider receipt', async () => {
    const root = workspace()
    await setupBatchOfficeInspect(root)
    const seededOfficeHashes = batchOfficeInspectHashes(root)
    const args = { files: ['inspect.docx', 'inspect.xlsx', 'inspect.pptx'].map(name => ({ path: path.join(root, name) })) }
    const ctx = { tenantId: 'batch-eval', sessionId: 'batch-eval', projectRoot: root, cwd: root, workspacePaths: [root], toolProfile: 'general',
      tools: { preflight: async () => undefined } } as unknown as AgentContext
    const result = await officeInspectTool.execute(args, ctx)
    expect(result.success, result.output).toBe(true)
    const current = withWireEvidence({ workspace: root, seededOfficeHashes, turnFinalAnswers: ['WORD-EVAL-317、SHEET-EVAL-683、SLIDES-EVAL-529；甲组12，乙组30，合计42。'], messages: [
      { role: 'assistant', toolCall: { id: 'office-batch', name: 'office_inspect', args } },
      { role: 'tool', toolCallId: 'office-batch', content: result.output, metadata: { ...result.metadata, success: true, status: 'succeeded' } },
    ] })
    expect(allChecksPass(checkBatchOfficeInspect(current)), result.output).toBe(true)
    const missingContent = structuredClone(current), envelope = JSON.parse(missingContent.messages[1].content)
    envelope.files[1].output.content = ''
    missingContent.messages[1].content = JSON.stringify(envelope)
    expect(checkBatchOfficeInspect(missingContent)).toMatchObject({ inspectionContentVerified: false, completeInspectionReceiptInNextRequest: false })
    fs.appendFileSync(path.join(root, 'inspect.docx'), 'modified')
    expect(checkBatchOfficeInspect(current)).toMatchObject({ originalOfficeBytesUnchanged: false })
  }, 15_000)

  it('accepts first-pass bytes and hashes with zero or one later batch of verification reads', () => {
    const current = fileFixture()
    expect(allChecksPass(checkBatchFilesFirstPass(current))).toBe(true)
    const outputs = ['a', 'b', 'c', 'd', 'e', 'f'].map(letter => `out-${letter}.txt`)
    current.messages.push(...fileBatch(current.workspace, outputs, 'read_file'))
    expect(checkBatchFilesFirstPass(current)).toMatchObject({ atMostOneBatchedVerification: true, verificationBatchCount: 1 })
    expect(allChecksPass(checkBatchFilesFirstPass(current))).toBe(true)
    current.messages.push(...fileBatch(current.workspace, outputs, 'read_file'))
    expect(checkBatchFilesFirstPass(current)).toMatchObject({ atMostOneBatchedVerification: false, verificationBatchCount: 2 })
  })

  it('allows one input-preservation check but rejects duplicate targets and a second verification batch', () => {
    const current = fileFixture(), inputs = ['a', 'b', 'c', 'd', 'e', 'f'].map(letter => `${letter}.txt`)
    const verified = { ...current, messages: [...current.messages, ...fileBatch(current.workspace, inputs, 'read_file')] }
    expect(allChecksPass(checkBatchFilesFirstPass(verified))).toBe(true)
    const mixed = { ...current, messages: [...current.messages, ...fileBatch(current.workspace, ['a.txt', 'out-a.txt'], 'read_file')] }
    expect(allChecksPass(checkBatchFilesFirstPass(mixed))).toBe(true)
    const duplicate = { ...current, messages: [...current.messages, ...fileBatch(current.workspace, ['a.txt', './a.txt'], 'read_file')] }
    expect(checkBatchFilesFirstPass(duplicate)).toMatchObject({ atMostOneBatchedVerification: false, verificationBatchCount: 1 })
    verified.messages.push(...fileBatch(current.workspace, ['a.txt'], 'read_file'))
    expect(checkBatchFilesFirstPass(verified)).toMatchObject({ atMostOneBatchedVerification: false, verificationBatchCount: 2 })
    const wrongHash = structuredClone(mixed)
    wrongHash.messages.at(-1).metadata.expectedHash = `sha256:${'0'.repeat(64)}`
    expect(checkBatchFilesFirstPass(wrongHash)).toMatchObject({ atMostOneBatchedVerification: false })
    const premature = { ...current, messages: [...current.messages.slice(0, 12),
      ...fileBatch(current.workspace, ['a.txt'], 'read_file'), ...current.messages.slice(12)] }
    expect(checkBatchFilesFirstPass(premature)).toMatchObject({ sixInitialReadsSucceededTogether: false })
  })

  it('uses explicit newline semantics independently without trimming other source bytes', () => {
    const current = fileFixture()
    const write = current.messages.find(message => message.toolCall?.name === 'write_file').toolCall
    for (const suffix of ['', '\n', '\r\n', '\r\n\n\r']) {
      write.args.data = `38${suffix}`
      expect(allChecksPass(checkBatchFilesFirstPass(current))).toBe(true)
    }
    for (const value of ['38 \n', '38\t\r\n', '\uFEFF38\n', '3\n8\n', '38\\n']) {
      write.args.data = value
      expect(checkBatchFilesFirstPass(current)).toMatchObject({ sixFirstWriteArgumentsExact: false, sixExactOutputs: true })
    }
    write.args.data = '38\n'
    for (const trailingNewline of [undefined, 'preserve']) {
      write.args.trailingNewline = trailingNewline
      expect(checkBatchFilesFirstPass(current)).toMatchObject({ sixFirstWriteArgumentsExact: true, sixFirstWritesExplicitLF: false })
    }
    for (const trailingNewline of ['CRLF', 'none', 'invalid']) {
      write.args.trailingNewline = trailingNewline
      expect(checkBatchFilesFirstPass(current)).toMatchObject({ sixFirstWriteArgumentsExact: false, sixFirstWritesExplicitLF: false })
    }
    write.args.trailingNewline = 'LF'
    write.args.content = '38'
    delete write.args.data
    expect(allChecksPass(checkBatchFilesFirstPass(current))).toBe(true)
    write.args.data = '999'
    expect(checkBatchFilesFirstPass(current)).toMatchObject({ sixFirstWriteArgumentsExact: false })
  })

  it('does not let correct final files hide incorrect first writes or later repair', () => {
    const current = fileFixture()
    const write = current.messages.find(message => message.toolCall?.name === 'write_file').toolCall
    delete write.args.trailingNewline
    const result = current.messages.find(message => message.toolCallId === write.id)
    result.metadata.expectedHash = `sha256:${createHash('sha256').update('38').digest('hex')}`
    expect(allChecksPass(checkBatchFiles(current))).toBe(true)
    expect(checkBatchFilesFirstPass(current)).toMatchObject({ sixFirstWriteArgumentsExact: false,
      sixFirstWriteReceiptsMatch: false, sixExactOutputs: true })
    current.messages.push(...fileBatch(current.workspace, ['out-a.txt'], 'write_file'))
    expect(checkBatchFilesFirstPass(current)).toMatchObject({ noCorrectiveFileMutations: false, sixFirstWriteReceiptsMatch: false })
    const edited = fileFixture()
    edited.messages.push(...batch(['out-a.txt'], 'edit_file'))
    expect(checkBatchFilesFirstPass(edited)).toMatchObject({ noCorrectiveFileMutations: false })
  })

  it('binds first-write success to the correct call, path, hash and run scope', () => {
    for (const mutation of ['hash', 'path', 'missingHash', 'failed', 'duplicateId', 'scope', 'priorFailure']) {
      const current = fileFixture()
      const message = current.messages.find(message => message.toolCall?.name === 'write_file')
      const result = current.messages.find(row => row.toolCallId === message.toolCall.id)
      if (mutation === 'hash') result.metadata.expectedHash = `sha256:${'0'.repeat(64)}`
      if (mutation === 'path') result.metadata.path = path.join(current.workspace, 'out-b.txt')
      if (mutation === 'missingHash') delete result.metadata.expectedHash
      if (mutation === 'failed') Object.assign(result.metadata, { success: false, status: 'failed' })
      if (mutation === 'duplicateId') current.messages.find(row => row.toolCall?.args.path === 'out-b.txt').toolCall.id = message.toolCall.id
      if (mutation === 'scope') { message.metadata = { rootRunId: 'one' }; result.metadata.rootRunId = 'other' }
      if (mutation === 'priorFailure') current.messages.splice(current.messages.indexOf(result), 0,
        { role: 'tool', toolCallId: message.toolCall.id, metadata: { success: false, status: 'failed' } })
      expect(checkBatchFilesFirstPass(current), mutation).toMatchObject({ sixFirstWriteReceiptsMatch: false })
    }
  })

  it('rejects partial, duplicate, sequential and unverified read coverage', () => {
    const current = fileFixture(), inputs = ['a', 'b', 'c', 'd', 'e', 'f'].map(letter => `${letter}.txt`)
    const writes = current.messages.filter(message => message.toolCall?.name === 'write_file'
      || message.role === 'tool' && message.metadata.path.includes('out-'))
    const sequential = { ...current, messages: [...inputs.flatMap(name => fileBatch(current.workspace, [name], 'read_file')), ...writes] }
    expect(checkBatchFilesFirstPass(sequential)).toMatchObject({ sixInitialReadsSucceededTogether: false })
    const badHash = structuredClone(current)
    badHash.messages.find(message => message.role === 'tool').metadata.expectedHash = `sha256:${'0'.repeat(64)}`
    expect(checkBatchFilesFirstPass(badHash)).toMatchObject({ sixInitialReadsSucceededTogether: false })
    const duplicate = { ...current, messages: [...fileBatch(current.workspace, inputs.map(() => 'a.txt'), 'read_file'), ...writes] }
    expect(checkBatchFilesFirstPass(duplicate)).toMatchObject({ sixInitialReadsSucceededTogether: false })
    fs.writeFileSync(path.join(current.workspace, 'unrelated.txt'), 'unrelated\n')
    const unrelated = { ...current, messages: [...current.messages, ...fileBatch(current.workspace, ['unrelated.txt'], 'read_file')] }
    expect(checkBatchFilesFirstPass(unrelated)).toMatchObject({ atMostOneBatchedVerification: false })
  })

  it('requires all six distinct expected paths with successful receipts in one response', () => {
    const root = workspace(), names = ['a', 'b', 'c', 'd', 'e', 'f'].map(letter => `${letter}.txt`)
    setupBatchFiles(root)
    names.forEach(name => fs.writeFileSync(path.join(root, `out-${name}`), `${Number(fs.readFileSync(path.join(root, name), 'utf8')) * 2}\n`))
    const current = { workspace: root, turnFinalAnswers: ['488'], messages: [
      ...batch(names.map(name => path.join(root, '.', name)), 'read_file'),
      ...batch(names.map(name => `out-${name}`), 'write_file'),
    ] as any[] }
    expect(allChecksPass(checkBatchFiles(current))).toBe(true)
    const duplicates = structuredClone(current)
    duplicates.messages.filter(message => message.toolCall?.name === 'read_file')
      .forEach(message => { message.toolCall.args.path = './a.txt' })
    expect(checkBatchFiles(duplicates)).toMatchObject({ sixReadsInOneModelResponse: false, maxReadBatch: 1 })
    const failed = structuredClone(current)
    failed.messages.find(message => message.role === 'tool')!.metadata = { success: false, status: 'failed' }
    expect(checkBatchFiles(failed)).toMatchObject({ sixReadsInOneModelResponse: false, maxReadBatch: 5 })
    const sequential = { ...current, messages: [...names.flatMap(name => batch([name], 'read_file')),
      ...names.flatMap(name => batch([`out-${name}`], 'write_file'))] }
    expect(checkBatchFiles(sequential)).toMatchObject({ sixExactOutputs: true, sixReadsInOneModelResponse: false,
      sixWritesInOneModelResponse: false, maxReadBatch: 1, maxWriteBatch: 1 })
  })

  it('accepts real Office artifacts and rejects duplicate creates, bad delivery, and missing recalculation', async () => {
    const current = await officeFixture()
    expect(allChecksPass(await checkBatchOffice(current))).toBe(true)
    const duplicates = structuredClone(current)
    duplicates.messages.filter(message => message.toolCall?.args.operation === 'create')
      .forEach(message => { message.toolCall.args.path = 'batch.docx' })
    expect(await checkBatchOffice(duplicates)).toMatchObject({ threeCreatesInOneModelResponse: false, maxCreateBatch: 1 })
    const wrongDelivery = structuredClone(current)
    wrongDelivery.postconditions.deliveries[0].items[1].path = wrongDelivery.postconditions.deliveries[0].items[0].path
    expect(await checkBatchOffice(wrongDelivery)).toMatchObject({ threeFinalItems: false, deliveredHashesMatch: false })
    const wrongHash = structuredClone(current)
    wrongHash.postconditions.deliveries[0].items[0].sha256 = '0'.repeat(64)
    expect(await checkBatchOffice(wrongHash)).toMatchObject({ deliveredHashesMatch: false })
    const noRecalculation = structuredClone(current)
    const call = noRecalculation.messages.find(message => message.toolCall?.args.operation === 'recalculate')!.toolCall
    noRecalculation.messages.find(message => message.toolCallId === call.id)!.metadata = { success: false, status: 'failed' }
    expect(await checkBatchOffice(noRecalculation)).toMatchObject({ spreadsheetRecalculatedBeforeDelivery: false,
      spreadsheetCachesVerified: false })
  }, 20_000)

  it('rejects digit-substring facts and a cached total that does not match its formula', async () => {
    const current = await officeFixture()
    await fs.promises.writeFile(path.join(current.workspace, 'batch.docx'), await Packer.toBuffer(new Document({
      sections: [{ children: [new Paragraph('甲组完成112项。乙组完成130项。合计142项。')] }],
    })))
    const book = new ExcelJS.Workbook(); await book.xlsx.readFile(path.join(current.workspace, 'batch.xlsx'))
    book.getWorksheet('事实')!.getCell('B4').value = { formula: 'SUM(B2:B2)', result: 42 }
    await book.xlsx.writeFile(path.join(current.workspace, 'batch.xlsx'))
    // Refresh hashes so this tests content validation independently of manifest validation.
    for (const item of current.postconditions.deliveries[0].items) item.sha256 = createHash('sha256').update(fs.readFileSync(item.path)).digest('hex')
    expect(await checkBatchOffice(current)).toMatchObject({ wordFacts: false, deliveredHashesMatch: true,
      spreadsheetCachesVerified: false, formulaValidation: { cacheMismatches: ['事实!B4'] } })
  }, 10_000)
})
