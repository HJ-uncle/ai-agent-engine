import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import ExcelJS from 'exceljs'
import { Document, Packer, Paragraph } from 'docx'
import mammoth from 'mammoth'
import { unzipSync } from 'fflate'
import { decodeXml } from '../../src/tools/office/office-zip.js'
import { recalculateXlsx } from '../../src/tools/office/recalculate.js'
const PptxGenJS: typeof import('pptxgenjs').default = createRequire(import.meta.url)('pptxgenjs')

/** ReAct saves all calls from a response before any of their results. */
export function modelToolBatches(messages: any[]): any[][] {
  const batches: any[][] = []
  let calls: any[] = []
  for (const message of messages) {
    if (message.role === 'assistant' && message.toolCall) calls.push(message.toolCall)
    else if (calls.length) { batches.push(calls); calls = [] }
  }
  if (calls.length) batches.push(calls)
  return batches
}

/** Match real files inside the isolated workspace, including Windows path aliases. */
function workspaceFile(workspace: string, candidate: unknown): string | undefined {
  if (typeof candidate !== 'string' || !candidate) return undefined
  try {
    const root = fs.realpathSync.native(workspace), file = fs.realpathSync.native(path.resolve(root, candidate))
    const relative = path.relative(root, file)
    if (!relative || path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)
      || !fs.statSync(file).isFile()) return undefined
    return process.platform === 'win32' ? file.toLowerCase() : file
  } catch { return undefined }
}

function executionEvidence(current: any) {
  const messages: any[] = current.messages || []
  const rawRecords = messages.flatMap((message, index) => message.role === 'assistant' && message.toolCall
    ? [{ call: message.toolCall, index, resultIndex: messages.findIndex((result, resultIndex) => resultIndex > index
      && result.role === 'tool' && result.toolCallId === message.toolCall.id
      && (result.metadata?.batch === true || result.metadata?.success === true && result.metadata?.status === 'succeeded')
      && (!result.toolName || result.toolName === message.toolCall.name)
      && ['rootRunId', 'turnId'].every(key => !message.metadata?.[key] || !result.metadata?.[key]
        || message.metadata[key] === result.metadata[key])) }] : [])
  // A model invocation can contain several tool calls; a single tool call can
  // now contain several files. Keep those two boundaries distinct in evidence.
  const records = rawRecords.flatMap(record => {
    const result = messages[record.resultIndex]
    if (!Array.isArray(record.call.args?.files)) return [{ ...record, parentCall: record.call, result }]
    let envelope: any
    try { envelope = JSON.parse(result?.content) } catch { /* A malformed receipt cannot prove success. */ }
    return record.call.args.files.map((args: any, itemIndex: number) => {
      const item = result?.metadata?.files?.[itemIndex], output = envelope?.files?.[itemIndex]
      const target = workspaceFile(current.workspace, args?.path)
      const succeeded = !!target && item?.success === true && output?.success === true
        && workspaceFile(current.workspace, item.path) === target && workspaceFile(current.workspace, output.path) === target
      return { ...record, parentCall: record.call, call: { ...record.call, args }, itemIndex,
        resultIndex: succeeded ? record.resultIndex : -1,
        result: { ...result, content: typeof output?.output === 'string' ? output.output : JSON.stringify(output?.output), metadata: item } }
    })
  })
  const batches = modelToolBatches(messages)
  const coverage = (name: string, names: string[], operation?: string) => {
    const expected = names.map(file => workspaceFile(current.workspace, file))
    const count = (batch: any[], successful: boolean) => new Set(records.filter(record => batch.includes(record.parentCall)
      && record.call.name === name && (!operation || record.call.args?.operation === operation)
      && (!successful || record.resultIndex >= 0))
      .map(record => workspaceFile(current.workspace, record.call.args?.path))
      .filter(file => file !== undefined && expected.includes(file))).size
    const proposed = Math.max(0, ...batches.map(batch => count(batch, false)))
    const succeeded = Math.max(0, ...batches.map(batch => count(batch, true)))
    return { proposed, succeeded, complete: expected.every(Boolean) && succeeded === names.length }
  }
  return { records, rawRecords, coverage, batches: batches.map(batch => batch.map(call => ({ name: call.name,
    path: call.args?.path, operation: call.args?.operation,
    filesCount: Array.isArray(call.args?.files) ? call.args.files.length : 0,
    paths: Array.isArray(call.args?.files) ? call.args.files.map((file: any) => file.path) : undefined,
    succeeded: records.filter(record => record.parentCall === call).every(record => record.resultIndex >= 0) }))) }
}

