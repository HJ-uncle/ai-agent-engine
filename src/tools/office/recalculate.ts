import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads'
import type { WorkBook } from 'xlsx'
import { decodeXml, encodeXml, MAX_OFFICE_FILE_BYTES, readOfficeZip, writeOfficeZip } from './office-zip.js'

export const XLSX_RECALCULATION_FUNCTIONS = ['SUM', 'AVERAGE', 'MIN', 'MAX', 'COUNT', 'COUNTA', 'IF', 'IFERROR', 'ROUND', 'SUMIF', 'COUNTIF', 'ABS', 'AND', 'OR', 'DATE', 'TEXT'] as const
export const XLSX_RECALCULATION_LIMITS = Object.freeze({ timeoutMs: 10_000, queueTimeoutMs: 15_000, maxWorkers: 2, maxQueued: 8,
  maxRetainedInputBytes: 64 * 1024 * 1024, maxOldGenerationSizeMb: 128, maxCells: 100_000, maxFormulas: 10_000, maxReferencedCells: 1_000_000 })
const workerKind = 'aether-office-recalculate-v1'
const localRequire = createRequire(import.meta.url)
const ns = '(?:[A-Za-z_][\\w.-]*:)?'
const text = (value: Uint8Array): string => Buffer.from(value).toString('utf8')
function fail(message: string): never { throw new Error(`XLSX recalculate: ${message}`) }
interface Element { full: string; tag: string; rawAttrs: string; attrs: Record<string, string>; inner: string }
interface Ref { sheet: string; start: string; end: string }
type Expression = { kind: 'number' } | { kind: 'text' } | { kind: 'reference'; ref: Ref }
  | { kind: 'call'; name: string; args: Expression[] } | { kind: 'unary'; value: Expression }
  | { kind: 'binary'; operator: string; left: Expression; right: Expression }
type Token = Expression | string
interface Formula { sheet: string; file: string; address: string; cell: Element; formula: Element; canonical: string; refs: Ref[]; expression: Expression }
interface RawExpression { args: unknown[]; calc(): unknown }
interface Calculator {
  (workbook: WorkBook, options: { continue_after_error: false; log_error: false }): void
  import_functions(functions: Record<string, unknown>, options: { override: true }): void
  import_raw_functions(functions: Record<string, (...args: RawExpression[]) => unknown>): void
}

