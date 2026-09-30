import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash, randomBytes, randomUUID } from 'node:crypto';

// Real engine + real read_file execution. Only the model provider is deterministic.
// Default runs HTTP only. --electron additionally uses the built Aether Code UI.
// Never connects to/stops the user's service at port 12323 or inherits model credentials.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const frontendRoot = path.resolve(root, '..', 'aether-code');
const host = '10.219.14.186';
const forbiddenPort = 12323;
const withElectron = process.argv.includes('--electron');
const outputPrefix = path.join(root, 'docs', 'research', '2026-09-30-lan-remote-chat' + (withElectron ? '-electron' : '-http'));
const temporaryParent = path.join(root, '.e2e-tmp');
const fixture = path.join(temporaryParent, `isolated-lan-chat-${randomUUID()}`);
const remoteWorkspace = path.join(fixture, 'remote-workspace');
const localWorkspace = path.join(fixture, 'local-workspace');
const remoteFile = path.join(remoteWorkspace, 'fixture.txt');
const remoteMarker = 'LAN_REMOTE_FILE_' + randomBytes(8).toString('hex');
const localMarker = 'LOCAL_FILE_MUST_NEVER_BE_READ_' + randomBytes(8).toString('hex');
const entry = path.join(root, 'dist', 'main.js');
const modelId = 'lan-remote-chat-fixture';
const token = randomBytes(32).toString('hex');
const wrongToken = randomBytes(32).toString('hex');
const encryptionKey = randomBytes(32).toString('hex');
const jwtSecret = randomBytes(32).toString('hex');
const modelKey = 'local-fixture-' + randomBytes(12).toString('hex');
const secrets = [token, wrongToken, encryptionKey, jwtSecret, modelKey];
const redact = value => secrets.reduce((text, secret) => text.replaceAll(secret, '[REDACTED_SYNTHETIC_SECRET]'), String(value));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const sha256 = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
let child, app, appProcess, provider, port, environment;
let childExited = false, fixtureCreated = false;
let exitResult;
let serverLog = '', uiLog = '';
const providerRequests = [];
const providerErrors = [];
const result = {
  schemaVersion: 1, startedAt: new Date().toISOString(),
  scope: 'Same-machine LAN-address connection to an isolated real engine; NOT a cross-machine or real-model-quality test.',
  existingUserEndpoint: { host, port: forbiddenPort, contacted: false, modified: false },
  isolation: { fixture, remoteWorkspace, localWorkspace, syntheticSecrets: true, inheritedEnvironment: 'OS runtime allowlist only', paidModelRequests: 0 },
  runtime: { executable: process.execPath, nodeVersion: process.version, entry },
  electron: { requested: withElectron, started: false }, assertions: [], sessions: [], cleanup: {}
};

function check(name, callback) {
  try { callback(); result.assertions.push({ name, pass: true }); }
  catch (error) { result.assertions.push({ name, pass: false, error: redact(error.message) }); throw error; }
}

function persistEvidence(stage) {
  result.evidenceStage = stage;
  result.providerRequests = providerRequests;
  result.providerErrors = providerErrors;
  result.passedAssertions = result.assertions.filter(assertion => assertion.pass).length;
  result.totalAssertions = result.assertions.length;
  const write = (file, content) => {
    try { fs.writeFileSync(file, redact(content)); }
    catch (error) {
      result.status = 'failed';
      (result.artifactErrors ??= []).push({ file, stage, error: redact(error?.stack ?? error) });
      console.error('Could not persist fixture evidence: ' + redact(error?.message ?? error));
    }
  };
  write(outputPrefix + '-server.log', serverLog + '\n');
  if (withElectron) write(outputPrefix + '-electron.log', uiLog + '\n');
  write(outputPrefix + '-result.json', JSON.stringify(result, null, 2) + '\n');
  if (stage === 'before-cleanup') write(outputPrefix + '-before-cleanup-result.json', JSON.stringify(result, null, 2) + '\n');
}

