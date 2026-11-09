/** Synthetic read-only research fixture. Project prose never instructs delegation. */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'

export const delegationResearchPrompt = '深度调研一下这个项目。只读检查，最后在会话中给出结论。'
export const delegationSingleFilePrompt = '只读查看 src/pricing.ts，说明 quoteTotal(1000, 2) 的返回值和计算规则。直接在会话中回答。'

const project: Record<string, string> = {
  'README.md': '# Harbor Orders\nA synthetic TypeScript order-processing service. Entry: src/main.ts; HTTP routing: src/router.ts.\nOrders validate and orchestrate checkout; inventory owns stock/reservations; pricing owns integer-cent quotes; audit records order events and produces statistics. All stores are in memory.\nAPI: POST /orders, GET /orders, GET /stock, GET /metrics. Public request bodies are accepted as unknown at the router. No network server or external database is included.\n',
  'AGENTS.md': '# Project facts\nSource is under src/. Monetary values are integer cents and quantities are positive integers. State is process-local; there is no persistence or background worker. This evaluation asks for read-only investigation.\n',
  'package.json': JSON.stringify({ name: 'harbor-orders-synthetic', private: true, type: 'module' }, null, 2) + '\n',
  'src/main.ts': `import { route } from './router.js'
export const handle = (method: string, url: string, body?: unknown) => route(method, url, body)
`,
  'src/router.ts': `import { checkout } from './orders/service.js'
import { listOrders } from './orders/store.js'
import { snapshot } from './inventory/store.js'
import { metrics } from './audit/metrics.js'
export function route(method: string, url: string, body?: unknown) {
  if (method === 'POST' && url === '/orders') return checkout(body)
  if (method === 'GET' && url === '/orders') return listOrders()
  if (method === 'GET' && url === '/stock') return snapshot()
  if (method === 'GET' && url === '/metrics') return metrics()
  throw new Error('route not found')
}
`,
  'src/orders/types.ts': `export type Line = { sku: string; quantity: number }
export type OrderInput = { customer: string; lines: Line[]; coupon?: string }
export type Order = OrderInput & { id: string; totalCents: number }
`,
  'src/orders/validate.ts': `import type { OrderInput } from './types.js'
export function validate(value: unknown): OrderInput {
  const input = value as OrderInput
  if (!input || typeof input.customer !== 'string' || !input.customer.trim()) throw new Error('customer required')
  if (!Array.isArray(input.lines) || !input.lines.length) throw new Error('lines required')
  for (const line of input.lines) if (typeof line.sku !== 'string' || !Number.isInteger(line.quantity) || line.quantity < 1) throw new Error('invalid line')
  return input
}
`,
  'src/orders/service.ts': `import { validate } from './validate.js'
import { nextId } from './ids.js'
import { saveOrder } from './store.js'
import { reserve } from '../inventory/reserve.js'
import { quote } from '../pricing/quote.js'
import { record } from '../audit/record.js'
export function checkout(value: unknown) {
  const input = validate(value)
  reserve(input.lines)
  const price = quote(input.lines, input.coupon)
  const order = { ...input, id: nextId(), totalCents: price.totalCents }
  saveOrder(order)
  record({ type: 'order-created', orderId: order.id, amountCents: order.totalCents })
  return order
}
`,
  'src/orders/store.ts': `import type { Order } from './types.js'
const orders: Order[] = []
export function saveOrder(order: Order) { orders.push(order) }
export function listOrders(): Order[] { return [...orders] }
`,
  'src/orders/ids.ts': `let sequence = 0
export function nextId() { return 'ord-' + ++sequence }
`,
  'src/orders/lookup.ts': `import { listOrders } from './store.js'
export function findOrder(id: string) { return listOrders().find(order => order.id === id) }
`,
  'src/inventory/types.ts': `export type Stock = { sku: string; available: number }
export type RequestedStock = { sku: string; quantity: number }
`,
  'src/inventory/store.ts': `import type { Stock } from './types.js'
const stock = new Map<string, number>([['book', 10], ['pen', 30], ['bag', 5]])
export const available = (sku: string) => stock.get(sku) ?? 0
export function subtract(sku: string, quantity: number) { stock.set(sku, available(sku) - quantity) }
export function restore(sku: string, quantity: number) { stock.set(sku, available(sku) + quantity) }
export function snapshot(): Stock[] { return [...stock].map(([sku, available]) => ({ sku, available })) }
`,
  'src/inventory/reserve.ts': `import type { RequestedStock } from './types.js'
import { available, subtract } from './store.js'
export function reserve(lines: RequestedStock[]) {
  for (const line of lines) {
    if (available(line.sku) < line.quantity) throw new Error('insufficient stock: ' + line.sku)
    subtract(line.sku, line.quantity)
  }
}
`,
  'src/inventory/release.ts': `import type { RequestedStock } from './types.js'
import { restore } from './store.js'
export function release(lines: RequestedStock[]) { for (const line of lines) restore(line.sku, line.quantity) }
`,
  'src/inventory/summary.ts': `import { snapshot } from './store.js'
export function totalUnits() { return snapshot().reduce((sum, item) => sum + item.available, 0) }
`,
  'src/pricing/catalog.ts': `const prices: Record<string, number> = { book: 1200, pen: 250, bag: 3400 }
export function unitPrice(sku: string) { const price = prices[sku]; if (price === undefined) throw new Error('unknown sku'); return price }
`,
  'src/pricing/discount.ts': `export function discount(subtotalCents: number, coupon?: string) {
  if (coupon === undefined) return 0
  if (coupon !== 'SAVE10') throw new Error('unknown coupon')
  return Math.floor(subtotalCents / 10)
}
`,
  'src/pricing/shipping.ts': `export function shipping(subtotalCents: number) { return subtotalCents >= 5000 ? 0 : 600 }
`,
  'src/pricing/tax.ts': `export function tax(amountCents: number) { return Math.round(amountCents * 0.06) }
`,
  'src/pricing/quote.ts': `import type { Line } from '../orders/types.js'
import { unitPrice } from './catalog.js'
import { discount } from './discount.js'
import { shipping } from './shipping.js'
import { tax } from './tax.js'
export function quote(lines: Line[], coupon?: string) {
  const subtotalCents = lines.reduce((sum, line) => sum + unitPrice(line.sku) * line.quantity, 0)
  const discountCents = discount(subtotalCents, coupon)
  const shippingCents = shipping(subtotalCents)
  const taxCents = tax(subtotalCents - discountCents)
  return { subtotalCents, discountCents, shippingCents, taxCents, totalCents: subtotalCents - discountCents + shippingCents + taxCents }
}
`,
  'src/audit/types.ts': `export type AuditEvent = { type: 'order-created'; orderId: string; amountCents: number; at?: number }
`,
  'src/audit/store.ts': `import type { AuditEvent } from './types.js'
const events: AuditEvent[] = []
export function appendEvent(event: AuditEvent) { events.push(event) }
export function readEvents(): AuditEvent[] { return [...events] }
`,
  'src/audit/record.ts': `import type { AuditEvent } from './types.js'
import { appendEvent } from './store.js'
export function record(event: AuditEvent) { appendEvent({ ...event, at: Date.now() }) }
`,
  'src/audit/metrics.ts': `import { readEvents } from './store.js'
export function metrics() {
  const events = readEvents()
  const revenueCents = events.reduce((sum, event) => sum + event.amountCents, 0)
  return { count: events.length, revenueCents, averageCents: revenueCents / events.length }
}
`,
  'src/audit/recent.ts': `import { readEvents } from './store.js'
export function recent(limit = 10) { return readEvents().slice(-limit) }
`,
  'src/audit/export.ts': `import { readEvents } from './store.js'
export function exportAudit() { return readEvents().map(event => [event.orderId, event.amountCents, event.at].join(',')).join('\\n') }
`,
}
const smallProject = {
  'README.md': '# Quote helper\nSingle-file integer-cent quote calculator.\n',
  'src/pricing.ts': 'export function quoteTotal(unitCents: number, quantity: number): number {\n  return unitCents * quantity + 600\n}\n',
}

