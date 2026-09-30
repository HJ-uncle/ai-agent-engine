import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';

// Read-only HTTP probes against a new engine process. No user service is stopped,
// no model endpoint is called, and only this harness's uniquely named fixture is removed.
const root = 'D:\\dev\\ai-agent-engine';
const host = '10.219.14.186';
const forbiddenPort = 12323;
const outputPrefix = path.join(root, 'docs', 'research', '2026-09-30-isolated-lan-auth');
const temporaryParent = path.join(root, '.e2e-tmp');
const fixture = path.join(temporaryParent, `isolated-lan-auth-${randomUUID()}`);
const entry = path.join(root, 'dist', 'main.js');
const manifestPath = path.join(root, 'dist', 'runtime', 'build-manifest.json');
const token = randomBytes(32).toString('hex');
const wrongToken = randomBytes(32).toString('hex');
const encryptionKey = randomBytes(32).toString('hex');
const jwtSecret = randomBytes(32).toString('hex');
const redactions = [token, wrongToken, encryptionKey, jwtSecret];
const redact = value => redactions.reduce((text, secret) => text.replaceAll(secret, '[REDACTED_SYNTHETIC_SECRET]'), String(value));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const sha256 = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
let child;
let childExited = false;
let exitResult;
let serverLog = '';
let port;
let ready = false;
let fixtureCreated = false;
const startedAt = new Date().toISOString();
const result = {
  schemaVersion: 1,
  startedAt,
  scope: 'same-machine HTTP to a real isolated engine bound to the LAN IPv4 address; NOT a cross-machine test',
  assertionScope: 'instance-authentication gate only; endpoint business functionality is asserted only where expectedBusinessCode is provided',
  existingUserEndpoint: { host, port: forbiddenPort, contacted: false, modified: false },
  host,
  runtime: { executable: process.execPath, version: process.version, entry },
  isolation: {
    workingDirectory: fixture,
    fixtureRoot: fixture,
    inheritedEnvironment: 'allowlist of OS runtime variables only; no inherited application credentials',
    instanceToken: 'synthetic random 32-byte token, never recorded',
    encryptionKey: 'synthetic random 32-byte key, never recorded',
    tenantAuthentication: 'AUTH_ENABLED=false; verifies instance gate is independent',
    state: 'fresh main/memory DB, HOME/USERPROFILE/APPDATA/LOCALAPPDATA/PROGRAMDATA, skills, MCP and workspace paths under fixture',
    modelRequests: 0,
    electronStarted: false,
  },
  probes: [],
  observations: [],
  cleanup: {},
};

function request(method, target, auth = 'none', timeoutMs = 2500) {
  if (!port || port === forbiddenPort) throw new Error('Refusing non-fixture port');
  return new Promise((resolve, reject) => {
    const headers = { connection: 'close' };
    if (auth === 'correct') headers['x-aether-instance-token'] = token;
    if (auth === 'wrong') headers['x-aether-instance-token'] = wrongToken;
    const req = http.request({ host, port, path: target, method, headers, agent: false, timeout: timeoutMs }, res => {
      let bytes = 0;
      const chunks = [];
      res.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > 1024 * 1024) { req.destroy(new Error('Probe response exceeded 1 MiB')); return; }
        chunks.push(chunk);
      });
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, bytes, contentType: res.headers['content-type'], json, text });
      });
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('Probe request timeout')));
    req.on('error', reject);
    req.end();
  });
}