async function cleanupStep(name, operation) {
  try { await operation(); }
  catch (error) {
    result.status = 'failed';
    (result.cleanup.errors ??= []).push({ step: name, error: redact(error?.stack ?? error) });
  }
}

async function withTimeout(promise, milliseconds, description) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(description + ' timed out')), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

const processExited = processHandle => Boolean(processHandle && (processHandle.exitCode !== null || processHandle.signalCode !== null));

async function poll(callback, description, timeout = 30000) {
  const end = Date.now() + timeout;
  let lastError;
  while (Date.now() < end) {
    try { const value = await callback(); if (value) return value; }
    catch (error) { lastError = error; }
    await sleep(100);
  }
  throw new Error(description + ' timed out' + (lastError ? ': ' + lastError.message : ''));
}

async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen({ host, port: 0, exclusive: true }, resolve); });
  const selected = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  assert.notEqual(selected, forbiddenPort);
  return selected;
}

async function request(method, route, { body, credential = token, sse = false } = {}) {
  assert.ok(port && port !== forbiddenPort, 'Refusing non-fixture engine port');
  return new Promise((resolve, reject) => {
    const headers = { connection: 'close', Accept: sse ? 'text/event-stream' : 'application/json', 'X-Aether-Tool-Profile': 'code' };
    if (credential) headers['X-Aether-Instance-Token'] = credential;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const req = http.request({ host, port, path: route, method, headers, agent: false, timeout: 45000 }, response => {
      const chunks = [];
      let bytes = 0;
      response.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > 4 * 1024 * 1024) { req.destroy(new Error('Response exceeded fixture limit')); return; }
        chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: response.statusCode, contentType: response.headers['content-type'], text, json });
      });
    });
    req.on('timeout', () => req.destroy(new Error('Engine request timed out')));
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

async function business(route) {
  const response = await request('GET', route);
  assert.equal(response.status, 200, route);
  assert.equal(response.json?.code, 200, route + ': ' + response.text.slice(0, 300));
  return response.json.data;
}

function parseSse(text) {
  return text.split(/\r?\n\r?\n/).filter(Boolean).map(block => {
    const rows = block.split(/\r?\n/);
    const data = rows.filter(row => row.startsWith('data:')).map(row => row.slice(5).trimStart()).join('\n');
    if (data === '[DONE]' || rows.includes('event: done')) return { done: true };
    try { return { data: JSON.parse(data) }; } catch { return { raw: block }; }
  });
}

function providerDelta(response, delta, finishReason = null) {
  response.write('data: ' + JSON.stringify({ id: 'lan-provider-fixture', model: modelId,
    choices: [{ index: 0, delta, finish_reason: finishReason }] }) + '\n\n');
}

function finishProvider(response, reason) {
  providerDelta(response, {}, reason);
  response.write('data: ' + JSON.stringify({ id: 'lan-provider-fixture', model: modelId, choices: [],
    usage: { prompt_tokens: 32, completion_tokens: 8, total_tokens: 40 } }) + '\n\n');
  response.end('data: [DONE]\n\n');
}

