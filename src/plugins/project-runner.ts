import type { PluginManifest } from './types.js'

export function pluginProjectPackage(manifest: PluginManifest): string {
  return JSON.stringify({ name: manifest.id, version: '1.0.0', private: true, type: 'module', engines: { node: '>=22' }, scripts: { test: 'node scripts/test.mjs' } }, null, 2) + '\n'
}

/** Shipped as project source, so example tests run in plain Node without Aether. */
export const pluginProjectRunner = String.raw`import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFile } from 'node:child_process';
import assert from 'node:assert/strict';

const TEST_TIMEOUT_MS = 60_000;
const CLEANUP_TIMEOUT_MS = 12_000;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
function execute(file, args, deadline) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return Promise.reject(new Error('Process cleanup deadline exceeded'));
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, timeout: Math.min(8_000, remaining), killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => error ? reject(error) : resolve(stdout));
  });
}

// A self-contained version of the engine's owned process-tree cleanup. Never
// infer authority from a PID reused after the original ChildProcess has exited.
async function stopProcessTree(child, startedAt, deadline) {
  const pid = child.pid;
  if (!pid) return;
  if (process.platform !== 'win32') {
    try { process.kill(-pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; return; }
    await pause(150);
    try { process.kill(-pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    return;
  }
  const system32 = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
  const leaderExited = () => child.exitCode !== null || child.signalCode !== null;
  if (leaderExited() && alive(pid)) throw new Error('Original plugin PID was reused; refusing to stop an unrelated process tree');
  const query = 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,@{Name="Created";Expression={$_.CreationDate.ToUniversalTime().ToString("o")}} | ConvertTo-Json -Compress';
  let targets = [pid];
  try {
    const raw = await execute(path.join(system32, 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', query], deadline);
    const parsed = JSON.parse(raw), processes = Array.isArray(parsed) ? parsed : [parsed];
    if (leaderExited() && (alive(pid) || processes.some(item => item.ProcessId === pid))) throw new Error('Exited plugin PID is present in the snapshot; refusing to infer an unrelated process tree');
    const found = new Set([pid]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const item of processes) {
        if (Number.isSafeInteger(item.ProcessId) && item.ProcessId > 0 && found.has(item.ParentProcessId) && !found.has(item.ProcessId) && Date.parse(item.Created) >= startedAt - 2_000) {
          found.add(item.ProcessId); changed = true;
        }
      }
    }
    targets = [...found].reverse();
    if (leaderExited()) targets = targets.filter(target => target !== pid);
  } catch (error) {
    if (leaderExited()) throw new Error('Cannot inspect descendants of exited plugin: ' + String(error));
    // taskkill /T can discover descendants while the original leader is alive.
  }
  targets = targets.filter(alive);
  if (!targets.length) return;
  if (targets.length > 256) throw new Error('Plugin process tree exceeds the cleanup target limit');
  try { await execute(path.join(system32, 'taskkill.exe'), [...targets.flatMap(target => ['/PID', String(target)]), '/T', '/F'], deadline); }
  catch (error) {
    for (const target of targets) {
      if (!alive(target)) continue;
      try { process.kill(target, 'SIGTERM'); } catch (fallback) { if (alive(target)) throw new Error('Could not stop plugin tree: ' + String(error) + '; fallback: ' + String(fallback)); }
    }
  }
  for (let attempt = 0; attempt < 20 && targets.some(alive) && Date.now() < deadline; attempt++) await pause(25);
  if (targets.some(alive)) throw new Error('Plugin process tree did not exit after cleanup');
}

function reportedError(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.hasOwn(value, 'result') || !Object.hasOwn(value, 'error')) return undefined;
  if (typeof value.error === 'string') return (value.error || '插件报告错误').slice(0, 4000);
  if (value.error && typeof value.error === 'object' && !Array.isArray(value.error) && typeof value.error.message === 'string') {
    const code = typeof value.error.code === 'string' || typeof value.error.code === 'number' ? '[' + String(value.error.code).slice(0, 128) + '] ' : '';
    return (code + (value.error.message || '插件报告错误')).slice(0, 4000);
  }
  return undefined;
}

const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'aether-plugin.json'), 'utf8'));
const { cases } = JSON.parse(fs.readFileSync(path.join(root, 'examples/cases.json'), 'utf8'));
assert.equal(manifest.apiVersion, 1);
assert.equal(manifest.runtime, 'node');
assert.ok(Array.isArray(cases) && cases.length > 0 && cases.length <= 50, 'Expected 1–50 example cases');
const env = Object.fromEntries(['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL'].flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]]]));
if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1';
for (const item of cases) {
  assert.ok(Object.hasOwn(item, 'expected'), 'Each case must assert its expected business result');
  const tool = manifest.tools.find(tool => tool.name === item.tool);
  assert.ok(tool, 'Unknown tool: ' + item.tool);
  assert.ok(typeof tool.entry === 'string' && tool.entry.endsWith('.mjs') && !/[\\:]/.test(tool.entry));
  assert.ok(tool.entry.split('/').every(part => part && part !== '.' && part !== '..'));
  const entry = path.resolve(root, tool.entry), relative = path.relative(root, entry);
  assert.ok(relative && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep));
  const input = JSON.stringify({ tool: tool.name, args: item.args }) + '\n';
  assert.ok(Buffer.byteLength(input) <= 256 * 1024, 'Input exceeds 256 KiB');
  const output = await new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const child = spawn(process.execPath, ['--max-old-space-size=128', '--disable-proto=throw', '--no-addons', entry], { cwd: root, env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout = [], stderr = [];
    let size = 0, errorSize = 0, failure, stopping, settled = false;
    const fail = reason => {
      if (settled || stopping) return;
      failure = reason;
      clearTimeout(timer);
      let cleanupTimer;
      stopping = Promise.race([
        stopProcessTree(child, startedAt, Date.now() + CLEANUP_TIMEOUT_MS),
        new Promise((_, rejectCleanup) => { cleanupTimer = setTimeout(() => rejectCleanup(new Error('Process cleanup deadline exceeded')), CLEANUP_TIMEOUT_MS); }),
      ]).catch(error => { failure = new Error(reason.message + '; process cleanup failed: ' + String(error)); })
        .finally(() => {
          clearTimeout(cleanupTimer);
          // A descendant may retain pipes even when cleanup fails. Never wait
          // indefinitely for close; report the cleanup failure and release I/O.
          child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); child.unref();
          if (!settled) { settled = true; reject(failure); }
        });
    };
    const timer = setTimeout(() => fail(new Error('Plugin test timed out after ' + TEST_TIMEOUT_MS + 'ms')), TEST_TIMEOUT_MS);
    child.once('error', fail);
    child.stdin.on('error', error => { if (error.code !== 'EPIPE') fail(error); });
    child.stdout.on('data', chunk => { size += chunk.length; if (size > 2 * 1024 * 1024) fail(new Error('Output exceeds 2 MiB')); else stdout.push(chunk); });
    child.stderr.on('data', chunk => { errorSize += chunk.length; if (errorSize > 256 * 1024) fail(new Error('Stderr exceeds 256 KiB')); else stderr.push(chunk); });
    child.once('close', code => {
      if (settled || stopping) return;
      clearTimeout(timer);
      const errors = Buffer.concat(stderr).toString('utf8'), text = Buffer.concat(stdout).toString('utf8').trim();
      try {
        if (code !== 0) throw new Error('Plugin exited ' + code + ': ' + (errors || text).slice(-4000));
        let parsed;
        try { parsed = JSON.parse(text.split(/\r?\n/).at(-1)); }
        catch { throw new Error('Plugin did not return JSON (exit ' + code + '): ' + errors.slice(-4000)); }
        const reported = reportedError(parsed);
        if (reported !== undefined) throw new Error(reported);
        settled = true; resolve(parsed);
      } catch (error) { fail(error); }
    });
    child.stdin.end(input);
  });
  const envelope = output && typeof output === 'object' && Object.hasOwn(output, 'result');
  assert.deepEqual(envelope ? output.result : output, item.expected, item.name);
  if (Object.hasOwn(item, 'artifacts')) assert.deepEqual(envelope ? output.artifacts ?? [] : [], item.artifacts, item.name + ' artifacts');
  console.log('PASS ' + item.name);
}
console.log(cases.length + ' business cases passed. Artifact previews were not written.');
`;
