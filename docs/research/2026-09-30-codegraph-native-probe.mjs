// Run with native Node or ELECTRON_RUN_AS_NODE; no Vitest/Vite interop or model calls.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const engineRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const runtimeRoot = path.resolve(process.argv[2] || engineRoot);
const label = process.argv[3] || 'native-node';
assert.match(label, /^[a-z0-9-]+$/);
const parent = fs.realpathSync(os.tmpdir());
const fixture = fs.mkdtempSync(path.join(parent, 'aether-codegraph-native-'));
const project = path.join(fixture, 'project');
fs.mkdirSync(project);
const report = { runtimeRoot, node: process.versions.node, electron: process.versions.electron,
  executable: process.execPath, fixture, checks: [], status: 'running', network: 'loopback fixture only', modelCalls: 0 };
let app, runner;
const check = (name, callback) => { callback(); report.checks.push(name); console.log('[passed] ' + name); };
const moduleUrl = relative => pathToFileURL(path.join(runtimeRoot, 'dist', relative)).href;
Object.assign(process.env, { WORKSPACE_ROOT: path.join(fixture, 'scratch'),
  AETHER_GLOBAL_DIR: path.join(fixture, 'global'), DATA_DIR: path.join(fixture, 'state.db'),
  MCP_CONFIG_PATH: path.join(fixture, 'no-mcp.json'), ENABLE_LONG_TERM_MEMORY: 'false' });

async function settle() {
  const deadline = Date.now() + 30000;
  while (runner.isIndexRunning() && Date.now() < deadline) await delay(25);
  assert.equal(runner.isIndexRunning(), false, 'index timeout');
  assert.equal(runner.getIndexRunState()?.phase, 'complete', JSON.stringify(runner.getIndexRunState()));
}

try {
  console.log('[runtime] ' + runtimeRoot + ' Node ' + process.versions.node);
  fs.writeFileSync(path.join(project, 'invoice.ts'), [
    'export function subtotal(price: number, count: number): number { return price * count }',
    'export function invoice(): number { return subtotal(12, 3) }',
    'export function renderInvoice(): string { return String(invoice()) }',
  ].join('\n'));
  const { loadCodeGraph } = await import(moduleUrl('tools/codegraph/codegraph-module.js'));
  const { codegraphTool } = await import(moduleUrl('tools/codegraph/codegraph-tool.js'));
  const { codegraphRoutes } = await import(moduleUrl('api/http/routes/codegraph.js'));
  const { detectCodegraphAvailability } = await import(moduleUrl('core/codegraph-prompt.js'));
  runner = await import(moduleUrl('tools/codegraph/index-runner.js'));
  const Graph = await loadCodeGraph();
  check('compiled native ESM loader resolves actual installed SDK', () => assert.equal(typeof Graph.openSync, 'function'));
  const ctx = { tenantId: 'fixture', sessionId: 'fixture', cwd: project, projectRoot: project, workspacePaths: [project] };
  const query = async args => {
    const result = await codegraphTool.execute({ path: project, ...args }, ctx);
    assert.equal(result.success, true, result.output);
    return result.output;
  };
  const fresh = await query({ action: 'status' });
  check('screenshot status action reports unindexed without module failure', () => assert.match(fresh, /尚无 codegraph 索引/));
  const Fastify = createRequire(path.join(runtimeRoot, 'package.json'))('fastify');
  app = Fastify();
  await app.register(codegraphRoutes, { prefix: '/api/v1' });
  const base = await app.listen({ host: '127.0.0.1', port: 0 });
  const http = async (route, body) => {
    const response = await fetch(base + '/api/v1/codegraph/' + route, {
      method: body === undefined ? 'GET' : 'POST', redirect: 'error',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000),
    });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.code, 200, JSON.stringify(result));
    return result.data;
  };
  const initial = await http('status?path=' + encodeURIComponent(project));
  check('actual HTTP status uses the same loader', () => { assert.equal(initial.initialized, false); assert.equal(initial.error, undefined); });
  const created = await query({ action: 'index' });
  assert.match(created, /已开始/);
  await settle();
  check('agent index action parses real TypeScript into SQLite', () => assert.equal(runner.getIndexRunState().filesIndexed, 1));
  for (const [action, queryName, expected] of [
    ['status', undefined, '状态: complete'], ['files', undefined, 'invoice.ts'],
    ['search', 'subtotal', 'function subtotal'], ['callers', 'subtotal', '← function invoice'],
    ['callees', 'invoice', '→ function subtotal'], ['impact', 'subtotal', 'function renderInvoice'],
  ]) {
    const output = await query({ action, query: queryName });
    check('agent ' + action + ' returns actual graph data', () => assert.ok(output.includes(expected), output));
  }
  const graph = Graph.openSync(project);
  try { check('closed graph reopens with persisted rows', () => assert.equal(graph.getStats().fileCount, 1)); }
  finally { graph.close(); }
  const availability = await detectCodegraphAvailability([project]);
  check('prompt detector finds the real index', () => assert.deepEqual(availability.indexedRoots, [project]));
  fs.writeFileSync(path.join(project, 'discount.ts'), 'export function applyDiscount(n: number): number { return n * 0.9 }\n');
  const rebuild = await http('index', { path: project, force: true });
  assert.equal(rebuild.started, true);
  await settle();
  const status = await http('status?path=' + encodeURIComponent(project));
  check('HTTP rebuild updates the actual indexed files', () => { assert.equal(status.run.phase, 'complete'); assert.equal(status.stats.fileCount, 2); });
  const updated = await query({ action: 'search', query: 'applyDiscount' });
  check('agent can query symbols added by HTTP rebuild', () => assert.match(updated, /function applyDiscount/));
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.error = error.stack || String(error); process.exitCode = 1;
} finally {
  await app?.close();
  // Only remove this run's unique temp directory after all index writers stopped.
  const resolved = fs.realpathSync(fixture);
  if (path.dirname(resolved) !== parent || !path.basename(resolved).startsWith('aether-codegraph-native-') || fs.lstatSync(fixture).isSymbolicLink()) {
    throw new Error('Unsafe fixture cleanup target');
  }
  if (!runner?.isIndexRunning()) { fs.rmSync(resolved, { recursive: true, force: true }); report.fixtureRemoved = true; }
  else { report.fixtureRemoved = false; report.status = 'failed'; process.exitCode = 1; }
  const output = path.join(engineRoot, 'docs/research', `2026-09-30-codegraph-${label}-result.json`);
  fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ status: report.status, checks: report.checks.length, node: report.node, fixtureRemoved: report.fixtureRemoved, output, error: report.error }));
}