async function startProvider() {
  provider = http.createServer((incoming, response) => {
    void (async () => {
      assert.equal(incoming.method, 'POST');
      assert.equal(incoming.url, '/v1/chat/completions');
      let raw = '';
      for await (const chunk of incoming) raw += chunk.toString();
      const body = JSON.parse(raw);
      assert.equal(body.model, modelId);
      const lastUser = body.messages.findLastIndex(message => message.role === 'user');
      const prompt = JSON.stringify(body.messages[lastUser]?.content);
      const scenario = prompt.match(/\[lan-chat:(http|electron)\]/)?.[1];
      assert.ok(scenario, 'Unexpected model request outside fixture chat');
      const tools = body.messages.slice(lastUser + 1).filter(message => message.role === 'tool');
      const toolResult = JSON.stringify(tools);
      providerRequests.push({ scenario, model: body.model, toolMessages: tools.length,
        remoteMarkerSeen: toolResult.includes(remoteMarker), localMarkerSeen: toolResult.includes(localMarker) });
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      if (!tools.length) {
        assert.ok(body.tools?.some(tool => tool.function?.name === 'read_file'), 'Real engine omitted read_file tool');
        providerDelta(response, { role: 'assistant', content: `LAN_${scenario.toUpperCase()}_BEFORE_TOOL` });
        providerDelta(response, { tool_calls: [{ index: 0, id: 'read-' + scenario, type: 'function',
          function: { name: 'read_file', arguments: JSON.stringify({ path: 'fixture.txt' }) } }] });
        finishProvider(response, 'tool_calls');
        return;
      }
      assert.ok(toolResult.includes(remoteMarker), 'read_file did not return the server workspace marker');
      assert.ok(!toolResult.includes(localMarker), 'read_file resolved the client workspace instead');
      providerDelta(response, { role: 'assistant', content: `LAN_${scenario.toUpperCase()}_READ_OK: ` });
      await sleep(150);
      providerDelta(response, { content: remoteMarker });
      finishProvider(response, 'stop');
    })().catch(error => {
      providerErrors.push(redact(error.stack ?? error));
      if (!response.headersSent) response.writeHead(500, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: { message: error.message } }));
    });
  });
  await new Promise((resolve, reject) => { provider.once('error', reject); provider.listen(0, '127.0.0.1', resolve); });
  return `http://127.0.0.1:${provider.address().port}/v1`;
}

function seedDatabase(providerUrl) {
  const moduleUrl = file => pathToFileURL(path.join(root, 'dist', file)).href;
  const config = {
    LLM_PROVIDER: 'openai', LLM_PRIMARY_MODEL: modelId, LLM_MODEL: modelId,
    LLM_FALLBACK_MODEL: '', OPENAI_API_KEY: modelKey, OPENAI_BASE_URL: providerUrl,
    DEFAULT_SECURITY_MODE: 'safe', OSM_MODE: 'methodology', MAX_ITERATIONS: '5', HISTORY_BACKEND: 'jsonl'
  };
  Object.assign(environment, config);
  const seed = `const {initDb,getDb}=await import(${JSON.stringify(moduleUrl('storage/sqlite/db.js'))});
const {ModelsStore}=await import(${JSON.stringify(moduleUrl('storage/sqlite/models.js'))});
const {systemConfigStore}=await import(${JSON.stringify(moduleUrl('storage/sqlite/system-config.js'))});
await initDb();await new ModelsStore().createModel(${JSON.stringify({ tenantId: 'default', provider: 'openai', modelId,
    apiKey: modelKey, baseUrl: providerUrl, displayName: 'LAN fixture model', isEnabled: true,
    capabilities: { toolCalling: true, parallelTools: true, streamUsage: true, contextWindow: 128000 } })});
for(const [key,value] of Object.entries(${JSON.stringify(config)}))await systemConfigStore.set(key,value,key==='OPENAI_API_KEY');getDb().close();`;
  const seedFile = path.join(fixture, 'seed-model.mjs');
  fs.writeFileSync(seedFile, seed);
  const output = execFileSync(process.execPath, [seedFile], { cwd: fixture, env: environment, encoding: 'utf8', timeout: 30000, windowsHide: true });
  serverLog += 'SEED DATABASE\n' + redact(output);
}