function elements(xml: string, name: string): Element[] {
  return [...xml.matchAll(new RegExp(`<(${ns}${name})\\b([^>]*?)(?:\\/\\s*>|>([\\s\\S]*?)<\\/\\1\\s*>)`, 'g'))].map(match => {
    const attrs: Record<string, string> = Object.create(null)
    for (const attr of match[2].matchAll(/([^\s=/>]+)\s*=\s*(["'])([\s\S]*?)\2/g)) {
      if (Object.hasOwn(attrs, attr[1])) fail('duplicate XML attribute')
      attrs[attr[1]] = decodeXml(attr[3])
    }
    return { full: match[0], tag: match[1], rawAttrs: match[2], attrs, inner: match[3] ?? '' }
  })
}
function coordinate(address: string): { row: number; column: number } {
  const match = /^([A-Z]{1,3})([1-9]\d{0,6})$/.exec(address)
  if (!match) return fail(`unsupported cell reference ${address}`)
  const column = [...match[1]].reduce((n, letter) => n * 26 + letter.charCodeAt(0) - 64, 0), row = Number(match[2])
  if (column > 16_384 || row > 1_048_576) fail('cell reference exceeds Excel bounds')
  return { row, column }
}
function columnName(column: number): string {
  let result = ''
  while (column) { column--; result = String.fromCharCode(65 + column % 26) + result; column = Math.floor(column / 26) }
  return result
}

/** A bounded syntax gate, not a calculator. Unsupported syntax must not reach a permissive parser. */
function expressionTree(tokens: Token[]): Expression {
  let cursor = 0
  const precedence: Record<string, number> = { '=': 1, '<>': 1, '<': 1, '>': 1, '<=': 1, '>=': 1, '+': 2, '-': 2, '*': 3, '/': 3 }
  const parse = (minimum = 0): Expression => {
    const token = tokens[cursor++]
    let left: Expression
    if (typeof token !== 'string') { if (!token) return fail('missing expression'); left = token }
    else if (token === '+' || token === '-') left = { kind: 'unary', value: parse(4) }
    else if (token === '(') { left = parse(); if (tokens[cursor++] !== ')') fail('unbalanced expression') }
    else if (tokens[cursor++] === '(') {
      const args: Expression[] = []
      do { args.push(parse()) } while (tokens[cursor++] === ',')
      if (tokens[cursor - 1] !== ')') fail('unbalanced function expression')
      left = { kind: 'call', name: token, args }
    } else return fail('unsupported expression')
    while (tokens[cursor] === '%') { cursor++; left = { kind: 'unary', value: left } }
    while (typeof tokens[cursor] === 'string' && (precedence[tokens[cursor] as string] ?? -1) >= minimum) {
      const operator = tokens[cursor++] as string
      left = { kind: 'binary', operator, left, right: parse(precedence[operator] + 1) }
    }
    return left
  }
  const result = parse()
  if (cursor !== tokens.length) fail('unsupported trailing expression')
  return result
}

function validateFormula(source: string, sheet: string, sheets: Map<string, string>, budget: { refs: number }): { canonical: string; refs: Ref[]; expression: Expression } {
  if (!source || source.length > 2048) fail('formula is empty or exceeds 2048 characters')
  let rest = source.replace(/^=/, ''), canonical = '', operand = true, tokens = 0
  const refs: Ref[] = [], semantic: Token[] = [], stack: Array<{ functionName?: string; arguments: number }> = []
  const appendAtom = (value: string, expression: Expression): void => { if (!operand) fail('missing operator in formula'); canonical += value; semantic.push(expression); operand = false }
  while (rest.length) {
    if (++tokens > 2048) fail('formula token limit exceeded')
    const whitespace = /^\s+/.exec(rest)
    if (whitespace) { rest = rest.slice(whitespace[0].length); continue }
    if (rest.startsWith('"')) {
      const end = rest.indexOf('"', 1)
      if (end < 0 || rest[end + 1] === '"') fail('unterminated or escaped string literal is not supported')
      appendAtom(rest.slice(0, end + 1), { kind: 'text' }); rest = rest.slice(end + 1); continue
    }
    const fn = /^([A-Za-z_][A-Za-z0-9_.]*)\s*\(/.exec(rest)
    if (fn) {
      const name = fn[1].toUpperCase()
      if (!operand || !(XLSX_RECALCULATION_FUNCTIONS as readonly string[]).includes(name)) fail(`unsupported function ${name}`)
      canonical += `${name}(`; semantic.push(name, '('); stack.push({ functionName: name, arguments: 1 }); rest = rest.slice(fn[0].length)
      if (stack.length > 64) fail('formula nesting limit exceeded')
      continue
    }
    const reference = /^(?:(?:'([^']+)'|([\p{L}_][\p{L}\p{N}_.]*))!)?(\$?[A-Za-z]{1,3}\$?[1-9]\d{0,6})(?::(\$?[A-Za-z]{1,3}\$?[1-9]\d{0,6}))?/u.exec(rest)
    if (reference) {
      const rawSheet = reference[1] ?? reference[2], target = rawSheet ? sheets.get(rawSheet.toLowerCase()) : sheet
      if (!target || target.includes("'")) fail(`unsupported or missing worksheet ${rawSheet ?? sheet}`)
      const start = reference[3].replaceAll('$', '').toUpperCase(), end = (reference[4] ?? reference[3]).replaceAll('$', '').toUpperCase()
      const a = coordinate(start), b = coordinate(end), size = (b.row - a.row + 1) * (b.column - a.column + 1)
      if (a.row > b.row || a.column > b.column || size > 100_000) fail('reversed or oversized range; use a bounded cell range')
      budget.refs += size
      if (budget.refs > XLSX_RECALCULATION_LIMITS.maxReferencedCells) fail('total referenced-cell budget exceeded')
      refs.push({ sheet: target, start, end })
      appendAtom(`${rawSheet ? `'${target}'!` : ''}${start}${reference[4] ? `:${end}` : ''}`, { kind: 'reference', ref: { sheet: target, start, end } })
      rest = rest.slice(reference[0].length); continue
    }
    const number = /^(?:\d+(?:\.\d*)?|\.\d+)/.exec(rest)
    if (number) { appendAtom(number[0], { kind: 'number' }); rest = rest.slice(number[0].length); continue }
    const boolean = /^(TRUE|FALSE)\b/i.exec(rest)
    if (boolean) fail('boolean literals are not supported by the current calculation semantics')
    const char = rest[0]
    if (char === '(') {
      if (!operand) fail('missing operator before parentheses')
      canonical += char; semantic.push(char); stack.push({ arguments: 1 }); rest = rest.slice(1)
      if (stack.length > 64) fail('formula nesting limit exceeded')
      continue
    }
    if (char === ')') {
      if (operand || !stack.length) fail('empty argument or unbalanced parentheses')
      const closed = stack.pop()!, count = closed.arguments, name = closed.functionName
      if (name && ((['IF', 'DATE'].includes(name) && count !== 3) || (['IFERROR', 'ROUND', 'TEXT'].includes(name) && count !== 2)
        || (name === 'ABS' && count !== 1) || (name === 'COUNTIF' && count !== 2)
        || (name === 'SUMIF' && count !== 2 && count !== 3))) fail(`unsupported argument count for ${name}`)
      canonical += char; semantic.push(char); rest = rest.slice(1); operand = false; continue
    }
    if (char === ',') {
      const group = stack.at(-1)
      if (operand || !group?.functionName) fail('unexpected comma or empty argument')
      group.arguments++; canonical += char; semantic.push(char); rest = rest.slice(1); operand = true; continue
    }
    if (char === '%') {
      if (operand) fail('unexpected percentage operator')
      canonical += char; semantic.push(char); rest = rest.slice(1); continue
    }
    const operator = /^(?:<>|<=|>=|[+\-*/^&=<>])/.exec(rest)
    if (operator) {
      if (operator[0] === '^' || operator[0] === '&') fail('power and concatenation operators are not supported by the current calculation semantics')
      if (operand && !['+', '-'].includes(operator[0])) fail('unexpected formula operator')
      canonical += operator[0]; semantic.push(operator[0]); rest = rest.slice(operator[0].length); operand = true; continue
    }
    return fail(`unsupported formula syntax near ${rest.slice(0, 30)}`)
  }
  if (operand || stack.length) fail('incomplete formula')
  return { canonical, refs, expression: expressionTree(semantic) }
}

/** Validate operand types only; formula values continue to come from the maintained calculation libraries. */
function validateSemantics(expression: Expression, book: WorkBook): string {
  if (expression.kind === 'number' || expression.kind === 'text') return expression.kind
  if (expression.kind === 'reference') {
    if (expression.ref.start !== expression.ref.end) return 'range'
    const value: unknown = book.Sheets[expression.ref.sheet][expression.ref.start]?.v
    return value === undefined || value === null ? 'blank' : typeof value === 'number' ? 'number' : typeof value === 'string' ? 'text' : typeof value === 'boolean' ? 'boolean' : 'unsupported'
  }
  if (expression.kind === 'unary') {
    if (validateSemantics(expression.value, book) !== 'number') fail('arithmetic with nonnumeric or blank operands is unsupported')
    return 'number'
  }
  if (expression.kind === 'binary') {
    const left = validateSemantics(expression.left, book), right = validateSemantics(expression.right, book)
    if (['=', '<>', '<', '>', '<=', '>='].includes(expression.operator)) {
      // Keep comparisons bounded to two values of the same scalar type;
      // mixed arithmetic and implicit coercion remain rejected below.
      if (left === 'text' && right === 'text') return 'boolean'
      if (left === 'number' && right === 'number') return 'boolean'
      fail('text, boolean, blank or mixed-type comparison is unsupported')
    }
    if (left !== 'number' || right !== 'number') fail('text, boolean, blank or mixed-type arithmetic is unsupported')
    return 'number'
  }
  const types = expression.args.map(arg => validateSemantics(arg, book))
  if (expression.name === 'IF') {
    if (!['number', 'boolean'].includes(types[0])) fail('IF requires a numeric or boolean condition')
    return types[1] === types[2] ? types[1] : 'mixed'
  }
  if (expression.name === 'IFERROR') return types[0] === types[1] ? types[0] : 'mixed'
  if (expression.name === 'AND' || expression.name === 'OR') {
    if (types.some(type => !['number', 'boolean'].includes(type))) fail('AND/OR only support numeric or boolean operands')
    return 'boolean'
  }
  if (['ROUND', 'ABS', 'DATE'].includes(expression.name) && types.some(type => type !== 'number')) fail(`${expression.name} only supports numeric operands`)
  if (expression.name === 'TEXT') {
    if (types[0] !== 'number' || types[1] !== 'text') fail('TEXT requires a numeric value and a text format')
    return 'text'
  }
  return 'number'
}

interface NumberFormatter { format(format: string, value: number, options: { date1904: boolean }): string }
function installDateFormatting(calculate: Calculator, functions: Record<string, unknown>, formatter: NumberFormatter, date1904: boolean): void {
  const dateFunction = functions.DATE
  if (typeof dateFunction !== 'function') fail('DATE calculation library unavailable')
  const serialDate = (yearValue: unknown, monthValue: unknown, dayValue: unknown): number => {
    const numbers = [yearValue, monthValue, dayValue]
    if (numbers.some(value => typeof value !== 'number' || !Number.isFinite(value))) fail('DATE requires finite numeric arguments')
    let year = Math.trunc(yearValue as number)
    const month = Math.trunc(monthValue as number), day = Math.trunc(dayValue as number)
    if (year < 0 || year > 9999 || Math.abs(month) > 120000 || Math.abs(day) > 3660000) fail('DATE arguments exceed supported bounds')
    if (year < 1900) year += 1900
    // Normalize the month with the maintained DATE function, then serialize from its first day.
    // Adding the requested day in Excel serial space preserves the fictitious 1900-02-29, including overflow/underflow.
    const first: unknown = (dateFunction as (...args: number[]) => unknown)(year, month, 1)
    if (!(first instanceof Date) || !Number.isFinite(first.getTime())) fail('DATE returned an invalid date')
    const utc = Date.UTC(first.getFullYear(), first.getMonth(), first.getDate())
    const beforeLeapBug = utc < Date.UTC(1900, 2, 1)
    const serial = utc / 86_400_000 + 25_569 - (beforeLeapBug ? 1 : 0) + day - 1 - (date1904 ? 1462 : 0)
    if (!Number.isFinite(serial) || serial < 0 || serial > 2958465 - (date1904 ? 1462 : 0)) fail('DATE result is outside the workbook date system')
    return serial
  }
  const formatText = (value: unknown, format: unknown): string => {
    if (typeof value !== 'number' || !Number.isFinite(value) || typeof format !== 'string' || !format.length || format.length > 128) fail('TEXT requires a finite number and a bounded format')
    const dateFormat = /^(?:yyyy|yy)[-/](?:mm|m)[-/](?:dd|d)(?: (?:hh|h):mm(?::ss)?)?$/i.test(format)
    const numericPattern = format.startsWith('(') && format.endsWith(')') ? format.slice(1, -1) : format
    const numericFormat = /^[-+]?[$€¥￥]?\s*[#0?]+(?:,[#0?]{3})*(?:\.[#0?]+)?%?$/.test(numericPattern)
    if (!dateFormat && !numericFormat) fail('TEXT format is outside supported numeric/date formats')
    if (dateFormat && (value < 0 || value > 2958465 - (date1904 ? 1462 : 0))) fail('TEXT date value is outside the workbook date system')
    const result = formatter.format(format, value, { date1904 })
    if (typeof result !== 'string' || result.length > 32767) fail('TEXT formatter returned an invalid result')
    return result
  }
  calculate.import_functions({ DATE: serialDate, TEXT: formatText }, { override: true })
}

function installDomainGuards(calculate: Calculator, functions: Record<string, unknown>): void {
  const call = (name: string, args: unknown[]): unknown => {
    const fn = functions[name]
    if (typeof fn !== 'function') fail(`calculation function unavailable: ${name}`)
    return (fn as (...values: unknown[]) => unknown)(...args)
  }
  const flatten = (value: unknown): unknown[] => Array.isArray(value) ? value.flat(2) : [value]
  const isReference = (arg: RawExpression): boolean => {
    const node = arg.args.length === 1 ? arg.args[0] : undefined
    return !!node && typeof node === 'object' && ('parseRef' in node || 'parse' in node)
  }
  const guards: Record<string, (...args: RawExpression[]) => unknown> = {}
  for (const name of ['SUM', 'AVERAGE', 'MIN', 'MAX', 'COUNT']) guards[name] = (...args) => {
    const values = args.flatMap(arg => {
      const calculated = flatten(arg.calc())
      if (calculated.some(value => value instanceof Error)) fail(`${name} received an error cell`)
      // Excel ignores text/boolean cells in references; direct literal coercions are outside this bounded contract.
      if (isReference(arg)) return calculated.filter(value => typeof value === 'number' && Number.isFinite(value))
      if (calculated.some(value => typeof value !== 'number' || !Number.isFinite(value))) fail(`${name} literal/mixed-type coercion is unsupported`)
      return calculated
    })
    return call(name, [values])
  }
  // FormulaJS COUNTA treats empty strings as blank; Excel counts them, including formula results.
  guards.COUNTA = (...args) => call('COUNT', [args.flatMap(arg => flatten(arg.calc()))
    .filter(value => value !== null && value !== undefined).map(() => 1)])
  guards.ROUND = (...args) => {
    const number = args[0].calc(), digits = args[1].calc()
    // FormulaJS shifts decimal strings; exponent notation loses its original exponent in that implementation.
    if (typeof number !== 'number' || !Number.isFinite(number) || typeof digits !== 'number' || !Number.isInteger(digits)
      || Math.abs(digits) > 15 || /e/i.test(String(number)) || Math.abs(number) * 10 ** digits >= 1e20) fail('ROUND scientific-notation values or precision/shift outside the supported bounds are unsupported')
    return call('ROUND', [number, digits])
  }
  guards.SUMIF = (...args) => {
    const range = args[0].calc(), criteria = args[1].calc(), sums = args.length === 3 ? args[2].calc() : range
    const rangeValues = flatten(range), sumValues = flatten(sums)
    const shape = (value: unknown): string => Array.isArray(value) ? JSON.stringify(value.map(row => Array.isArray(row) ? row.length : 0)) : 'scalar'
    if (rangeValues.length !== sumValues.length || shape(range) !== shape(sums)) fail('SUMIF ranges must have the same explicit shape; implicit range expansion is unsupported')
    if (rangeValues.some(value => value === null || value === undefined)) fail('SUMIF blank criteria cells are outside the current calculation contract')
    if (sumValues.some(value => value instanceof Error || typeof value === 'number' && !Number.isFinite(value))) fail('SUMIF sum_range contains an error or nonfinite number')
    const numericSums = sumValues.map(value => typeof value === 'number' ? value : 0)
    const numericCriteria = typeof criteria === 'number' && Number.isFinite(criteria)
      || typeof criteria === 'string' && /^(?:<>|<=|>=|=|<|>)?-?(?:\d+(?:\.\d*)?|\.\d+)$/.test(criteria)
    if (numericCriteria) {
      if (rangeValues.some(value => value !== null && value !== undefined && (typeof value !== 'number' || !Number.isFinite(value)))) fail('SUMIF numeric criteria require a numeric range')
      return call('SUMIF', [range, criteria, numericSums])
    }
    if (typeof criteria !== 'string' || criteria.length > 256 || rangeValues.some(value => typeof value !== 'string')) fail('SUMIF text criteria require a bounded text criterion and text range')
    const parsed = /^(<>|=)?([\s\S]*)$/.exec(criteria)!
    if (!parsed || /^[<>]/.test(parsed[2])) fail('SUMIF ordered text comparison is unsupported')
    const negative = parsed[1] === '<>', pattern = [...parsed[2]]
    let source = '^'
    const literal = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    for (let index = 0; index < pattern.length; index++) {
      const char = pattern[index]
      if (char === '~' && ['~', '*', '?'].includes(pattern[index + 1])) source += literal(pattern[++index])
      else source += char === '*' ? '[\\s\\S]*' : char === '?' ? '[\\s\\S]' : literal(char)
    }
    const match = new RegExp(`${source}$`, 'iu')
    // Adapt Excel's case-insensitive wildcard criterion to an equality mask; the mature library still performs SUMIF.
    const mask = rangeValues.map(value => match.test(value as string) !== negative ? 1 : 0)
    return call('SUMIF', [mask, 1, numericSums])
  }
  guards.COUNTIF = (...args) => {
    if (args.length !== 2) fail('COUNTIF requires exactly two arguments')
    const rangeValues = flatten(args[0].calc()), criteria = args[1].calc()
    if (rangeValues.some(value => value instanceof Error)) fail('COUNTIF received an error cell')
    if (typeof criteria === 'number' && Number.isFinite(criteria)) return rangeValues.filter(value => typeof value === 'number' && value === criteria).length
    if (typeof criteria !== 'string' || criteria.length > 256) fail('COUNTIF criteria must be a bounded number or text value')
    const parsed = /^(<>|<=|>=|=|<|>)?([\s\S]*)$/.exec(criteria)!
    const operator = parsed[1] ?? '=', operand = parsed[2]
    if (!operand.length) fail('COUNTIF criteria cannot be empty')
    const numeric = /^-?(?:\d+(?:\.\d*)?|\.\d+)$/.test(operand) ? Number(operand) : undefined
    if (numeric !== undefined && Number.isFinite(numeric)) {
      return rangeValues.filter(value => {
        if (typeof value !== 'number' || !Number.isFinite(value)) return false
        return operator === '=' ? value === numeric : operator === '<>' ? value !== numeric
          : operator === '<' ? value < numeric : operator === '>' ? value > numeric
            : operator === '<=' ? value <= numeric : value >= numeric
      }).length
    }
    if (operator !== '=' && operator !== '<>') fail('COUNTIF ordered text comparison is unsupported')
    const pattern = [...operand]
    let source = '^'
    const literal = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    for (let index = 0; index < pattern.length; index++) {
      const char = pattern[index]
      if (char === '~' && ['~', '*', '?'].includes(pattern[index + 1])) source += literal(pattern[++index])
      else source += char === '*' ? '[\\s\\S]*' : char === '?' ? '[\\s\\S]' : literal(char)
    }
    const match = new RegExp(`${source}$`, 'iu')
    return rangeValues.filter(value => {
      if (typeof value !== 'string') return false
      const equal = match.test(value)
      return operator === '<>' ? !equal : equal
    }).length
  }
  calculate.import_raw_functions(guards)
}

function rejectCycles(formulas: Formula[]): void {
  const byId = new Map(formulas.map(formula => [`${formula.sheet}!${formula.address}`, formula])), states = new Map<string, number>()
  const visit = (id: string, depth: number): void => {
    if (states.get(id) === 1) fail(`circular dependency at ${id}`)
    if (states.get(id) === 2) return
    if (depth > 512) fail('formula dependency depth exceeds 512')
    states.set(id, 1)
    for (const ref of byId.get(id)!.refs) {
      const a = coordinate(ref.start), b = coordinate(ref.end)
      for (let row = a.row; row <= b.row; row++) for (let col = a.column; col <= b.column; col++) {
        const target = `${ref.sheet}!${columnName(col)}${row}`
        if (byId.has(target)) visit(target, depth + 1)
      }
    }
    states.set(id, 2)
  }
  for (const id of byId.keys()) visit(id, 0)
}

async function calculateInWorker(bytes: Buffer): Promise<Buffer> {
  const entries = readOfficeZip(bytes)
  if (Object.keys(entries).some(file => /^xl\/externalLinks\//i.test(file))) fail('external workbook links are unsupported')
  const xml = (file: string): string => {
    if (!entries[file]) return fail(`missing package part ${file}`)
    const value = text(entries[file])
    if (/<!\[CDATA\[/i.test(value)) fail('CDATA in calculation parts is unsupported')
    return value
  }
  const workbookXml = xml('xl/workbook.xml'), relationships = elements(xml('xl/_rels/workbook.xml.rels'), 'Relationship')
  if (new Set(relationships.map(item => item.attrs.Id)).size !== relationships.length) fail('duplicate workbook relationship IDs')
  if (elements(workbookXml, 'calcPr').some(item => ['1', 'true'].includes(item.attrs.iterate ?? ''))) fail('iterative calculation is unsupported')
  const sheetList = elements(workbookXml, 'sheet'), names = new Map<string, string>(), files = new Set<string>()
  if (!sheetList.length || sheetList.length > 24) fail('worksheet limit is 1–24')
  for (const item of sheetList) {
    const name = item.attrs.name
    if (!name || names.has(name.toLowerCase()) || ['__proto__', 'constructor', 'prototype'].includes(name)) fail('invalid or duplicate worksheet name')
    names.set(name.toLowerCase(), name)
  }
  let cells = 0
  const formulas: Formula[] = [], budget = { refs: 0 }
  for (const item of sheetList) {
    const rel = relationships.find(candidate => candidate.attrs.Id === item.attrs['r:id'])
    if (!rel || !rel.attrs.Type?.endsWith('/worksheet') || rel.attrs.TargetMode === 'External') fail('unsupported worksheet relationship')
    const target = rel!.attrs.Target
    if (!target || target.includes('\\')) fail('invalid worksheet target')
    const file = target.startsWith('/') ? target.slice(1) : path.posix.normalize(path.posix.join('xl', target))
    if (!file.startsWith('xl/worksheets/') || files.has(file)) fail('duplicate or out-of-bounds worksheet target')
    files.add(file)
    const addresses = new Set<string>()
    for (const cell of elements(xml(file), 'c')) {
      if (++cells > XLSX_RECALCULATION_LIMITS.maxCells) fail('cell count exceeds 100000')
      const address = cell.attrs.r
      coordinate(address)
      if (addresses.has(address)) fail(`duplicate cell ${item.attrs.name}!${address}`)
      addresses.add(address)
      const found = elements(cell.inner, 'f')
      if (!found.length) continue
      if (found.length !== 1 || (found[0].attrs.t && found[0].attrs.t !== 'normal') || found[0].attrs.ref || found[0].attrs.si
        || cell.attrs.cm || cell.attrs.vm || elements(cell.inner, 'extLst').length || elements(cell.inner, 'is').length) fail(`shared, array, data-table or rich formula unsupported at ${item.attrs.name}!${address}`)
      if (formulas.length >= XLSX_RECALCULATION_LIMITS.maxFormulas) fail('formula count exceeds 10000')
      const formula = found[0]
      formulas.push({ sheet: item.attrs.name, file, address, cell, formula, ...validateFormula(decodeXml(formula.inner), item.attrs.name, names, budget) })
    }
  }
  if (!formulas.length) return Buffer.from(bytes)
  rejectCycles(formulas)
  const xlsx = await import('xlsx')
  const book = xlsx.read(bytes, { type: 'buffer', cellFormula: true, cellDates: false, cellText: false, cellNF: false, sheetStubs: true })
  const calculate = localRequire('xlsx-calc') as Calculator
  const functions = localRequire('@formulajs/formulajs') as Record<string, unknown>
  calculate.import_functions(functions, { override: true }); installDomainGuards(calculate, functions)
  installDateFormatting(calculate, functions, (localRequire('xlsx') as { SSF: NumberFormatter }).SSF, book.Workbook?.WBProps?.date1904 === true)
  const formulaKeys = new Set(formulas.map(formula => `${formula.sheet}!${formula.address}`)), originalCells = new Map<string, string>()
  for (const name of book.SheetNames) for (const [address, cell] of Object.entries(book.Sheets[name])) {
    if (address.startsWith('!')) continue
    originalCells.set(`${name}!${address}`, JSON.stringify({ v: cell.v, t: cell.t, f: cell.f, F: cell.F }))
  }
  for (const formula of formulas) {
    const cell = book.Sheets[formula.sheet]?.[formula.address]
    if (!cell?.f || cell.f.replace(/^=/, '') !== decodeXml(formula.formula.inner).replace(/^=/, '')) fail(`reader did not retain formula ${formula.sheet}!${formula.address}`)
    cell.f = formula.canonical
    delete cell.v; delete cell.w
  }
  calculate(book, { continue_after_error: false, log_error: false })
  for (const formula of formulas) validateSemantics(formula.expression, book)
  for (const name of book.SheetNames) for (const [address, cell] of Object.entries(book.Sheets[name])) {
    if (address.startsWith('!')) continue
    const key = `${name}!${address}`
    if (!originalCells.has(key) || !formulaKeys.has(key) && originalCells.get(key) !== JSON.stringify({ v: cell.v, t: cell.t, f: cell.f, F: cell.F })) fail(`calculation attempted an unsupported spill or changed input ${key}`)
  }
  const replacements = new Map<string, Map<string, string>>()
  for (const formula of formulas) {
    const result = book.Sheets[formula.sheet][formula.address], value: unknown = result.v
    if (result.t === 'e' || result.f !== formula.canonical || !(typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value))) fail(`no valid scalar result for ${formula.sheet}!${formula.address}: ${String(result.w ?? value).slice(0, 100)}`)
    if (typeof value === 'string' && value.length > 32767) fail('calculated string exceeds Excel cell limit')
    const type = typeof value === 'string' ? 'str' : typeof value === 'boolean' ? 'b' : 'n'
    const cached = encodeXml(typeof value === 'boolean' ? value ? '1' : '0' : String(value))
    const prefix = formula.cell.tag.includes(':') ? formula.cell.tag.slice(0, formula.cell.tag.indexOf(':') + 1) : ''
    let inner = formula.cell.inner
    const existing = elements(inner, 'v')
    if (existing.length > 1) fail('duplicate formula cache elements')
    if (existing[0]) inner = inner.replace(existing[0].full, '')
    inner = inner.replace(formula.formula.full, () => `${formula.formula.full}<${prefix}v>${cached}</${prefix}v>`)
    const attrs = formula.cell.rawAttrs.replace(/\s+t\s*=\s*(["'])[\s\S]*?\1/g, '')
    const group = replacements.get(formula.file) ?? new Map<string, string>()
    group.set(formula.cell.full, `<${formula.cell.tag}${attrs} t="${type}">${inner}</${formula.cell.tag}>`)
    replacements.set(formula.file, group)
  }
  for (const [file, replacementsForFile] of replacements) {
    const source = xml(file)
    const updated = source.replace(new RegExp(`<(${ns}c)\\b[^>]*?(?:\\/\\s*>|>[\\s\\S]*?<\\/\\1\\s*>)`, 'g'), cell => replacementsForFile.get(cell) ?? cell)
    entries[file] = Buffer.from(updated, 'utf8')
  }
  return writeOfficeZip(entries)
}

interface Request { kind: string; moduleUrl: string; tsxUrl?: string; bytes: Uint8Array }
interface Reply { ok: boolean; bytes?: Uint8Array; error?: string }
if (!isMainThread && (workerData as Request | undefined)?.kind === workerKind) {
  void calculateInWorker(Buffer.from((workerData as Request).bytes)).then(bytes => {
    const output = Uint8Array.from(bytes)
    parentPort!.postMessage({ ok: true, bytes: output } satisfies Reply, [output.buffer])
  }, error => parentPort!.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) } satisfies Reply))
}

let activeWorkers = 0
let retainedInputBytes = 0
const queued: Array<() => void> = []
function abortError(): Error { const error = new Error('XLSX recalculate: aborted'); error.name = 'AbortError'; return error }
async function acquire(signal?: AbortSignal): Promise<() => void> {
  if (signal?.aborted) throw abortError()
  if (activeWorkers >= XLSX_RECALCULATION_LIMITS.maxWorkers) {
    if (queued.length >= XLSX_RECALCULATION_LIMITS.maxQueued) fail('calculation queue is full; retry after current work completes')
    await new Promise<void>((resolve, reject) => {
      const cleanup = (): void => { clearTimeout(timer); signal?.removeEventListener('abort', aborted) }
      const remove = (): void => { const index = queued.indexOf(ready); if (index >= 0) queued.splice(index, 1) }
      const ready = (): void => { cleanup(); resolve() }
      const aborted = (): void => { cleanup(); remove(); reject(abortError()) }
      const timer = setTimeout(() => { cleanup(); remove(); reject(new Error('XLSX recalculate: queue timeout')) }, XLSX_RECALCULATION_LIMITS.queueTimeoutMs)
      queued.push(ready); signal?.addEventListener('abort', aborted, { once: true })
    })
  } else activeWorkers++
  return () => { const next = queued.shift(); if (next) next(); else activeWorkers-- }
}

/** Recalculates supported scalar formulas internally; never writes a file or launches an office application. */
export async function recalculateXlsx(bytes: Buffer, signal?: AbortSignal): Promise<Buffer> {
  if (bytes.byteLength > MAX_OFFICE_FILE_BYTES) fail('file exceeds 32 MiB')
  if (retainedInputBytes + bytes.byteLength > XLSX_RECALCULATION_LIMITS.maxRetainedInputBytes) fail('retained input budget exceeds 64 MiB; retry after current work completes')
  retainedInputBytes += bytes.byteLength
  let release: (() => void) | undefined
  try {
    release = await acquire(signal)
    if (signal?.aborted) throw abortError()
    const sourceModule = import.meta.url
    const request: Request = { kind: workerKind, moduleUrl: sourceModule, bytes: Uint8Array.from(bytes),
      tsxUrl: sourceModule.endsWith('.ts') ? pathToFileURL(localRequire.resolve('tsx/esm/api')).href : undefined }
    const bootstrap = `const {workerData,parentPort}=require('node:worker_threads');
      (async()=>{if(workerData.tsxUrl){const {register}=await import(workerData.tsxUrl);register();}await import(workerData.moduleUrl);})()
      .catch(error=>parentPort.postMessage({ok:false,error:error instanceof Error?error.message:String(error)}));`
    const worker = new Worker(bootstrap, { eval: true, workerData: request, transferList: [request.bytes.buffer as ArrayBuffer], execArgv: [], stdout: true, stderr: true,
      resourceLimits: { maxOldGenerationSizeMb: XLSX_RECALCULATION_LIMITS.maxOldGenerationSizeMb, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 } })
    worker.stdout.resume(); worker.stderr.resume()
    try {
      return await new Promise<Buffer>((resolve, reject) => {
        const cleanup = (): void => { clearTimeout(timer); signal?.removeEventListener('abort', aborted) }
        const aborted = (): void => { cleanup(); reject(abortError()) }
        const timer = setTimeout(() => { cleanup(); reject(new Error('XLSX recalculate: worker exceeded 10 second deadline')) }, XLSX_RECALCULATION_LIMITS.timeoutMs)
        signal?.addEventListener('abort', aborted, { once: true })
        worker.once('message', (reply: Reply) => { cleanup(); if (reply.ok && reply.bytes) resolve(Buffer.from(reply.bytes)); else reject(new Error(reply.error ?? 'XLSX recalculate: invalid worker result')) })
        worker.once('error', error => { cleanup(); reject(new Error(`XLSX recalculate: worker failed (${error.message})`)) })
        worker.once('exit', code => { cleanup(); reject(new Error(`XLSX recalculate: worker exited before returning a result (${code})`)) })
        if (signal?.aborted) aborted()
      })
    } finally { await worker.terminate() }
  } finally { release?.(); retainedInputBytes -= bytes.byteLength }
}