const contentDigest = (content: string) => ({ sha256: createHash('sha256').update(content, 'utf8').digest('hex'), bytes: Buffer.byteLength(content, 'utf8') })

/** Observe the actual fetch body without storing file contents or credentials. */
export function captureProviderToolEvidence(body: any): Record<string, unknown> {
  const requestToolCalls: any[] = [], requestToolResults: any[] = []
  const argsOf = (value: unknown) => { try { return typeof value === 'string' ? JSON.parse(value) : value } catch { return undefined } }
  const call = (id: unknown, name: unknown, raw: unknown) => {
    if (typeof id !== 'string') return
    const args = argsOf(raw)
    requestToolCalls.push({ id, name, filesCount: Array.isArray(args?.files) ? args.files.length : 0 })
  }
  const result = (id: unknown, value: unknown) => {
    if (typeof id !== 'string') return
    const text = typeof value === 'string' ? value : Array.isArray(value) && value.every(part => part?.type === 'text' && typeof part.text === 'string')
      ? value.map(part => part.text).join('\n') : undefined
    requestToolResults.push({ id, ...(text === undefined ? { unsupportedContent: true } : contentDigest(text)) })
  }
  for (const message of [...(Array.isArray(body.messages) ? body.messages : []), ...(Array.isArray(body.input) ? body.input : [])]) {
    for (const item of message.tool_calls || []) call(item.id, item.function?.name, item.function?.arguments)
    if (message.role === 'tool') result(message.tool_call_id, message.content)
    if (message.type === 'function_call') call(message.call_id, message.name, message.arguments)
    if (message.type === 'function_call_output') result(message.call_id, message.output)
    for (const item of Array.isArray(message.content) ? message.content : []) {
      if (item.type === 'tool_use') call(item.id, item.name, item.input)
      if (item.type === 'tool_result') result(item.tool_use_id, item.content)
    }
  }
  return { requestToolCalls, requestToolResults }
}

/** The first outgoing body carrying a newly emitted call must already contain
 * its complete result. Later historical retransmission is not another batch. */
function nextRequestReceipt(current: any, record: any) {
  const attempts: any[] = current.attempts || []
  const index = attempts.findIndex(attempt => attempt.requestToolCalls?.some((call: any) => call.id === record.call.id))
  const result = current.messages[record.resultIndex]
  const expected = typeof result?.content === 'string' ? contentDigest(result.content) : undefined
  const delivered = index >= 0 ? attempts[index].requestToolResults?.filter((item: any) => item.id === record.call.id) || [] : []
  return { callId: record.call.id, nextRequest: index >= 0 ? attempts[index].attempt ?? index + 1 : null,
    complete: index > 0 && !!expected && delivered.length === 1 && delivered[0].sha256 === expected.sha256 && delivered[0].bytes === expected.bytes,
    expectedBytes: expected?.bytes, deliveredBytes: delivered[0]?.bytes }
}

function explicitBatchEvidence(current: any, name: string, names: string[]) {
  const evidence = executionEvidence(current), expected = names.map(file => workspaceFile(current.workspace, file))
  const records = evidence.rawRecords.filter(record => record.call.name === name)
  const complete = records.filter(record => {
    const files = record.call.args?.files
    const targets = Array.isArray(files) ? files.map((file: any) => workspaceFile(current.workspace, file.path)) : []
    const succeeded = evidence.records.filter(item => item.parentCall === record.call && item.resultIndex >= 0)
    return record.call.args?.path === undefined && expected.every(Boolean) && targets.length === names.length
      && new Set(targets).size === names.length && targets.every(target => expected.includes(target)) && succeeded.length === names.length
  })
  const chosen = complete[0]
  return { complete: !!chosen, receipt: chosen ? nextRequestReceipt(current, chosen) : { complete: false },
    invocations: records.length, maxFilesPerCall: Math.max(0, ...records.map(record => record.call.args?.files?.length || 0)) }
}