async function verifySession(sessionId, scenario) {
  const query = '?sessionId=' + encodeURIComponent(sessionId);
  const run = await poll(async () => {
    const data = await business('/api/v1/chat/runs' + query);
    const current = data.runs.at(-1);
    if (current && ['failed', 'interrupted', 'cancelled', 'waiting'].includes(current.status)) {
      throw new Error('Unexpected run status ' + current.status + ': ' + JSON.stringify(current));
    }
    return current?.status === 'succeeded' ? current : false;
  }, 'Completed server run', 15000);
  const history = await business('/api/v1/conversation/history' + query);
  const snapshot = await business('/api/v1/chat/snapshot' + query);
  check(scenario + ': recorded run uses only explicit server workspace', () => assert.deepEqual(run.workspacePaths, [remoteWorkspace]));
  check(scenario + ': real read_file result persists in history', () => {
    assert.ok(history.some(row => row.role === 'tool' && JSON.stringify(row).includes(remoteMarker)));
    assert.ok(history.some(row => row.role === 'assistant' && JSON.stringify(row).includes('READ_OK')));
    assert.ok(!JSON.stringify(history).includes(localMarker));
  });
  check(scenario + ': completed snapshot retains run and history', () => {
    assert.equal(snapshot.run?.runId, run.runId);
    assert.equal(snapshot.run?.status, 'succeeded');
    assert.ok(JSON.stringify(snapshot.history).includes(remoteMarker));
  });
  check(scenario + ': real provider received tool result exactly once', () => {
    const calls = providerRequests.filter(call => call.scenario === scenario);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].toolMessages, 0);
    assert.equal(calls[1].remoteMarkerSeen, true);
    assert.equal(calls[1].localMarkerSeen, false);
  });
  result.sessions.push({ scenario, sessionId, runId: run.runId, status: run.status,
    workspacePaths: run.workspacePaths, historyRows: history.length, providerCalls: 2 });
}

async function runHttpChat() {
  const sessionId = 'lan-http-' + randomUUID();
  const body = { sessionId, message: '[lan-chat:http] Read fixture.txt and report its exact text.',
    model: modelId, workspacePaths: [remoteWorkspace], thinkingMode: false };
  for (const [name, credential] of [['missing', ''], ['wrong', wrongToken]]) {
    const before = providerRequests.length;
    const denied = await request('POST', '/api/v1/chat', { body, credential, sse: true });
    check('HTTP ' + name + ' token cannot start a model request', () => {
      assert.equal(denied.status, 401); assert.equal(denied.json?.code, 40100); assert.equal(providerRequests.length, before);
    });
  }
  const response = await request('POST', '/api/v1/chat', { body, sse: true });
  const events = parseSse(response.text);
  fs.writeFileSync(outputPrefix + '-sse.txt', redact(response.text));
  check('HTTP chat returns real engine SSE with terminal marker', () => {
    assert.equal(response.status, 200); assert.ok(response.contentType?.includes('text/event-stream'));
    assert.ok(events.some(event => event.done));
    assert.ok(events.some(event => event.data?.content?.includes('LAN_HTTP_READ_OK')));
    assert.ok(events.some(event => event.data?.toolResult || event.data?.toolEnd));
    assert.ok(!events.some(event => event.data?.error));
  });
  await verifySession(sessionId, 'http');
}

