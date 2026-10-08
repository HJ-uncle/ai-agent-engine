import type { ToolResult } from '../../core/agent-context/index.js'

type ObjectValue = Record<string, unknown>
const record = (value: unknown): value is ObjectValue => !!value && typeof value === 'object' && !Array.isArray(value)
const nonnegative = (value: unknown): number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0
function prefix(text: string, count: number): string {
  const value = text.slice(0, count)
  // Cursor offsets are UTF-16 units, but never leave half an emoji at a page boundary.
  return /[\uD800-\uDBFF]$/.test(value) ? value.slice(0, -1) : value
}
function bodyAt(value: ObjectValue, target: 'request' | 'response'): ObjectValue | undefined {
  const side = value[target]
  return record(side) && record(side.body) ? side.body : undefined
}
function textOf(body: ObjectValue | undefined): string { return typeof body?.text === 'string' ? body.text : '' }

/** Preserve state and real continuation offsets when the model budget shortens a captured body page. */
function shortenBody(body: ObjectValue | undefined, original: string, count: number): void {
  if (!body || count >= original.length) return
  const text = prefix(original, count)
  body.text = text
  body.returnedChars = text.length
  body.hasMore = true
  body.nextOffset = nonnegative(body.offset) + text.length
  body.truncated = true
  body.reason = (typeof body.reason === 'string' ? prefix(body.reason, 512) + ' ' : '') + '引擎输出预算缩短了本页正文；按 nextOffset 和较小 bodyLimit 继续读取。'
}

function compactMetadata(value: unknown, notes: Set<string>, path = '', depth = 0): unknown {
  if (typeof value === 'string') {
    if (path.endsWith('.body.text') || /(?:^|\.)(?:id|tabId|requestId)$/.test(path)) return value
    if (value.length <= 4096) return value
    notes.add('部分头、参数或元数据文本超过长度预算，已截断；不能视为完整值。')
    return prefix(value, 4096)
  }
  if (Array.isArray(value)) {
    if (value.length > 200) notes.add('部分元数据列表超过 200 项，尾部已省略；不能视为完整列表。')
    return value.slice(0, 200).map((item, index) => compactMetadata(item, notes, `${path}.${index}`, depth + 1))
  }
  if (!record(value)) return value
  if (depth > 12) { notes.add('过深的元数据已省略。'); return null }
  const entries = Object.entries(value)
  if (entries.length > 100) notes.add('部分元数据对象的字段已省略。')
  return Object.fromEntries(entries.slice(0, 100).map(([key, item]) => [key, compactMetadata(item, notes, path ? `${path}.${key}` : key, depth + 1)]))
}

function metadataArrays(value: ObjectValue): Array<{ owner: ObjectValue; key: string; items: unknown[] }> {
  const arrays: Array<{ owner: ObjectValue; key: string; items: unknown[] }> = []
  const visit = (object: ObjectValue, depth: number) => {
    if (depth > 5) return
    for (const [key, item] of Object.entries(object)) {
      if (key === 'entries') continue
      if (Array.isArray(item) && item.length) arrays.push({ owner: object, key, items: item })
      else if (record(item)) visit(item, depth + 1)
    }
  }
  visit(value, 0)
  return arrays.sort((left, right) => JSON.stringify(right.items).length - JSON.stringify(left.items).length)
}

function failure(maxChars: number): ToolResult {
  let output = JSON.stringify({ error: '浏览器网络结果无法在当前工具输出预算内完整表示，请提高输出预算或缩小筛选和分页。' })
  if (output.length > maxChars) output = maxChars >= 2 ? '""' : '0'
  return { success: false, output, metadata: { code: 'BROWSER_NETWORK_OUTPUT_LIMIT' } }
}

