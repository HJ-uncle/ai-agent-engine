import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { monitorReadiness, awaitMonitorReadiness } from './monitor-readiness.mjs'

const fixtureRoot = path.resolve('.tmp', 'monitor-smoke')
const createFixture = () => { fs.mkdirSync(fixtureRoot, { recursive: true }); return fs.mkdtempSync(path.join(fixtureRoot, 'run-')) }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
function rows() {
  const engineStartTime = '2026-10-09T10:28:01.1674574Z'
  return [{ type: 'start', enginePid: 100, engineStartTime }, ...[0, 1].map(sequence => ({ type: 'sample', sequence, enginePid: 100, at: `2026-10-09T10:28:${32 + sequence * 5}Z`, processCount: 2, processes: [{ pid: 100, startTime: engineStartTime }, { pid: 200 }], rssBytes: 4096, privateBytes: 2048, errors: [] }))]
}
test('readiness requires two owned process tree samples and rejects empty, wrong-owner or failed monitoring', () => {
  assert.equal(monitorReadiness([], 100), null)
  assert.equal(monitorReadiness(rows().slice(0, 2), 100), null)
  assert.equal(monitorReadiness(rows(), 100).samples, 2)
  const cases = [
    x => { x[0].enginePid = 999 },
    x => { x[1].sequence = 2 },
    x => { x[1].processes.shift() },
    x => { x[1].processes[0].startTime = 'other process identity' },
    x => { x[1].rssBytes = 0 },
    x => { x[1].errors = ['process-tree-enumeration: access denied'] },
    x => { x.push({ type: 'error', message: 'CIM failed' }) },
    x => { x.push({ type: 'stop', reason: 'root-exited' }) },
  ]
  for (const mutate of cases) { const copy = rows(); mutate(copy); assert.throws(() => monitorReadiness(copy, 100)) }
})
test('startup wait tolerates an incomplete final line but times out on a silent alive monitor and rejects early exit', async () => {
  const root = createFixture(), file = path.join(root, 'partial.jsonl')
  fs.writeFileSync(file, rows().map(row => JSON.stringify(row)).join('\n') + '\n{"partial":')
  assert.equal((await awaitMonitorReadiness({ file, enginePid: 100, monitor: {}, guardedWait: sleep })).samples, 2)
  fs.writeFileSync(file, '')
  let elapsed = 0
  await assert.rejects(awaitMonitorReadiness({ file, enginePid: 100, monitor: {}, timeoutMs: 500, now: () => elapsed, guardedWait: async ms => { elapsed += ms } }), /readiness-timeout/)
  await assert.rejects(awaitMonitorReadiness({ file, enginePid: 100, monitor: { closedResult: { code: 0 } }, guardedWait: sleep }), /ended-before-readiness/)
})
test('real Windows monitor records an actual Node root and child, CPU deltas and clean stop', { skip: process.platform !== 'win32', timeout: 40_000 }, async () => {
  const root = createFixture(), file = path.join(root, 'monitor.jsonl'), stop = path.join(root, 'STOP')
  const script = `const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,stdio:'ignore'});console.log(child.pid);const timer=setInterval(()=>{const until=Date.now()+40;while(Date.now()<until){}},200);process.stdin.resume();process.stdin.once('end',()=>{clearInterval(timer);child.kill();});`
  const engine = spawn(process.execPath, ['-e', script], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  const engineDone = once(engine, 'close')
  let monitor, monitorDone
  try {
    const childPid = Number(String((await once(engine.stdout, 'data'))[0]).trim())
    assert.ok(Number.isSafeInteger(childPid) && childPid > 0)
    monitor = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.resolve('scripts/longrun/monitor.ps1'), '-EnginePid', String(engine.pid), '-OutputPath', file, '-StopPath', stop, '-MaxMinutes', '1'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    monitor.stderr.on('data', data => { stderr += String(data) })
    monitorDone = once(monitor, 'close').then(([code, signal]) => { monitor.closedResult = { code, signal }; return monitor.closedResult })
    const ready = await awaitMonitorReadiness({ file, enginePid: engine.pid, monitor, guardedWait: sleep })
    fs.writeFileSync(path.join(root, 'readiness.json'), JSON.stringify({ ...ready, childPid }, null, 2))
    const samples = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/).map(JSON.parse).filter(row => row.type === 'sample')
    assert.ok(samples.every(sample => sample.processes.some(proc => proc.pid === childPid)))
    assert.ok(samples[1].cpuDeltaSeconds > 0)
    fs.writeFileSync(stop, 'test completed')
    assert.equal((await monitorDone).code, 0, stderr)
    const finalRows = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/).map(JSON.parse)
    assert.equal(finalRows.at(-1).reason, 'stop-file')
    assert.equal(finalRows.at(-1).samples, samples.length)
    assert.equal(finalRows.filter(row => row.type === 'error').length, 0)
    console.log('Real monitor evidence: ' + root)
  } finally {
    fs.writeFileSync(stop, 'cleanup')
    if (monitor && !monitor.closedResult) await Promise.race([monitorDone, sleep(3000)])
    if (monitor && !monitor.closedResult) monitor.kill()
    engine.stdin.end()
    await Promise.race([engineDone, sleep(3000)])
    if (engine.exitCode === null) engine.kill()
  }
})