async function reservePort() {
  const listener = net.createServer();
  await new Promise((resolve, reject) => {
    listener.once('error', reject);
    listener.listen({ host, port: 0, exclusive: true }, resolve);
  });
  const selected = listener.address().port;
  await new Promise((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  if (selected === forbiddenPort) throw new Error('Reserved the user port unexpectedly');
  return selected;
}

async function check(method, target, auth, expectedStatus, expectedBusinessCode) {
  const response = await request(method, target, auth);
  const businessCode = response.json?.code ?? null;
  const pass = response.status === expectedStatus && (expectedBusinessCode === undefined || businessCode === expectedBusinessCode);
  result.probes.push({ method, path: target, authentication: auth, expectedStatus, expectedBusinessCode: expectedBusinessCode ?? null,
    status: response.status, businessCode, responseBytes: response.bytes, pass });
  if (!pass) throw new Error(`Unexpected result for ${method} ${target} (${auth}): HTTP ${response.status}, business ${businessCode}`);
  return response;
}

try {
  if (!Object.values(os.networkInterfaces()).flat().some(address => address?.family === 'IPv4' && address.address === host && !address.internal)) {
    throw new Error('Requested LAN address is not an interface of this machine');
  }
  result.runtime.manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  result.runtime.entrySha256Before = sha256(entry);
  result.runtime.authModuleSha256 = sha256(path.join(root, 'dist', 'auth', 'instance-token.js'));
  fs.mkdirSync(temporaryParent, { recursive: true });
  fs.mkdirSync(fixture, { recursive: false });
  fixtureCreated = true;
  for (const name of ['state', 'home', 'appdata', 'localappdata', 'programdata', 'skills', 'workspace', 'temp', 'global']) {
    fs.mkdirSync(path.join(fixture, name));
  }
  fs.writeFileSync(path.join(fixture, 'mcp.json'), JSON.stringify({ mcpServers: {} }));
  const environment = {};
  const allowed = new Set(['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS']);
  for (const [key, value] of Object.entries(process.env)) if (allowed.has(key.toUpperCase()) && value !== undefined) environment[key] = value;
  port = await reservePort();
  result.port = port;
  Object.assign(environment, {
    NODE_ENV: 'production', LOG_LEVEL: 'info', HOST: host, PORT: String(port),
    AETHER_INSTANCE_TOKEN: token, AUTH_ENABLED: 'false', ENCRYPTION_KEY: encryptionKey, JWT_SECRET: jwtSecret,
    DATA_DIR: path.join(fixture, 'state', 'agent.db'), HISTORY_BACKEND: 'jsonl',
    AETHER_GLOBAL_DIR: path.join(fixture, 'global'), WORKSPACE_ROOT: path.join(fixture, 'workspace'),
    SKILLS_ROOT: path.join(fixture, 'skills'), MCP_CONFIG_PATH: path.join(fixture, 'mcp.json'),
    HOME: path.join(fixture, 'home'), USERPROFILE: path.join(fixture, 'home'),
    APPDATA: path.join(fixture, 'appdata'), LOCALAPPDATA: path.join(fixture, 'localappdata'),
    PROGRAMDATA: path.join(fixture, 'programdata'), TEMP: path.join(fixture, 'temp'), TMP: path.join(fixture, 'temp'),
    PUBLIC_DIR: path.join(fixture, 'absent-public'), QA_LOG_ENABLED: 'false', ENABLE_LONG_TERM_MEMORY: 'false',
    MEMORY_CONSOLIDATION_INTERVAL_HOURS: '999999', NO_PROXY: '*',
  });
  child = spawn(process.execPath, [entry], { cwd: fixture, env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  result.ownedPid = child.pid ?? null;
  child.stdout.on('data', data => { serverLog += redact(data.toString()); });
  child.stderr.on('data', data => { serverLog += redact(data.toString()); });
  child.once('error', error => { serverLog += '\nCHILD_START_ERROR ' + redact(error.message); });
  child.once('exit', (code, signal) => { childExited = true; exitResult = { code, signal }; });
  const startupDeadline = Date.now() + 25_000;
  while (Date.now() < startupDeadline) {
    if (childExited) throw new Error(`Owned engine exited before startup: ${JSON.stringify(exitResult)}`);
    // Do not send requests until the owned child's own startup log confirms bind.
    if (serverLog.includes('Aether Engine started') && serverLog.includes(`"port":${port}`)) {
      const meta = await request('GET', '/meta');
      if (meta.status !== 200 || meta.json?.data?.buildId !== result.runtime.manifest.buildId) throw new Error('Ready engine identity did not match the built artifact');
      result.runtime.observedIdentity = meta.json.data;
      ready = true;
      break;
    }
    await sleep(100);
  }
  if (!ready) throw new Error('Isolated engine did not become ready within 25 seconds');
  for (const target of ['/api/v1/models', '/api/v1/conversation/sessions']) {
    await check('GET', target, 'none', 401, 40100);
    await check('GET', target, 'wrong', 401, 40100);
    const response = await check('GET', target, 'correct', 200, 200);
    if (!Array.isArray(response.json?.data) || response.json.data.length !== 0) throw new Error('Isolated business state is not empty');
  }
  for (const target of ['/health', '/meta', '/health?fixture=1', '/meta?fixture=1']) {
    await check('GET', target, 'none', 200, 200);
    await check('HEAD', target, 'wrong', 200);
  }
  await check('GET', '/metrics', 'none', 401, 40100);
  await check('GET', '/metrics', 'wrong', 401, 40100);
  const metrics = await check('GET', '/metrics', 'correct', 200);
  if (metrics.json?.code !== undefined && metrics.json.code !== 200) {
    result.observations.push({ endpoint: '/metrics', authentication: 'correct', status: metrics.status, businessCode: metrics.json.code,
      finding: 'Instance authentication admitted the request, but endpoint business execution returned an error. This does not establish metrics functionality.' });
  }
  await check('POST', '/health', 'none', 401, 40100);
  result.status = 'passed';
} catch (error) {
  result.status = 'failed';
  result.error = redact(error?.stack ?? error);
} finally {
  if (child && !childExited) {
    // This is the exact ChildProcess created above, never a port lookup/PID sweep.
    child.kill('SIGTERM');
    for (let i = 0; i < 80 && !childExited; i++) await sleep(100);
    if (!childExited) {
      child.kill('SIGKILL');
      for (let i = 0; i < 40 && !childExited; i++) await sleep(100);
    }
  }
  result.cleanup.childExited = child ? childExited : true;
  result.cleanup.childExit = exitResult ?? null;
  if (port && childExited) {
    const listener = net.createServer();
    try {
      await new Promise((resolve, reject) => {
        listener.once('error', reject);
        listener.listen({ host, port, exclusive: true }, resolve);
      });
      result.cleanup.portReleased = true;
      await new Promise(resolve => listener.close(resolve));
    } catch (error) {
      result.cleanup.portReleased = false;
      result.cleanup.portError = redact(error.message);
    }
  }
  result.runtime.entrySha256After = fs.existsSync(entry) ? sha256(entry) : null;
  result.cleanup.entryUnchanged = result.runtime.entrySha256Before === result.runtime.entrySha256After;
  if (fixtureCreated && (!child || childExited)) {
    // Windows recursive-delete safety: verify the resolved target is our direct
    // uniquely named child of the intended workspace temporary directory.
    const actualParent = fs.realpathSync(temporaryParent);
    const actualFixture = fs.realpathSync(fixture);
    if (path.dirname(actualFixture).toLowerCase() !== actualParent.toLowerCase() || !path.basename(actualFixture).startsWith('isolated-lan-auth-')) {
      result.cleanup.fixtureRemoved = false;
      result.cleanup.fixtureError = 'Resolved path safety check refused deletion';
    } else {
      try { fs.rmSync(actualFixture, { recursive: true, force: false, maxRetries: 4, retryDelay: 150 }); result.cleanup.fixtureRemoved = !fs.existsSync(actualFixture); }
      catch (error) { result.cleanup.fixtureRemoved = false; result.cleanup.fixtureError = redact(error.message); }
    }
  }
  if (!result.cleanup.childExited || result.cleanup.portReleased === false || result.cleanup.fixtureRemoved === false || !result.cleanup.entryUnchanged) result.status = 'failed';
  result.finishedAt = new Date().toISOString();
  result.passedProbes = result.probes.filter(probe => probe.pass).length;
  result.totalProbes = result.probes.length;
  fs.writeFileSync(outputPrefix + '-result.json', redact(JSON.stringify(result, null, 2)) + '\n');
  fs.writeFileSync(outputPrefix + '-server.log', redact(serverLog) + '\n');
  console.log(JSON.stringify({ status: result.status, host, port, probes: `${result.passedProbes}/${result.totalProbes}`, cleanup: result.cleanup,
    error: result.error, resultFile: outputPrefix + '-result.json', scope: result.scope }));
  process.exitCode = result.status === 'passed' ? 0 : 1;
}