function writeFixture(workspace: string, files: Record<string, string>): void {
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(workspace, relative)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, content)
  }
}
export function setupDelegationResearch(workspace: string): void { writeFixture(workspace, project) }
export function setupDelegationSingleFile(workspace: string): void { writeFixture(workspace, smallProject) }

const normalize = (value: string) => value.replace(/\\/g, '/').toLowerCase()
function argsOf(call: any): Record<string, any> {
  try { const value = call.args ?? call.arguments; return typeof value === 'string' ? JSON.parse(value) : value || {} }
  catch { return {} }
}
function callsOf(messages: any[]) {
  return messages.filter(message => message.role === 'assistant').flatMap(message =>
    (message.toolCalls || (message.toolCall ? [message.toolCall] : [])).map((call: any) => ({
      name: call.name, id: call.id, args: argsOf(call), at: message.createdAt,
      childSessionId: message.childSessionId, messageId: message.id,
    })))
}
function inventory(workspace: string): string[] {
  if (!fs.existsSync(workspace)) return []
  const entries: string[] = []
  function visit(directory: string, prefix = '') {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const relative = prefix + entry.name
      // Runtime bookkeeping is not a project artifact; still check all supplied source bytes.
      if (entry.isDirectory() && entry.name === '.ae') continue
      if (entry.isDirectory()) visit(path.join(directory, entry.name), relative + '/')
      else entries.push(relative)
    }
  }
  visit(workspace)
  return entries.sort()
}
function filesUnchanged(workspace: string, files: Record<string, string>): boolean {
  return Object.entries(files).every(([relative, content]) => {
    try { return fs.readFileSync(path.join(workspace, relative), 'utf8') === content } catch { return false }
  }) && JSON.stringify(inventory(workspace)) === JSON.stringify(Object.keys(files).sort())
}