function providerBatchStatistics(current: any) {
  const attempts: any[] = current.attempts || [], evidence = executionEvidence(current)
  return { physicalProviderRequests: attempts.length, workProviderRequests: attempts.filter(item => item.toolCount > 0).length,
    modelToolBatches: evidence.batches.length, toolInvocations: evidence.rawRecords.length,
    providerRequests: attempts.map(item => ({ attempt: item.attempt, toolCount: item.toolCount, inputTokens: item.providerTotalInput,
      requestToolCalls: item.requestToolCalls, requestToolResults: item.requestToolResults })) }
}

/** The next numeric value after each fact label must match, not merely contain its digits. */
function labelledFacts(text: string): boolean {
  const expected: Record<string, number> = { '甲组': 12, '乙组': 30, '合计': 42, '总计': 42 }
  // Restrict the connector to a label/value expression. In a sentence such as
  // “合计为甲组与乙组完成项数之和，共42项”, 42 is not the value of 乙组.
  const facts = [...text.matchAll(/(甲组|乙组|合计|总计)[\s：:|—-]*(?:(?:完成(?:了|项数)?|完成数|项数|数量|共|为|是|总数|数值)[\s：:|—-]*)*(\d+(?:\.\d+)?)/g)]
  return ['甲组', '乙组'].every(label => facts.some(match => match[1] === label))
    && facts.some(match => ['合计', '总计'].includes(match[1]))
    && facts.every(match => Number(match[2]) === expected[match[1]])
}
const values = [19, 23, 41, 47, 53, 61]
export const batchFilesPrompt = '读取 a.txt、b.txt、c.txt、d.txt、e.txt、f.txt（每份只有一行整数，不足10字节）。分别把各文件数字乘2，写入 out-a.txt 至 out-f.txt：每份只写结果数字和一个换行。输入保持原样，最后报告六个结果的总和。'
export const batchThreeFilesPrompt = '读取 a.txt、b.txt、c.txt（每份只有一行整数，不足10字节）。分别把各文件数字乘2，写入 out-a.txt、out-b.txt、out-c.txt：每份只写结果数字和一个换行。输入保持原样，最后报告三个结果的总和。'
export function setupBatchFiles(workspace: string, count = 6): void {
  values.slice(0, count).forEach((value, index) => fs.writeFileSync(path.join(workspace, `${String.fromCharCode(97 + index)}.txt`), `${value}\n`))
}
export function checkBatchFiles(current: any, count = 6): Record<string, unknown> {
  const evidence = executionEvidence(current)
  const selected = values.slice(0, count), label = count === 3 ? 'three' : 'six'
  const inputs = selected.map((_, index) => `${String.fromCharCode(97 + index)}.txt`)
  const reads = evidence.coverage('read_file', inputs)
  const writes = evidence.coverage('write_file', inputs.map(name => `out-${name}`))
  return {
    inputsUnchanged: selected.every((value, index) => {
      const file = workspaceFile(current.workspace, inputs[index])
      return !!file && fs.readFileSync(file, 'utf8') === `${value}\n`
    }),
    [`${label}ExactOutputs`]: selected.every((value, index) => {
      const file = path.join(current.workspace, `out-${String.fromCharCode(97 + index)}.txt`)
      return fs.existsSync(file) && fs.readFileSync(file, 'utf8') === `${value * 2}\n`
    }),
    sumCorrect: new RegExp(`\\b${selected.reduce((sum, value) => sum + value * 2, 0)}\\b`).test(current.turnFinalAnswers.at(-1) || ''),
    [`${label}ReadsInOneModelResponse`]: reads.complete,
    [`${label}WritesInOneModelResponse`]: writes.complete,
    maxReadBatch: reads.succeeded, maxWriteBatch: writes.succeeded,
    proposedReadTargets: reads.proposed, proposedWriteTargets: writes.proposed,
    batches: evidence.batches,
  }
}

/** Stronger than the historical same-response check: one files[] invocation
 * per stage and one complete receipt in its first subsequent provider body. */
export function checkBatchFilesContract(current: any, count = 6): Record<string, unknown> {
  const inputs = values.slice(0, count).map((_, index) => `${String.fromCharCode(97 + index)}.txt`)
  const reads = explicitBatchEvidence(current, 'read_file', inputs)
  const writes = explicitBatchEvidence(current, 'write_file', inputs.map(name => `out-${name}`))
  return { ...checkBatchFiles(current, count), allReadsInOneExplicitCall: reads.complete, allWritesInOneExplicitCall: writes.complete,
    completeReadReceiptInNextRequest: reads.receipt.complete, completeWriteReceiptInNextRequest: writes.receipt.complete,
    readBatch: reads, writeBatch: writes, ...providerBatchStatistics(current) }
}

