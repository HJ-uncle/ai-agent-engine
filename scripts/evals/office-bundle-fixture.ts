import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { unzipSync } from 'fflate'
import ExcelJS from 'exceljs'
import mammoth from 'mammoth'
import { decodeXml } from '../../src/tools/office/office-zip.js'
import { recalculateXlsx } from '../../src/tools/office/recalculate.js'

/** Copy only the incident's project inputs into an isolated evaluation workspace. */
export function setupOfficeBundle(workspace: string, project: string): void {
  fs.cpSync(project, path.join(workspace, 'web-2048'), {
    recursive: true,
    filter: source => !/(^|[\\/])(?:node_modules|\.git|交付|dist)(?:[\\/]|$)/.test(source)
      && !/\.(?:xlsx|docx|pptx|png)$/i.test(source),
  })
}

export async function checkOfficeBundle(current: any): Promise<Record<string, unknown>> {
  const final = [...current.postconditions.deliveries].sort((a, b) => a.publishedAt - b.publishedAt).at(-1)
  const items = final?.items || []
  const messages: any[] = current.workflowMessages || current.messages || []
  const callRecords = messages.flatMap((message: any, index: number) => message.role === 'assistant' && message.toolCall
    ? [{ call: message.toolCall, index, resultIndex: messages.findIndex((result: any, resultIndex: number) => resultIndex > index
      && result.role === 'tool' && result.toolCallId === message.toolCall.id && result.metadata?.success === true
      && result.metadata?.status !== 'failed') }] : [])
  const calls = callRecords.map(record => record.call)
  const firstCreate = calls.findIndex((c: any) => c.name === 'office_document' && c.args?.operation === 'create')
  const delivery = calls.findLastIndex((c: any) => c.name === 'deliver_files' && c.args?.items?.length)
  const workspace = fs.realpathSync(current.workspace)
  // Product output may live in this session's generated artifact directory,
  // separate from the selected source project. Never admit another case/session.
  const roots = [workspace]
  if (current.ownedArtifactWorkspace && fs.existsSync(current.ownedArtifactWorkspace)) {
    const campaignWorkspace = fs.realpathSync(path.dirname(workspace))
    const actual = fs.realpathSync(current.ownedArtifactWorkspace)
    if (path.relative(campaignWorkspace, actual) === path.join('default', current.sessionId)) roots.push(actual)
  }
  const withinWorkspace = (candidate: string): string | undefined => {
    try {
      const absolute = fs.realpathSync(path.resolve(workspace, candidate))
      return roots.some(root => {
        const relative = path.relative(root, absolute)
        return relative && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`)
      }) && fs.statSync(absolute).isFile() ? absolute : undefined
    } catch { return undefined }
  }
  const meaningfulCharacters = (text: string): number => text.replace(/[\s\p{P}\p{S}]/gu, '').length
  // Deliberately modest content floors, not a claim of factual/visual quality.
  const topicCount = (text: string): number => [
    /合并|merge|相同.*数字/i, /棋盘|网格|board|grid|4\s*[×x*]\s*4/i,
    /操作|方向键|触屏|滑动|键盘|swipe|keyboard|control/i, /得分|分数|score|胜利|获胜|win/i,
    /架构|模块|JavaScript|HTML|CSS|engine|渲染|render/i, /测试|检查|test|验证|验收/i,
    /存档|持久|主题|theme|localStorage|风险|计划|需求|功能/i,
  ].filter(pattern => pattern.test(text)).length
  const drafts = callRecords.filter(({ call }) => call.name === 'write_file' && /draft\.md$/i.test(call.args?.path || ''))
    .map(record => {
      const file = withinWorkspace(record.call.args.path)
      const text = file ? fs.readFileSync(file, 'utf8') : ''
      return { path: record.call.args.path, toolSucceeded: record.resultIndex >= 0,
        completedBeforeOfficeCreation: firstCreate >= 0 && record.resultIndex >= 0 && record.resultIndex < callRecords[firstCreate].index,
        existsWithBody: !!file && meaningfulCharacters(text) >= 100 && text.includes('2048') && topicCount(text) >= 2,
        bodyCharacters: meaningfulCharacters(text) }
    })
  const formats: any[] = []
  for (const item of items) {
    const file = typeof item.path === 'string' ? withinWorkspace(item.path) : undefined
    if (!file) { formats.push({ extension: path.extname(item.path || '').toLowerCase(), valid: false, error: 'Delivered file missing or outside evaluation workspace' }); continue }
    try {
    const bytes = fs.readFileSync(file)
    const extension = path.extname(file).toLowerCase()
    let text = '', meaningfulStructure = false, formulaCount = 0, cachedFormulaCount = 0, errorCells = 0
    let structure: Record<string, unknown> = {}, formulaValidation: Record<string, unknown> = { status: 'not_applicable', reason: 'Not a spreadsheet' }
    if (extension === '.xlsx') {
      const book = new ExcelJS.Workbook(); await book.xlsx.load(Uint8Array.from(bytes).buffer)
      const values: string[] = []
      const formulas: Array<{ sheet: string; address: string; result: unknown }> = []
      let tabularRows = 0, nonemptyCells = 0
      book.eachSheet(sheet => sheet.eachRow(row => {
        let populated = 0
        row.eachCell(cell => {
        const visible = cell.text.trim()
        if (visible) { values.push(visible); populated++; nonemptyCells++ }
        if (cell.value && typeof cell.value === 'object' && 'error' in cell.value) errorCells++
        if (cell.formula) {
          formulaCount++
          if (cell.result !== undefined && cell.result !== null) cachedFormulaCount++
          if (cell.result && typeof cell.result === 'object' && 'error' in cell.result) errorCells++
          formulas.push({ sheet: sheet.name, address: cell.address, result: cell.result })
        }
        })
        if (populated >= 2) tabularRows++
      }))
      text = values.join('\n')
      structure = { sheets: book.worksheets.length, tabularRows, nonemptyCells }
      meaningfulStructure = tabularRows >= 3 && nonemptyCells >= 8 && meaningfulCharacters(text) >= 80 && topicCount(text) >= 2
      formulaValidation = { status: 'not_applicable', reason: 'Workbook contains no formulas; formula behavior was not tested' }
      if (formulaCount) {
        const recalculateSucceeded = callRecords.some(({ call, resultIndex }) => call.name === 'office_document'
          && call.args?.operation === 'recalculate' && typeof call.args?.path === 'string'
          && withinWorkspace(call.args.path) === file && resultIndex >= 0 && delivery >= 0 && resultIndex < callRecords[delivery].index)
        try {
          // Recompute in memory and compare saved caches. Never write to delivered artifacts.
          const calculated = new ExcelJS.Workbook()
          await calculated.xlsx.load(Uint8Array.from(await recalculateXlsx(bytes)).buffer)
          const cacheMismatches = formulas.filter(formula => {
            const actual = formula.result, expected = calculated.getWorksheet(formula.sheet)?.getCell(formula.address).result
            if (actual == null || expected == null) return true
            if (typeof actual === 'number' && typeof expected === 'number') return !Number.isFinite(actual) || !Number.isFinite(expected)
              || Math.abs(actual - expected) > 1e-9 * Math.max(1, Math.abs(expected))
            return JSON.stringify(actual) !== JSON.stringify(expected)
          }).map(formula => `${formula.sheet}!${formula.address}`)
          formulaValidation = { status: recalculateSucceeded && cachedFormulaCount === formulaCount && errorCells === 0 && !cacheMismatches.length ? 'passed' : 'failed',
            recalculateSucceeded, cacheMismatches, method: 'Compare saved caches with an in-memory rerun of the engine formula calculator' }
        } catch (error) { formulaValidation = { status: 'failed', recalculateSucceeded, error: String(error) } }
      }
    } else if (extension === '.docx') {
      text = (await mammoth.extractRawText({ buffer: bytes })).value
      const paragraphs = text.split(/\n\s*\n/).filter(part => meaningfulCharacters(part) >= 10).length
      structure = { paragraphs }
      meaningfulStructure = paragraphs >= 3 && meaningfulCharacters(text) >= 200 && topicCount(text) >= 3
    }
    else if (extension === '.pptx') {
      const parts = unzipSync(bytes)
      const slides = Object.entries(parts).filter(([name]) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
        .map(([, data]) => [...new TextDecoder().decode(data).matchAll(/<a:t\b[^>]*>([\s\S]*?)<\/a:t>/g)]
          .map(match => decodeXml(match[1])).join('\n'))
      text = slides.join('\n')
      const substantiveSlides = slides.filter(slide => meaningfulCharacters(slide) >= 25).length
      structure = { slides: slides.length, substantiveSlides }
      meaningfulStructure = slides.length >= 3 && substantiveSlides >= 3 && meaningfulCharacters(text) >= 120 && topicCount(text) >= 3
    }
    const references2048 = text.includes('2048')
    const projectModuleMatches = ['engine.js', 'game.js', 'renderer.js', 'app.js', 'theme.js'].filter(module => text.includes(module)).length
    // A project ledger may identify itself in its filename instead of repeating
    // the title in data cells. Require the concrete project evidence as well.
    const projectIdentityVerified = references2048 || extension === '.xlsx' && /2048/.test(item.name || '')
      && projectModuleMatches >= 4 && /悔棋/.test(text) && /主题/.test(text)
    formats.push({ extension, name: item.name, bytes: bytes.length, references2048, projectIdentityVerified, projectModuleMatches,
      sourceMatchesPublishedHash: createHash('sha256').update(bytes).digest('hex') === item.sha256,
      valid: true, meaningfulStructure, topicCount: topicCount(text), structure, formulaCount, cachedFormulaCount, errorCells,
      formulaValidation, textCharacters: text.length, meaningfulCharacters: meaningfulCharacters(text) })
    } catch (error) { formats.push({ extension: path.extname(file).toLowerCase(), valid: false, error: String(error) }) }
  }
  const attempts: any[] = current.attempts || []
  const bodyHashes = attempts.map((a: any) => a.bodySha256).filter((hash: unknown) => typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash))
  const spreadsheets = formats.filter(format => format.extension === '.xlsx')
  const formulaWorkbooks = spreadsheets.filter(format => format.formulaCount > 0)
  return {
    threeFormatsDelivered: items.length === 3 && ['.xlsx', '.docx', '.pptx'].every(ext => formats.some(f => f.extension === ext)),
    draftBeforeOfficeCreation: drafts.some(draft => draft.toolSucceeded && draft.completedBeforeOfficeCreation && draft.existsWithBody),
    draftNotDelivered: items.every((i: any) => !/\.md$/i.test(i.path)),
    artifactContentsAndHashesValid: formats.length === 3 && formats.every(f => f.valid && f.projectIdentityVerified && f.sourceMatchesPublishedHash && f.meaningfulStructure),
    spreadsheetErrorCellsAbsent: spreadsheets.length === 1 && spreadsheets.every(f => f.valid && f.errorCells === 0),
    formulasCachedWithoutErrors: formulaWorkbooks.length ? formulaWorkbooks.every(f => f.formulaValidation.status === 'passed')
      : 'N/A: no delivered formulas; formula execution and cache correctness were not tested',
    finalDeliveryOnlyCloses: delivery >= 0 && callRecords[delivery].resultIndex >= 0 && calls.slice(delivery + 1).every((c: any) => c.name === 'plan_update'),
    planClosed: current.postconditions.todos.every((t: any) => ['done', 'cancelled'].includes(t.status)),
    noFinalDownloadLinkList: !/\]\([^)]*(?:workspace\/file\/download|\.(?:docx|xlsx|pptx)(?:\?|\)))/i.test(current.turnFinalAnswers.at(-1) || ''),
    backgroundIdle: current.backgroundIdleChecks.every((c: any) => c.settled),
    wireRequestHashCoverageComplete: attempts.length > 0 && bodyHashes.length === attempts.length,
    noIdenticalWireRequestResends: bodyHashes.length === new Set(bodyHashes).size,
    expectedTurnsSucceeded: current.turnStates.length === (current.expectedTurns ?? 2) && current.turnStates.every((s: any) => s.status === 'succeeded'),
    formats, drafts, calls: calls.map((c: any) => ({ name: c.name, operation: c.args?.operation, path: c.args?.path })),
    wireRequestHashEvidence: { observedAttempts: attempts.length, capturedBodyHashes: bodyHashes.length, repeatedBodyCount: bodyHashes.length - new Set(bodyHashes).size,
      boundary: 'Only identical serialized request bodies at the local fetch boundary are detected. Distinct bodies may contain duplicated history; gateway-internal retries are not observed.' },
    limitation: 'Content floors validate visible text and basic structure, not factual accuracy or native Office rendering. Formula checks apply only when formulas exist and reuse the engine calculator, not an independent Excel implementation.',
  }
}