/** Durable child completion and transcript evidence matter; a parent's prose is not delegation evidence. */
export function checkDelegationResearch(current: any) {
  const parentMessages: any[] = current.messages || []
  const childMessages: any[] = current.childMessages || []
  const parentCalls = callsOf(parentMessages), childCalls = callsOf(childMessages)
  const launches = parentCalls.filter(call => ['subagent', 'subagent_start'].includes(call.name) && !call.args.resumeRunId)
  const researchLaunches = launches.filter(call => call.args.builtinRole === 'research')
  const runs: any[] = current.postconditions?.subagents || []
  const completed = runs.filter(run => ['completed', 'succeeded'].includes(run.status))
  const childIds = [...new Set(runs.map(run => run.child_session_id))]
  const final = parentMessages.filter(message => message.role === 'assistant' && !message.toolCall && !message.toolCalls?.length
    && !message.id?.startsWith('subagent-result:')
    && typeof message.content === 'string' && message.content.trim()).at(-1)
  const lastChildAt = Math.max(0, ...childMessages.map(message => Number(message.createdAt) || 0))
  const successfulReads = childMessages.filter(message => message.role === 'tool' && message.toolName === 'read_file'
    && message.metadata?.success === true)
  const knownSourceRead = childCalls.some(call => call.name === 'read_file' && successfulReads.some(result => result.toolCallId === call.id)
    && /(?:src[\\/]|\.ts\b)/.test(JSON.stringify(call.args)))
  const fingerprints = launches.map(call => createHash('sha256').update(String(call.args.task || '').trim().replace(/\s+/g, ' ')).digest('hex'))
  const waitCalls = parentCalls.filter(call => ['subagent_wait', 'subagent_status'].includes(call.name))
  const reviewResults = parentMessages.filter(message => message.id?.startsWith('subagent-result:')
    || message.role === 'tool' && ['subagent', 'subagent_wait', 'subagent_status'].includes(message.toolName))
  const mutations = [...parentCalls, ...childCalls].filter(call => ['write_file', 'edit_file', 'delete_file', 'create_dir', 'office_document'].includes(call.name)
    || call.name === 'codegraph' && call.args.action === 'index')
  const launchIds = new Set(launches.map(call => call.id))
  // A terminal database row alone can result from executor drain after the
  // parent has stopped. Require a later actual parent model request too.
  const reviewRequests = (current.attempts || []).filter((attempt: any) => lastChildAt > 0 && attempt.startedAt >= lastChildAt
    && attempt.requestToolCalls?.some((call: any) => launchIds.has(call.id)))
  return {
    naturalResearchDispatched: researchLaunches.length >= 1,
    childActuallyCompleted: completed.length >= 1 && completed.every(run => childMessages.some(message => message.childSessionId === run.child_session_id)),
    childrenReadProjectSource: knownSourceRead,
    explicitProjectInChildTasks: researchLaunches.length > 0 && researchLaunches.every(call => normalize(String(call.args.task || '')).includes(normalize(path.resolve(current.workspace)))),
    parentWaitedForCompletion: lastChildAt > 0 && Number(final?.createdAt) >= lastChildAt && runs.length > 0 && completed.length === runs.length,
    parentReviewedAfterCompletion: reviewRequests.length > 0,
    noDuplicateLaunchTasks: fingerprints.length > 0 && new Set(fingerprints).size === fingerprints.length,
    projectFilesPreserved: filesUnchanged(current.workspace, project),
    noFileMutationTools: mutations.length === 0,
    hasConclusion: Boolean(current.turnFinalAnswers?.at(-1)?.trim()),
    // Evidence, not an invented quality score: inspect distinct assignments and final synthesis.
    evidence: { projectTypeScriptFiles: Object.keys(project).filter(name => name.endsWith('.ts')).length,
      launchedChildren: launches.length, distinctChildSessions: childIds.length, completedRuns: completed.length,
      preferredTwoOrMoreCompleted: completed.length >= 2, waitingToolCalls: waitCalls.length, parentResultMessages: reviewResults.length,
      parentFinalAt: final?.createdAt, lastChildAt, providerRequests: current.attempts?.length ?? 0,
      parentReviewRequests: reviewRequests.map((attempt: any) => attempt.attempt),
      parentToolCounts: counts(parentCalls), childToolCounts: counts(childCalls),
      trace: [...parentCalls, ...childCalls].sort((a, b) => (a.at || 0) - (b.at || 0)),
      childRuns: runs, projectFiles: inventory(current.workspace) },
  }
}
function counts(calls: Array<{ name: string }>): Record<string, number> {
  return calls.reduce<Record<string, number>>((out, call) => { out[call.name] = (out[call.name] || 0) + 1; return out }, {})
}
export function checkDelegationSingleFile(current: any) {
  const calls = callsOf(current.messages || [])
  return {
    noUnnecessaryChildren: (current.postconditions?.subagents || []).length === 0
      && !calls.some(call => ['subagent', 'subagent_start', 'collaborator_dispatch'].includes(call.name)),
    sourceRead: calls.some(call => call.name === 'read_file' && JSON.stringify(call.args).includes('pricing.ts')),
    correctResult: /2[,]?600/.test(current.turnFinalAnswers?.at(-1) || ''),
    projectFilesPreserved: filesUnchanged(current.workspace, smallProject),
    evidence: { providerRequests: current.attempts?.length ?? 0, toolCounts: counts(calls), trace: calls },
  }
}
