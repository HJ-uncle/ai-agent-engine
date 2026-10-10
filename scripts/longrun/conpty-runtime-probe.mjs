import fs from 'node:fs'
import path from 'node:path'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createRequire } from 'node:module'
const execute = promisify(execFile)
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))

const script = path.resolve(import.meta.filename)
const write = (name, value) => fs.writeFileSync(name, JSON.stringify(value, null, 2))

if (process.argv[2] === 'child') {
  const directory = path.resolve(process.argv[3])
  const config = JSON.parse(fs.readFileSync(path.join(directory, 'config.json'), 'utf8'))
  const node = config.node
  const pty = createRequire(path.join(config.packageDir, 'package.json'))(config.packageDir)
  const result = { name: config.name, dll: config.dll, mode: config.mode, startedAt: new Date().toISOString(),
    supervisorPid: process.pid, node: process.version, dataBytes: 0, dataEvents: 0, shellPid: null,
    ready: false, killIssued: false, exitReceived: false, errors: [] }
  let terminal
  let terminalDone = false
  const finish = () => { result.finishedAt = new Date().toISOString(); write(path.join(directory, 'result.json'), result) }
  const watchdog = setTimeout(() => {
    result.errors.push({ code: 'PTY_EXIT_TIMEOUT', message: 'No PTY exit event within seven seconds' })
    finish()
    // Supervisor owns and reaps all PID+birth identities. Do not issue another native kill.
  }, 7000)
  try {
    terminal = pty.spawn(node, [path.join(directory, 'shell.cjs'), config.mode], {
      name: 'xterm-256color', cols: 80, rows: 24, cwd: directory,
      env: { ...process.env, PROBE_DIRECTORY: directory }, useConpty: true, useConptyDll: config.dll,
    })
    result.shellPid = terminal.pid
    write(path.join(directory, 'started.json'), result)
    terminal.onData(data => {
      result.dataBytes += Buffer.byteLength(data)
      result.dataEvents++
      if (data.includes('PROBE_READY')) result.ready = true
    })
    result.cleanupEvents = []
    terminal.onCleanup?.(event => { result.cleanupEvents.push(event) })
    terminal.onExit(event => {
      terminalDone = true
      result.exitReceived = true
      result.exitCode = event.exitCode
      if (event.cleanupError) result.errors.push(event.cleanupError)
      result.exitAt = new Date().toISOString()
      clearTimeout(watchdog)
      finish()
      // No process.exit: retained workers, helper IPC and timers must finish naturally.
    })
    if (config.mode !== 'natural') {
      if (config.mode !== 'immediate') {
        const deadline = Date.now() + 4000
        while (!result.ready && Date.now() < deadline && !terminalDone) await pause(15)
        if (!result.ready) result.errors.push({ code: 'SHELL_NOT_READY' })
        if (config.mode === 'subprocess') {
          const childDeadline = Date.now() + 3000
          while (!fs.existsSync(path.join(directory, 'subprocess.json')) && Date.now() < childDeadline) await pause(20)
          if (!fs.existsSync(path.join(directory, 'subprocess.json'))) result.errors.push({ code: 'SUBPROCESS_NOT_CREATED' })
        }
        await pause(config.mode === 'largeoutput' ? 350 : 500)
      }
      result.killIssued = true
      result.killAt = new Date().toISOString()
      terminal.kill()
      terminal.kill() // Duplicate public close must merge.
      write(path.join(directory, 'kill-issued.json'), result)
    }
  } catch (error) {
    result.errors.push({ name: error.name, message: error.message, stack: error.stack })
    clearTimeout(watchdog)
    finish()
  }
} else {
  if (process.platform !== 'win32') throw new Error('Actual ConPTY probe requires Windows')
  const { applyNodePtyPatch } = await import('../apply-node-pty-patch.mjs')
  const options = { packageDir: path.resolve('node_modules/node-pty'), node: process.execPath,
    outputRoot: path.resolve('.tmp'), modes: 'idle,immediate,largeoutput,subprocess,natural' }
  const names = { '--package-dir': 'packageDir', '--node': 'node', '--output-root': 'outputRoot', '--modes': 'modes' }
  for (let index = 2; index < process.argv.length; index++) {
    const key = names[process.argv[index]]
    if (!key || !process.argv[index + 1]) throw new Error('Usage: conpty-runtime-probe.mjs [--package-dir directory] [--node executable] [--output-root directory] [--modes idle,immediate,largeoutput,subprocess,natural]')
    options[key] = process.argv[++index]
  }
  const packageDir = path.resolve(options.packageDir)
  const node = path.resolve(options.node)
  if (!fs.statSync(node).isFile()) throw new Error('Probe Node executable is not a file')
  const patch = applyNodePtyPatch({ packageDir, check: true })
  const modes = options.modes.split(',')
  if (!modes.length || modes.some(mode => !['idle', 'immediate', 'largeoutput', 'subprocess', 'natural'].includes(mode))) throw new Error('Unsupported ConPTY probe mode')
  fs.mkdirSync(path.resolve(options.outputRoot), { recursive: true })
  const directory = fs.mkdtempSync(path.join(path.resolve(options.outputRoot), 'conpty-runtime-'))
  const snapshot = async () => {
    const { stdout } = await execute('powershell.exe', ['-NoProfile', '-Command',
      "$ErrorActionPreference='Stop'; $rows=@(Get-CimInstance Win32_Process | ForEach-Object { [pscustomobject]@{pid=[int]$_.ProcessId;parentPid=[int]$_.ParentProcessId;startTicks=$_.CreationDate.ToUniversalTime().Ticks.ToString();name=$_.Name} }); ConvertTo-Json -InputObject $rows -Compress"], { windowsHide: true, maxBuffer: 8_000_000 })
    return JSON.parse(stdout)
  }
  const identity = row => `${row.pid}:${row.startTicks}`
  const track = (rows, owned) => {
    let changed = true
    while (changed) {
      changed = false
      for (const row of rows) {
        if (owned.has(identity(row))) continue
        if ([...owned.values()].some(parent => row.parentPid === parent.pid && BigInt(row.startTicks) >= BigInt(parent.startTicks))) {
          owned.set(identity(row), row); changed = true
        }
      }
    }
  }
  const cases = modes.map(mode => ({ name: `system-${mode}`, dll: false, mode, packageDir, node }))
  const results = []
  const shellSource = `const fs=require('node:fs');const path=require('node:path');const {spawn}=require('node:child_process');
const directory=process.env.PROBE_DIRECTORY;const mode=process.argv[2];
fs.writeFileSync(path.join(directory,'shell-start.json'),JSON.stringify({pid:process.pid,at:new Date().toISOString()}));
process.stdout.write('PROBE_READY '+process.pid+'\\r\\n');
if(mode==='natural'){setTimeout(()=>{process.stdout.write('PROBE_NATURAL_EXIT\\r\\n');process.exit(7)},180)}
else if(mode==='largeoutput'){const output='0123456789abcdef'.repeat(4096)+'\\r\\n';setInterval(()=>process.stdout.write(output),5)}
else if(mode==='subprocess'){const child=spawn(process.execPath,[path.join(directory,'subprocess.cjs')],{stdio:'inherit',detached:false});fs.writeFileSync(path.join(directory,'subprocess.json'),JSON.stringify({pid:child.pid,parentPid:process.pid,at:new Date().toISOString()}));setInterval(()=>{},50)}
else setInterval(()=>{},50);`
  const subprocessSource = `const fs=require('node:fs');const path=require('node:path');const file=path.join(process.env.PROBE_DIRECTORY,'subprocess.writes');fs.appendFileSync(file,'start\\n');setInterval(()=>fs.appendFileSync(file,'tick\\n'),30);`
  for (const config of cases) {
    const caseDir = path.join(directory, config.name)
    fs.mkdirSync(caseDir)
    write(path.join(caseDir, 'config.json'), config)
    fs.writeFileSync(path.join(caseDir, 'shell.cjs'), shellSource)
    fs.writeFileSync(path.join(caseDir, 'subprocess.cjs'), subprocessSource)
    const stdout = fs.createWriteStream(path.join(caseDir, 'supervisor.out.log'))
    const stderr = fs.createWriteStream(path.join(caseDir, 'supervisor.err.log'))
    const child = spawn(node, [script, 'child', caseDir], { cwd: path.dirname(script), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.pipe(stdout); child.stderr.pipe(stderr)
    let exit = null
    child.once('exit', (code, signal) => { exit = { code, signal, at: new Date().toISOString() } })
    const owned = new Map()
    const observations = []
    const firstRows = await snapshot()
    const root = firstRows.find(row => row.pid === child.pid)
    if (!root) throw new Error('Probe root identity could not be verified')
    owned.set(identity(root), root); track(firstRows, owned)
    const until = Date.now() + 11_000
    while (Date.now() < until && !exit) {
      const rows = await snapshot(); track(rows, owned)
      observations.push({ at: new Date().toISOString(), live: rows.filter(row => owned.has(identity(row))) })
      await pause(100)
    }
    const before = await snapshot(); track(before, owned)
    const liveBefore = before.filter(row => owned.has(identity(row)))
    const naturalSupervisorExit = exit
    const ptyResult = fs.existsSync(path.join(caseDir, 'result.json')) ? JSON.parse(fs.readFileSync(path.join(caseDir, 'result.json'), 'utf8')) : null
    const marker = path.join(caseDir, 'subprocess.writes')
    const writesBefore = fs.existsSync(marker) ? fs.statSync(marker).size : 0
    await pause(250)
    const writesAfter = fs.existsSync(marker) ? fs.statSync(marker).size : 0
    // Reap only a verified identity in the descendants of this probe, never a PID alone.
    write(path.join(caseDir, 'owned.json'), [...owned.values()])
    const cleanupPath = path.join(caseDir, 'cleanup.ps1')
    fs.writeFileSync(cleanupPath, `$ErrorActionPreference='Stop'\n$expected=Get-Content -Raw -LiteralPath '${path.join(caseDir, 'owned.json').replaceAll("'", "''")}'|ConvertFrom-Json\n$stopped=@();$reused=@();$errors=@()\nforeach($item in ($expected|Sort-Object {[long]$_.startTicks} -Descending)){ $current=Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$item.pid) -ErrorAction SilentlyContinue; if(!$current){continue};if($current.CreationDate.ToUniversalTime().Ticks.ToString() -ne [string]$item.startTicks){$reused += [int]$item.pid;continue};try{Stop-Process -Id ([int]$item.pid) -Force -ErrorAction Stop;$stopped += [int]$item.pid}catch{$errors += [pscustomobject]@{pid=[int]$item.pid;message=$_.Exception.Message}} }\n[pscustomobject]@{stopped=$stopped;reused=$reused;errors=$errors}|ConvertTo-Json -Depth 5 -Compress\n`)
    const cleanup = await execute('powershell.exe', ['-NoProfile', '-File', cleanupPath], { windowsHide: true, maxBuffer: 2_000_000 })
    await pause(300)
    const after = await snapshot()
    const remaining = after.filter(row => owned.has(identity(row)))
    await new Promise(resolve => stdout.end(resolve)); await new Promise(resolve => stderr.end(resolve))
    const errors = fs.readFileSync(path.join(caseDir, 'supervisor.err.log'), 'utf8')
    const evidence = { ...config, ptyResult, naturalSupervisorExit, observed: [...owned.values()], liveBeforeCleanup: liveBefore,
      writesBefore, writesAfter, writesContinuedAfterPty: writesAfter > writesBefore,
      stderrBytes: Buffer.byteLength(errors), attachConsoleErrors: errors.split('Error: AttachConsole failed').length - 1,
      cleanup: JSON.parse(cleanup.stdout), remaining, observations,
      passed: !!ptyResult?.exitReceived && !ptyResult.errors.length && ptyResult.cleanupEvents.length === 1 && !ptyResult.cleanupEvents[0].cleanupError && naturalSupervisorExit?.code === 0
        && !liveBefore.length && !remaining.length && errors.length === 0 && writesAfter === writesBefore
        && (config.mode !== 'natural' || ptyResult.exitCode === 7) }
    write(path.join(caseDir, 'evidence.json'), evidence)
    results.push(evidence)
    console.log(JSON.stringify({ name: evidence.name, passed: evidence.passed, ptyExit: ptyResult?.exitReceived,
      exitCode: ptyResult?.exitCode, supervisor: naturalSupervisorExit, stderrBytes: evidence.stderrBytes,
      attachConsoleErrors: evidence.attachConsoleErrors, liveBefore: liveBefore.map(x=>({pid:x.pid,name:x.name})),
      continuedSubprocessWrites: evidence.writesContinuedAfterPty, cleanup: evidence.cleanup, remaining: remaining.length }))
  }
  const result = { at: new Date().toISOString(), directory, node, nodePtyVersion: JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'))).version, patch,
    productUnmodified: true, packageDir, networkListenersCreated: 0, cases: results.map(({observations,...rest})=>rest) }
  write(path.join(directory, 'result.json'), result)
  console.log(JSON.stringify({ completed: true, evidence: path.join(directory, 'result.json'), passed: results.filter(result => result.passed).length, cases: results.length }))
  if (results.some(result => !result.passed)) process.exitCode = 1
}