/** Final bytes alone cannot distinguish a correct first pass from repeated repair. */
export function checkBatchFilesFirstPass(current: any): Record<string, unknown> {
  const baseline = checkBatchFiles(current), evidence = executionEvidence(current)
  const messages: any[] = current.messages || [], batches = modelToolBatches(messages)
  const inputs = values.map((value, index) => ({ name: `${String.fromCharCode(97 + index)}.txt`, text: `${value}\n` }))
  const outputs = inputs.map((input, index) => ({ name: `out-${input.name}`, text: `${values[index] * 2}\n` }))
  const hash = (text: string) => `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`
  const targets = [...inputs, ...outputs].map(file => ({ ...file, path: workspaceFile(current.workspace, file.name), hash: hash(file.text) }))
  const inputTargets = targets.slice(0, values.length), outputTargets = targets.slice(values.length)
  type CallRecord = typeof evidence.records[number]
  const targetOf = (record: CallRecord) => workspaceFile(current.workspace, record.call.args?.path)
  const batchOf = (record: CallRecord) => batches.findIndex(batch => batch.includes(record.parentCall))
  const receiptMatches = (record: CallRecord, target: typeof targets[number]) => {
    const result = record.result
    // Bind identity, chronology and the recorded post-operation hash. Never use
    // today's disk hash as evidence of what the first write actually produced.
    return !!target.path && typeof record.call.id === 'string' && !!record.call.id
      && evidence.rawRecords.filter(candidate => candidate.call.id === record.call.id).length === 1
      && record.resultIndex >= 0 && messages.findIndex((message, index) => index > record.index
        && message.role === 'tool' && message.toolCallId === record.call.id) === record.resultIndex
      && workspaceFile(current.workspace, result.metadata?.path) === target.path
      && result.metadata?.expectedHash === target.hash
  }
  // Independent acceptance oracle: explicitly requested terminators replace
  // only the final CR/LF run, never spaces, tabs, BOM or internal line endings.
  const submittedBytes = (args: any): Buffer | undefined => {
    const data = args?.data === undefined ? args?.content : args.data
    if (typeof data !== 'string') return undefined
    if (args.trailingNewline === undefined || args.trailingNewline === 'preserve') return Buffer.from(data, 'utf8')
    const endings: Record<string, string> = { LF: '\n', CRLF: '\r\n', none: '' }
    const ending = endings[args.trailingNewline]
    return ending === undefined ? undefined : Buffer.from(data.replace(/[\r\n]+$/, '') + ending, 'utf8')
  }
  const reads = evidence.records.filter(record => record.call.name === 'read_file')
  const writes = evidence.records.filter(record => record.call.name === 'write_file')
  const firstWrites = outputTargets.map(target => target.path ? writes.find(record => targetOf(record) === target.path) : undefined)
  const firstWriteEvidence = outputTargets.map((target, index) => {
    const record = firstWrites[index], bytes = submittedBytes(record?.call.args)
    return { path: target.name, callId: record?.call.id, expectedHash: target.hash,
      explicitLF: record?.call.args?.trailingNewline === 'LF',
      argumentsExact: !!bytes && bytes.equals(Buffer.from(target.text, 'utf8')),
      receiptMatches: !!record && receiptMatches(record, target),
      batch: record ? batchOf(record) : -1 }
  })
  const firstWriteIndex = Math.min(Infinity, ...firstWrites.filter(record => !!record).map(record => record.index))
  const lastWriteResult = Math.max(-1, ...firstWrites.filter(record => !!record).map(record => record.resultIndex))
  const initialReads = reads.filter(record => record.index < firstWriteIndex)
  const subsequentReads = reads.filter(record => record.index >= firstWriteIndex)
  const initialReadTargets = initialReads.map(targetOf)
  const initialReadsExact = initialReads.length === inputs.length && new Set(initialReads.map(batchOf)).size === 1
    && inputTargets.every(target => !!target.path && initialReadTargets.filter(file => file === target.path).length === 1)
    && initialReads.every(record => {
      const target = inputTargets.find(target => target.path && target.path === targetOf(record))
      return !!target && receiptMatches(record, target) && record.resultIndex < firstWriteIndex
    })
  const verificationBatches = new Set(subsequentReads.map(batchOf))
  const atMostOneBatchedVerification = verificationBatches.size <= 1
    && new Set(subsequentReads.map(targetOf)).size === subsequentReads.length
    && subsequentReads.every(record => {
      // The task also requires unchanged inputs, so one verification batch may
      // check either side of the operation against its independently known hash.
      const target = targets.find(target => target.path && target.path === targetOf(record))
      return !!target && record.index > lastWriteResult && receiptMatches(record, target)
    })
  return { ...baseline,
    sixInitialReadsSucceededTogether: initialReadsExact,
    sixFirstWritesExplicitLF: firstWriteEvidence.every(record => record.explicitLF),
    sixFirstWriteArgumentsExact: firstWriteEvidence.every(record => record.argumentsExact),
    sixFirstWriteReceiptsMatch: firstWriteEvidence.every(record => record.receiptMatches),
    sixFirstWritesSucceededTogether: firstWriteEvidence.every(record => record.receiptMatches && record.batch >= 0)
      && new Set(firstWriteEvidence.map(record => record.batch)).size === 1,
    noCorrectiveFileMutations: writes.length === outputs.length && evidence.records.every(record => record.call.name !== 'edit_file'),
    atMostOneBatchedVerification,
    firstWriteEvidence, verificationBatchCount: verificationBatches.size,
  }
}

