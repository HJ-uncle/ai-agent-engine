/** Synthetic project only: no user repository content is sent to a provider. */
import fs from 'node:fs'
import path from 'node:path'

const files: Record<string, string> = {
  'AGENTS.md': '# Project rules\nResearch is read-only. Check current source when describing behavior.\n',
  'README.md': '# Parcel Desk\nA small TypeScript service that quotes parcel shipping and keeps an in-memory quote history.\nEntry point: src/main.ts. Public requests flow through the router to the quote service.\n',
  'package.json': JSON.stringify({ name: 'parcel-desk-eval', private: true, type: 'module', scripts: { check: 'tsc --noEmit' } }, null, 2) + '\n',
  'src/main.ts': `import { routeRequest } from './router.js'
export function handleRequest(path: string, weight: number): string {
  return JSON.stringify(routeRequest(path, weight))
}
`,
  'src/router.ts': `import { createQuote, listQuotes } from './quotes.js'
export function routeRequest(path: string, weight: number) {
  if (path === '/quote') return createQuote(weight)
  if (path === '/history') return listQuotes()
  throw new Error('Unknown route')
}
`,
  'src/quotes.ts': `import { shippingCost } from './pricing.js'
import { saveQuote, readQuotes } from './store.js'
export function createQuote(weight: number) {
  const quote = { weight, cost: shippingCost(weight) }
  saveQuote(quote)
  return quote
}
export function listQuotes() { return readQuotes() }
`,
  'src/pricing.ts': `export function shippingCost(weight: number): number {
  return weight * 3 + 5
}
`,
  'src/store.ts': `type Quote = { weight: number; cost: number }
const quotes: Quote[] = []
export function saveQuote(quote: Quote) { quotes.push(quote) }
export function readQuotes(): Quote[] { return [...quotes] }
`,
}

export function setupCodegraphResearch(workspace: string): void {
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(workspace, relative)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, content)
  }
}

export function checkCodegraphResearch(current: any, indexed: boolean) {
  const messages = current.workflowMessages || current.messages || []
  const calls = messages.filter((m: any) => m.role === 'assistant')
    .flatMap((m: any) => m.toolCalls || (m.toolCall ? [m.toolCall] : []))
  const argsOf = (call: any) => {
    const raw = call.args ?? call.arguments
    try { return typeof raw === 'string' ? JSON.parse(raw) : raw || {} }
    catch { return {} }
  }
  const graphCalls = calls.filter((call: any) => call.name === 'codegraph').map((call: any) => {
    return argsOf(call)
  })
  const actions = graphCalls.map((call: any) => call.action)
  const firstRequest = current.attempts.find((a: any) => a.toolCount > 0)
  const successfulGraphResults = messages.filter((m: any) => m.role === 'tool' && m.toolName === 'codegraph'
    && m.metadata?.success === true)
  return {
    graphActions: actions,
    ...(indexed ? {
      definitionVisibleInitially: firstRequest?.toolNames?.includes('codegraph') === true,
      indexQueried: graphCalls.length > 0 && successfulGraphResults.length > 0,
      statusQueried: actions.includes('status'),
      structureQueried: actions.some((action: string) => ['files', 'search', 'callers', 'callees'].includes(action)),
      explicitCorrectRoot: graphCalls.every((call: any) => typeof call.path === 'string'
        && path.resolve(call.path) === path.resolve(current.workspace)),
    } : {
      noUnindexedQueries: graphCalls.length === 0,
      noIndexCreated: !fs.existsSync(path.join(current.workspace, '.ae', 'codegraph.db')),
    }),
    sourceRead: calls.some((call: any) => call.name === 'read_file' && JSON.stringify(argsOf(call)).includes('.ts')),
    noIndexBuild: !actions.includes('index'),
    projectFilesPreserved: Object.entries(files).every(([relative, content]) => {
      try { return fs.readFileSync(path.join(current.workspace, relative), 'utf8') === content }
      catch { return false }
    }),
    hasConclusion: Boolean(current.turnFinalAnswers?.at(-1)?.trim()),
  }
}