async function runElectronChat() {
  const requireFrontend = createRequire(path.join(frontendRoot, 'package.json'));
  const { _electron: electron, expect: baseExpect } = requireFrontend('@playwright/test');
  const expect = baseExpect.configure({ timeout: 15000 });
  const userData = path.join(fixture, 'electron-user-data');
  fs.mkdirSync(userData);
  const sessionId = 'lan-electron-' + randomUUID();
  fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ engineMode: 'embedded', autoStartEngine: false,
    lastSessionId: sessionId, lastModelId: modelId, lastFolder: localWorkspace, thinkingMode: 'off' }));
  const electronEnv = { ...environment };
  // Keep this remote-engine acceptance run in Aether's own workbench; Code OSS has a separate suite.
  electronEnv.AETHER_IDE_CODE_OSS = '0';
  delete electronEnv.AETHER_INSTANCE_TOKEN;
  delete electronEnv.ENCRYPTION_KEY;
  delete electronEnv.OPENAI_API_KEY;
  const uiErrors = [];
  app = await electron.launch({ cwd: frontendRoot, args: ['.', '--user-data-dir=' + userData], env: electronEnv, timeout: 45000 });
  appProcess = app.process();
  result.electron.started = true;
  result.electron.ownedPid = appProcess.pid;
  appProcess.stdout?.on('data', chunk => { uiLog += redact(chunk.toString()); });
  appProcess.stderr?.on('data', chunk => { uiLog += redact(chunk.toString()); });
  const page = await app.firstWindow();
  page.on('pageerror', error => uiErrors.push(error.message));
  await expect(page.locator('.status-bar')).toBeVisible();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+p' : 'Control+Shift+p');
  await page.locator('.palette__input').fill('设置');
  await page.keyboard.press('Enter');
  await expect(page.locator('.app-settings')).toBeVisible();
  await page.getByRole('tab', { name: '通用', exact: true }).click();
  await page.locator('.sg__row').filter({ has: page.locator('.sg__row-label', { hasText: /^远端服务$/ }) }).click();
  await page.locator('.sg__row').filter({ has: page.locator('.sg__row-label', { hasText: /^远端地址$/ }) }).locator('input').fill(`http://${host}:${port}`);
  await page.getByLabel('远端令牌', { exact: true }).fill(token);
  await page.getByLabel('远端工作目录', { exact: true }).fill(remoteWorkspace);
  await page.getByRole('button', { name: '保存并重启', exact: true }).click();
  await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 45000 });
  await expect(page.locator('.chat__input')).toHaveAttribute('contenteditable', 'true');
  await page.locator('.chat__input').fill('[lan-chat:electron] Read fixture.txt and report its exact text.');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.locator('.chat-panel')).toContainText('LAN_ELECTRON_READ_OK', { timeout: 45000 });
  await expect(page.locator('.chat-panel')).toContainText(remoteMarker);
  // Switching engine sources may deliberately allocate a fresh UI session ID.
  // Observe the resulting server record instead of depending on local renderer IDs.
  const sessions = await business('/api/v1/conversation/sessions');
  const uiSessions = sessions.filter(item => !result.sessions.some(record => record.sessionId === item.sessionId));
  assert.equal(uiSessions.length, 1, 'Exactly one new UI conversation should reach the server');
  await verifySession(uiSessions[0].sessionId, 'electron');
  const callsBeforeReload = providerRequests.length;
  await page.reload();
  await expect(page.locator('.chat-panel')).toContainText('LAN_ELECTRON_READ_OK');
  await expect(page.locator('.chat-panel')).toContainText(remoteMarker);
  check('Electron reload displays real persisted history without another model request', () => assert.equal(providerRequests.length, callsBeforeReload));
  const publicText = await page.locator('body').innerText();
  check('Electron has no runtime errors, token echo or client file contents', () => {
    assert.deepEqual(uiErrors, []); assert.ok(!publicText.includes(token)); assert.ok(!publicText.includes(localMarker));
  });
  await page.screenshot({ path: outputPrefix + '-ready.png', fullPage: true });
  result.electron.screenshot = outputPrefix + '-ready.png';
  result.electron.uiErrors = uiErrors;
}