/** The ordinary loop cap measures JS string length, not UTF-8 bytes. Never bypass that cap. */
export function fitBrowserNetworkOutput(result: ToolResult, action: 'network' | 'network_request', args: ObjectValue, maxChars: number): ToolResult {
  if (!result.success) {
    const error = result.error || (result.output && result.output !== 'null' ? result.output : '浏览器未返回网络请求详情。')
    const output = JSON.stringify({ success: false, requestId: args.requestId, error: prefix(error, Math.max(0, maxChars - 512)) })
    return output.length <= maxChars ? { ...result, output } : failure(maxChars)
  }
  if (result.output.length <= maxChars) return result
  let raw: unknown
  try { raw = JSON.parse(result.output) } catch { return failure(maxChars) }
  if (!record(raw)) return failure(maxChars)
  const notes = new Set<string>()
  notes.add('此结果按引擎输出预算压缩；请结合分页游标和各正文状态判断完整性。')
  let value = compactMetadata(raw, notes) as ObjectValue
  const sourceWarnings = Array.isArray(value.warnings) ? value.warnings.filter((item): item is string => typeof item === 'string') : []
  const warnings = () => { value.warnings = [...notes, ...sourceWarnings.slice(0, 8).map(item => prefix(item, 512))] }
  warnings()

  if (action === 'network') {
    const entries = Array.isArray(value.entries) ? value.entries : []
    const originalCount = Array.isArray(raw.entries) ? raw.entries.length : entries.length
    const offset = nonnegative(value.offset)
    while (entries.length > 1 && JSON.stringify(value).length > maxChars) entries.pop()
    if (entries.length !== originalCount) {
      value.hasMore = true
      value.nextOffset = offset + entries.length
      notes.add('本页请求条目尾部已省略；使用 nextOffset 继续列出相同筛选条件的请求。')
      warnings()
    }
    // A very large first row may need metadata shortening, but its id remains exact.
    if (JSON.stringify(value).length > maxChars && entries.length && record(entries[0])) {
      const entry = entries[0]
      value.entries = [{ id: entry.id, method: entry.method, url: typeof entry.url === 'string' ? prefix(entry.url, 512) : entry.url, status: entry.status, error: entry.error }]
      if (originalCount > 1) { value.hasMore = true; value.nextOffset = offset + 1 }
      notes.add('请求条目元数据已缩短；使用稳定 id 获取详情。')
      warnings()
    }
    if (JSON.stringify(value).length > maxChars) return failure(maxChars)
    return { ...result, output: JSON.stringify(value) }
  }

  const selected = args.bodyTarget === 'request' ? 'request' : 'response'
  const other = selected === 'request' ? 'response' : 'request'
  const selectedBody = bodyAt(value, selected)
  const selectedText = textOf(selectedBody)
  const originalSelectedBody = selectedBody ? { ...selectedBody } : undefined
  const otherBody = bodyAt(value, other)
  const otherText = textOf(otherBody)
  shortenBody(otherBody, otherText, 256)
  if (otherText.length > 256) notes.add('未选中的另一侧正文仅保留首段；切换 bodyTarget 后按其游标读取。')
  shortenBody(selectedBody, selectedText, 0)
  warnings()

  // Make room for both identity/state and some useful body text before choosing its exact page length.
  const reserve = Math.min(2048, Math.floor(maxChars / 4))
  while (JSON.stringify(value).length > maxChars - reserve) {
    const largest = metadataArrays(value).find(item => item.key !== 'warnings')
    if (!largest) break
    const count = Math.floor(largest.items.length / 2)
    largest.owner[largest.key] = largest.items.slice(0, count)
    notes.add('请求/响应头、参数、Cookie 或发起方栈的尾部已省略，不能视为完整元数据。')
    warnings()
  }
  if (JSON.stringify(value).length > maxChars) {
    const entry = record(value.entry) ? value.entry : {}
    const tab = record(value.tab) ? value.tab : {}
    notes.add('其余非关键元数据已省略，仅保留请求标识及正文状态/游标。')
    value = {
      tab: { tabId: tab.tabId, navigationId: tab.navigationId },
      entry: { id: entry.id, method: entry.method, status: entry.status },
      request: { body: bodyAt(value, 'request') }, response: { body: bodyAt(value, 'response') },
    }
    warnings()
  }
  if (JSON.stringify(value).length > maxChars) return failure(maxChars)
  const currentBody = bodyAt(value, selected)
  const applySelectedLength = (count: number): void => {
    if (!currentBody || !originalSelectedBody) return
    for (const key of Object.keys(currentBody)) delete currentBody[key]
    Object.assign(currentBody, originalSelectedBody)
    shortenBody(currentBody, selectedText, count)
  }
  // Binary search counts serialized characters too: Chinese, quotes and control characters have different JSON expansion.
  let low = 0, high = selectedText.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    applySelectedLength(middle)
    if (JSON.stringify(value).length <= maxChars) low = middle
    else high = middle - 1
  }
  applySelectedLength(low)
  if (selectedText.length > 0 && textOf(currentBody).length === 0) return failure(maxChars)
  const output = JSON.stringify(value)
  return output.length <= maxChars ? { ...result, output } : failure(maxChars)
}
