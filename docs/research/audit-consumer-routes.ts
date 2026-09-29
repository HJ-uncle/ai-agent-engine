/** Research probe: checks the real server registration against literal IDE request paths.
 * No socket listener, external model, production DB, or existing user session is used.
 */
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

const engineRoot = process.cwd()
const consumerRoot = path.resolve(engineRoot, '..', 'aether-code')
const evidenceDir = path.join(engineRoot, 'docs', 'research')
const fixtureBase = path.join(engineRoot, '.e2e-tmp')
fs.mkdirSync(fixtureBase, { recursive: true })
const fixture = fs.mkdtempSync(path.join(fixtureBase, 'consumer-route-audit-'))
Object.assign(process.env, {
  DATA_DIR: path.join(fixture, 'agent.db'), WORKSPACE_ROOT: path.join(fixture, 'workspace'),
  AETHER_GLOBAL_DIR: path.join(fixture, 'global'), SKILLS_ROOT: path.join(fixture, 'skills'),
  PUBLIC_DIR: path.join(fixture, 'public-not-created'), AUTH_ENABLED: 'true',
  ENABLE_LONG_TERM_MEMORY: 'false', ENCRYPTION_KEY: '1'.repeat(64), LOG_LEVEL: 'silent'
})
delete process.env.ENGINE_VERSION

type Call = { file: string; line: number; method: string; path: string; normalizedPath: string; matched?: boolean }
const calls: Call[] = []
function files(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? files(path.join(dir, entry.name)) : /\.tsx?$/.test(entry.name) ? [path.join(dir, entry.name)] : [])
}
function literal(node: ts.Expression): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text
  if (ts.isTemplateExpression(node)) return node.head.text + node.templateSpans.map(span => '__audit__' + span.literal.text).join('')
  return null
}
for (const file of files(path.join(consumerRoot, 'src'))) {
  const ast = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
  function walk(node: ts.Node): void {
    if (ts.isObjectLiteralExpression(node)) {
      const props = new Map(node.properties.filter(ts.isPropertyAssignment).map(p => [p.name.getText(ast), p.initializer]))
      const routeNode = props.get('path')
      const route = routeNode && literal(routeNode)
      if (route?.startsWith('/')) {
        const methodNode = props.get('method')
        let method = methodNode ? literal(methodNode) : null
        if (!method && ts.isCallExpression(node.parent) && /startStream$/.test(node.parent.expression.getText(ast))) method = 'POST'
        if (method && /^(GET|POST|PUT|PATCH|DELETE)$/.test(method)) {
          const normalized = /^\/(health|metrics|openapi\.json)(\/|$)/.test(route) ? route : '/api/v1' + route
          calls.push({ file: path.relative(consumerRoot, file).replaceAll('\\', '/'),
            line: ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1,
            method, path: route, normalizedPath: normalized })
        }
      }
    }
    ts.forEachChild(node, walk)
  }
  walk(ast)
}

const { initDb, closeDb } = await import('../../src/storage/sqlite/db.js')
await initDb()
const { buildServer } = await import('../../src/api/http/server.js')
const { cronScheduler } = await import('../../src/scheduler/cron-scheduler.js')
// Scheduling is irrelevant to route matching, and this audit must never launch a task.
cronScheduler.start = () => undefined
const app = await buildServer()
await app.ready()
for (const call of calls) call.matched = !!app.findRoute({ method: call.method as 'GET', url: call.normalizedPath })
const probes = []
for (const request of [
  { method: 'GET' as const, url: '/health' },
  { method: 'GET' as const, url: '/meta' },
  { method: 'GET' as const, url: '/api/v1/subagent/runs?parentSessionId=audit-empty-parent' },
  { method: 'POST' as const, url: '/api/v1/subagent/cancel', payload: { sessionId: 'audit-empty-parent', toolCallId: 'missing' } },
  { method: 'POST' as const, url: '/api/v1/subagent/runs/audit-missing-run/cancel', payload: {} }
]) {
  const response = await app.inject({ ...request, headers: { 'x-aether-tool-profile': 'code' } })
  probes.push({ method: request.method, url: request.url, httpStatus: response.statusCode, body: response.json() })
}
if (fs.existsSync(path.join(engineRoot, 'dist'))) {
  process.chdir(path.join(engineRoot, 'dist'))
  try {
    const response = await app.inject({ method: 'GET', url: '/meta' })
    probes.push({ method: 'GET', url: '/meta (cwd=engine/dist; ENGINE_VERSION absent)', httpStatus: response.statusCode, body: response.json() })
  } finally { process.chdir(engineRoot) }
}
const result = { capturedAt: new Date().toISOString(), fixture, scope: 'Literal IDE request objects only; dynamic/generated paths and request bodies require separate review. Route match is not behavior or authorization validation.',
  callSites: calls.length, matched: calls.filter(c => c.matched).length, unmatched: calls.filter(c => !c.matched), calls, probes }
fs.writeFileSync(path.join(evidenceDir, 'aether-code-route-contract.json'), JSON.stringify(result, null, 2))
fs.writeFileSync(path.join(evidenceDir, 'engine-registered-routes.txt'), app.printRoutes({ commonPrefix: false }))
await app.close()
closeDb()
console.log(JSON.stringify({ callSites: result.callSites, matched: result.matched, unmatched: result.unmatched, probes }, null, 2))
// The imported task-queue module owns an interval, unrelated to this closed in-process probe.
process.exit(0)