try {
  assert.ok(Object.values(os.networkInterfaces()).flat().some(address => address?.family === 'IPv4' && address.address === host && !address.internal), 'LAN interface is unavailable');
  result.runtime.manifest = JSON.parse(fs.readFileSync(path.join(root, 'dist', 'runtime', 'build-manifest.json'), 'utf8'));
  result.runtime.entrySha256Before = sha256(entry);
  fs.mkdirSync(temporaryParent, { recursive: true });
  fs.mkdirSync(fixture); fixtureCreated = true;
  for (const dir of ['state', 'home', 'appdata', 'localappdata', 'programdata', 'skills', 'sandboxes', 'temp', 'global', 'remote-workspace', 'local-workspace']) fs.mkdirSync(path.join(fixture, dir));
  fs.writeFileSync(remoteFile, remoteMarker);
  fs.writeFileSync(path.join(localWorkspace, 'fixture.txt'), localMarker);
  fs.writeFileSync(path.join(fixture, 'mcp.json'), JSON.stringify({ mcpServers: {} }));
  environment = {};
  const osKeys = new Set(['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS']);
  for (const [key, value] of Object.entries(process.env)) if (osKeys.has(key.toUpperCase()) && value !== undefined) environment[key] = value;
  port = await reservePort(); result.port = port; result.host = host;
  Object.assign(environment, {
    NODE_ENV: 'production', LOG_LEVEL: 'info', HOST: host, PORT: String(port), AETHER_INSTANCE_TOKEN: token,
    AUTH_ENABLED: 'false', ENCRYPTION_KEY: encryptionKey, JWT_SECRET: jwtSecret, DATA_DIR: path.join(fixture, 'state', 'agent.db'),
    HISTORY_BACKEND: 'jsonl', AETHER_GLOBAL_DIR: path.join(fixture, 'global'), WORKSPACE_ROOT: path.join(fixture, 'sandboxes'),
    SKILLS_ROOT: path.join(fixture, 'skills'), MCP_CONFIG_PATH: path.join(fixture, 'mcp.json'),
    HOME: path.join(fixture, 'home'), USERPROFILE: path.join(fixture, 'home'), APPDATA: path.join(fixture, 'appdata'),
    LOCALAPPDATA: path.join(fixture, 'localappdata'), PROGRAMDATA: path.join(fixture, 'programdata'), TEMP: path.join(fixture, 'temp'), TMP: path.join(fixture, 'temp'),
    PUBLIC_DIR: path.join(fixture, 'absent-public'), QA_LOG_ENABLED: 'false', ENABLE_LONG_TERM_MEMORY: 'false',
    MEMORY_CONSOLIDATION_INTERVAL_HOURS: '999999', NO_PROXY: '*'
  });
  const providerUrl = await startProvider(); result.providerUrl = providerUrl;
  seedDatabase(providerUrl);
  child = spawn(process.execPath, [entry], { cwd: fixture, env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  result.ownedPid = child.pid;
  child.stdout.on('data', chunk => { serverLog += redact(chunk.toString()); });
  child.stderr.on('data', chunk => { serverLog += redact(chunk.toString()); });
  child.once('error', error => { serverLog += '\nCHILD_START_ERROR ' + redact(error.message); });
  child.once('exit', (code, signal) => { childExited = true; exitResult = { code, signal }; });
  await poll(async () => {
    if (childExited) throw new Error('Owned engine exited before ready');
    if (!serverLog.includes('Aether Engine started') || !serverLog.includes(`"port":${port}`)) return false;
    const metadata = await request('GET', '/meta', { credential: '' });
    assert.equal(metadata.json?.data?.buildId, result.runtime.manifest.buildId);
    result.runtime.observedIdentity = metadata.json.data;
    return true;
  }, 'Owned engine ready');
  const models = await business('/api/v1/models');
  check('Only the synthetic model exists in fresh isolated state', () => assert.deepEqual(models.map(model => model.modelId), [modelId]));
  const metrics = await business('/metrics');
  check('Authenticated metrics returns a successful JSON business response', () => {
    assert.equal(typeof metrics.totalRequests, 'number');
    assert.equal(typeof metrics.totalTokens, 'number');
    assert.ok(Array.isArray(metrics.toolCallStats));
  });
  await runHttpChat();
  if (withElectron) await runElectronChat();
  check('Fixture provider has no unexpected requests or failures', () => assert.deepEqual(providerErrors, []));
  check('Remote and local fixture files retain separate contents', () => {
    assert.equal(fs.readFileSync(remoteFile, 'utf8'), remoteMarker);
    assert.equal(fs.readFileSync(path.join(localWorkspace, 'fixture.txt'), 'utf8'), localMarker);
  });
  result.status = 'passed';
} catch (error) {
  result.status = 'failed'; result.error = redact(error.stack ?? error);
} finally {
  // Keep the original assertion failure and logs even if a later cleanup operation fails.
  result.cleanup.startedAt = new Date().toISOString();
  persistEvidence('before-cleanup');
  await cleanupStep('electron-close', async () => {
    if (app && !processExited(appProcess)) await withTimeout(app.close(), 10000, 'Electron close');
  });
  await cleanupStep('electron-process-exit', async () => {
    // Only use the owned ChildProcess cached while the Playwright dispatcher was live.
    // ElectronApplication.process() is no longer usable after app.close().
    if (appProcess && !processExited(appProcess)) {
      appProcess.kill('SIGTERM');
      for (let attempt = 0; attempt < 30 && !processExited(appProcess); attempt++) await sleep(100);
      if (!processExited(appProcess)) {
        appProcess.kill('SIGKILL');
        for (let attempt = 0; attempt < 30 && !processExited(appProcess); attempt++) await sleep(100);
      }
    }
  });
  result.cleanup.electronClosed = !app || processExited(appProcess);
  await cleanupStep('engine-process-exit', async () => {
    if (child && !childExited) {
      child.kill('SIGTERM');
      for (let attempt = 0; attempt < 80 && !childExited; attempt++) await sleep(100);
      if (!childExited) { child.kill('SIGKILL'); for (let attempt = 0; attempt < 40 && !childExited; attempt++) await sleep(100); }
    }
  });
  result.cleanup.childExited = !child || childExited; result.cleanup.childExit = exitResult ?? null;
  result.cleanup.providerClosed = !provider;
  await cleanupStep('provider-close', async () => {
    if (provider) {
      provider.closeAllConnections();
      if (provider.listening) await withTimeout(new Promise((resolve, reject) => provider.close(error => error ? reject(error) : resolve())), 5000, 'Provider close');
      result.cleanup.providerClosed = !provider.listening;
    }
  });
  await cleanupStep('engine-port-release', async () => {
    if (!port || !childExited) return;
    result.cleanup.portReleased = false;
    const listener = net.createServer();
    try {
      await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen({ host, port, exclusive: true }, resolve); });
      result.cleanup.portReleased = true;
    } finally {
      if (listener.listening) await new Promise((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
    }
  });
  await cleanupStep('artifact-integrity', async () => {
    result.runtime.entrySha256After = fs.existsSync(entry) ? sha256(entry) : null;
    result.cleanup.entryUnchanged = result.runtime.entrySha256Before === result.runtime.entrySha256After;
  });
  await cleanupStep('fixture-removal', async () => {
    if (!fixtureCreated || (child && !childExited) || !result.cleanup.electronClosed || result.cleanup.providerClosed === false) return;
    result.cleanup.fixtureRemoved = false;
    const actualParent = fs.realpathSync(temporaryParent), actualFixture = fs.realpathSync(fixture);
    if (path.dirname(actualFixture).toLowerCase() !== actualParent.toLowerCase() || !path.basename(actualFixture).startsWith('isolated-lan-chat-')) {
      throw new Error('Resolved path safety check refused deletion');
    }
    fs.rmSync(actualFixture, { recursive: true, force: false, maxRetries: 5, retryDelay: 150 });
    result.cleanup.fixtureRemoved = !fs.existsSync(actualFixture);
  });
  if (!result.cleanup.childExited || result.cleanup.portReleased === false || result.cleanup.fixtureRemoved === false || !result.cleanup.entryUnchanged || !result.cleanup.electronClosed) result.status = 'failed';
  result.finishedAt = new Date().toISOString();
  persistEvidence('after-cleanup');
  console.log(JSON.stringify({ status: result.status, mode: withElectron ? 'HTTP + Electron' : 'HTTP only', host, port,
    assertions: `${result.passedAssertions}/${result.totalAssertions}`, providerRequests: providerRequests.length,
    cleanup: result.cleanup, error: result.error, resultFile: outputPrefix + '-result.json' }));
  process.exitCode = result.status === 'passed' ? 0 : 1;
}