export const batchOfficePrompt = '生成三份简单办公文件，统一主题“批量验收”：batch.docx 是一页说明，batch.pptx 是两页简报，batch.xlsx 是一张事实表。只使用这三条已知事实：甲组完成12项、乙组完成30项、合计42项。Excel合计格保留SUM公式并重算；Word/PPT包含相同数字。内容已确定，无需查项目目录或询问，完成后交付这三份。'
export const batchOfficeInspectPrompt = '只读检查 inspect.docx、inspect.xlsx、inspect.pptx 这三份很小的办公文件，汇总每份内的识别码，以及甲组、乙组、合计数字。不要修改任何文件，不需要生成交付物。'
const inspectFiles = ['inspect.docx', 'inspect.xlsx', 'inspect.pptx']
const inspectMarkers = ['WORD-EVAL-317', 'SHEET-EVAL-683', 'SLIDES-EVAL-529']
/** Match the value under each labelled column for every named document. A
 * correct number elsewhere, a swapped column or duplicate row is not proof. */
export function officeInspectFactsCorrect(answer: string): boolean {
  const clean = (value: string) => value.trim().replace(/[`*_]/g, '')
  const cells = (line: string) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(clean)
  const lines = answer.split(/\r?\n/), rows: string[][] = []
  let tableSeen = false, invalid = false
  for (let index = 0; index < lines.length - 1; index++) {
    if (!lines[index].includes('|')) continue
    const headers = cells(lines[index])
    if (!headers.some(header => ['甲组', '乙组', '合计', '总计'].includes(header))) continue
    if (!cells(lines[index + 1]).every(cell => /^:?-{3,}:?$/.test(cell))) continue
    tableSeen = true
    const columns = ['甲组', '乙组'].map(label => headers.indexOf(label))
    columns.push(headers.findIndex(label => label === '合计' || label === '总计'))
    const fileColumn = headers.findIndex(label => ['文件', '文件名', '文档'].includes(label))
    if (fileColumn < 0 || columns.some(column => column < 0) || new Set(headers).size !== headers.length) { invalid = true; continue }
    for (let line = index + 2; line < lines.length && lines[line].includes('|'); line++) {
      const row = cells(lines[line]), file = row[fileColumn], expectedIndex = inspectFiles.indexOf(file)
      if (expectedIndex < 0) continue
      rows.push(row)
      if (row.length !== headers.length) { invalid = true; continue }
      const values = columns.map(column => /^([+-]?\d+(?:\.\d+)?)(?:\s*项)?(?:\s*[（(][A-Z]+[1-9]\d*[）)])?$/.exec(row[column]))
      if (values.some((value, position) => !value || Number(value[1]) !== [12, 30, 42][position])) invalid = true
    }
  }
  if (!tableSeen) return labelledFacts(answer)
  return !invalid && rows.length === inspectFiles.length && inspectFiles.every(file => rows.filter(row => row.includes(file)).length === 1)
}
export async function setupBatchOfficeInspect(workspace: string): Promise<void> {
  const facts = '甲组12，乙组30，合计42。'
  await fs.promises.writeFile(path.join(workspace, inspectFiles[0]), await Packer.toBuffer(new Document({
    sections: [{ children: [new Paragraph(`${inspectMarkers[0]} ${facts}`)] }],
  })))
  const book = new ExcelJS.Workbook(), sheet = book.addWorksheet('事实')
  sheet.addRows([[inspectMarkers[1]], ['甲组', 12], ['乙组', 30], ['合计', 42]])
  await book.xlsx.writeFile(path.join(workspace, inspectFiles[1]))
  const deck = new PptxGenJS()
  deck.addSlide().addText(`${inspectMarkers[2]} ${facts}`, { x: 1, y: 1, w: 7, h: 2 })
  await deck.writeFile({ fileName: path.join(workspace, inspectFiles[2]) })
}
export function batchOfficeInspectHashes(workspace: string): Record<string, string> {
  return Object.fromEntries(inspectFiles.map(name => [name, createHash('sha256').update(fs.readFileSync(path.join(workspace, name))).digest('hex')]))
}
export function checkBatchOfficeInspect(current: any): Record<string, unknown> {
  const evidence = executionEvidence(current), batch = explicitBatchEvidence(current, 'office_inspect', inspectFiles)
  const answer = current.turnFinalAnswers?.at(-1) || ''
  const inspected = evidence.records.filter(record => record.call.name === 'office_inspect' && record.resultIndex >= 0)
  const untouched = inspectFiles.every(name => {
    const file = workspaceFile(current.workspace, name)
    return !!file && current.seededOfficeHashes?.[name] === createHash('sha256').update(fs.readFileSync(file)).digest('hex')
  })
  const inspectionContentVerified = inspectFiles.every((name, index) => inspected.some(record => {
    if (workspaceFile(current.workspace, record.call.args?.path) !== workspaceFile(current.workspace, name)) return false
    let output: any
    try { output = JSON.parse(record.result.content) } catch { return false }
    const facts = output?.format === 'xlsx' ? ['A2: 甲组', 'B2: 12', 'A3: 乙组', 'B3: 30', 'A4: 合计', 'B4: 42']
      .every(cell => output.content?.split('\n').includes(`- ${cell}`)) : labelledFacts(output?.content || '')
    return typeof output?.content === 'string' && output.content.includes(inspectMarkers[index]) && facts
      && record.result.metadata?.expectedHash === `sha256:${current.seededOfficeHashes?.[name]}`
  }))
  return { threeInspectionsInOneExplicitCall: batch.complete, completeInspectionReceiptInNextRequest: batch.receipt.complete,
    inspectionContentVerified, originalOfficeBytesUnchanged: untouched,
    allThreeMarkersReported: inspectMarkers.every(marker => answer.includes(marker)), factsCorrect: officeInspectFactsCorrect(answer),
    noMutationTools: evidence.rawRecords.every(record => !['write_file', 'edit_file', 'delete_file', 'execute_cmd', 'deliver_files'].includes(record.call.name)
      && (record.call.name !== 'office_document' || record.call.args?.operation === 'inspect')),
    inspectionBatch: batch, batches: evidence.batches, ...providerBatchStatistics(current),
    limitation: 'Real Office package text and saved bytes are checked; no native Office layout or rendering claim.' }
}

export async function checkBatchOffice(current: any): Promise<Record<string, unknown>> {
  const evidence = executionEvidence(current)
  const names = ['batch.docx', 'batch.xlsx', 'batch.pptx']
  const creates = evidence.coverage('office_document', names, 'create')
  const maxCreateBatch = creates.succeeded
  const file = (name: string) => path.join(current.workspace, name)
  const expected = names.map(name => workspaceFile(current.workspace, name))
  const present = expected.every(Boolean)
  if (!present) return { threeFilesPresent: false, threeCreatesInOneModelResponse: creates.complete, maxCreateBatch }
  const final = [...(current.postconditions?.deliveries || [])].sort((a, b) => a.publishedAt - b.publishedAt).at(-1)
  const items: any[] = final?.items || []
  const exactPaths = (entries: any[]) => {
    const paths = entries.map(item => workspaceFile(current.workspace, item.path))
    return paths.length === names.length && new Set(paths).size === names.length
      && paths.every(candidate => candidate !== undefined && expected.includes(candidate))
  }
  const delivery = evidence.records.findLast(record => record.call.name === 'deliver_files'
    && record.resultIndex >= 0 && exactPaths(record.call.args?.items || []))
  const xlsxPath = workspaceFile(current.workspace, 'batch.xlsx')
  const recalculateSucceeded = evidence.records.some(record => record.call.name === 'office_document'
    && record.call.args?.operation === 'recalculate' && workspaceFile(current.workspace, record.call.args?.path) === xlsxPath
    && record.resultIndex >= 0 && delivery && record.resultIndex < delivery.index)
  const hashesMatch = exactPaths(items) && items.every(item => {
    const target = workspaceFile(current.workspace, item.path)!
    return createHash('sha256').update(fs.readFileSync(target)).digest('hex') === item.sha256
  })
  const word = (await mammoth.extractRawText({ path: file('batch.docx') })).value
  const slides = Object.entries(unzipSync(fs.readFileSync(file('batch.pptx'))))
    .filter(([name]) => /^ppt\/slides\/slide\d+\.xml$/.test(name)).map(([, bytes]) => [...new TextDecoder().decode(bytes).matchAll(/<a:t\b[^>]*>([\s\S]*?)<\/a:t>/g)].map(match => decodeXml(match[1])).join('\n'))
  const bytes = fs.readFileSync(file('batch.xlsx'))
  const book = new ExcelJS.Workbook(); await book.xlsx.readFile(file('batch.xlsx'))
  const formulas: Array<{ sheet: string; address: string; formula: string; result: unknown }> = []
  const factRows: string[] = []
  let errorCells = 0
  book.eachSheet(sheet => sheet.eachRow(row => {
    const text: string[] = []
    row.eachCell(cell => {
      text.push(cell.text)
      if (cell.value && typeof cell.value === 'object' && 'error' in cell.value
        || cell.result && typeof cell.result === 'object' && 'error' in cell.result) errorCells++
      if (cell.formula) formulas.push({ sheet: sheet.name, address: cell.address, formula: cell.formula, result: cell.result })
    })
    factRows.push(text.join('\t'))
  }))
  let formulaValidation: Record<string, unknown> = { passed: false, error: 'No formulas' }
  if (formulas.length) {
    try {
      // As in office-bundle-fixture, recalculate in memory; never modify delivered artifacts.
      const calculated = new ExcelJS.Workbook()
      await calculated.xlsx.load(Uint8Array.from(await recalculateXlsx(bytes)).buffer)
      const cacheMismatches = formulas.filter(formula => {
        const actual = formula.result, expected = calculated.getWorksheet(formula.sheet)?.getCell(formula.address).result
        if (actual == null || expected == null) return true
        if (typeof actual === 'number' && typeof expected === 'number') return !Number.isFinite(actual) || !Number.isFinite(expected)
          || Math.abs(actual - expected) > 1e-9 * Math.max(1, Math.abs(expected))
        return JSON.stringify(actual) !== JSON.stringify(expected)
      }).map(formula => `${formula.sheet}!${formula.address}`)
      formulaValidation = { passed: recalculateSucceeded && errorCells === 0 && !cacheMismatches.length,
        recalculateSucceeded, cacheMismatches, method: 'Saved caches compared with an in-memory engine recalculation' }
    } catch (error) { formulaValidation = { passed: false, recalculateSucceeded, error: String(error) } }
  }
  return {
    threeFilesPresent: true, threeCreatesInOneModelResponse: creates.complete,
    wordFacts: labelledFacts(word),
    twoSlidesWithFacts: slides.length === 2 && labelledFacts(slides.join('\n')),
    spreadsheetFacts: book.worksheets.length === 1 && labelledFacts(factRows.join('\n')),
    spreadsheetFormula42: formulas.some(formula => /\bSUM\s*\(/i.test(formula.formula) && formula.result === 42),
    spreadsheetRecalculatedBeforeDelivery: recalculateSucceeded,
    spreadsheetCachesVerified: formulaValidation.passed === true,
    threeFinalItems: exactPaths(items) && !!delivery,
    deliveredHashesMatch: hashesMatch,
    maxCreateBatch, proposedCreateTargets: creates.proposed, batches: evidence.batches, formulaValidation,
    limitation: 'Checks text, labels, structure and engine-calculated caches; does not establish Word page count, native Office rendering, or independent Excel equivalence.',
  }
}
