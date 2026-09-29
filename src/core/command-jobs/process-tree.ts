import { execFile, type ChildProcess } from 'node:child_process'
import path from 'node:path'

const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true } catch { return false } }

function execute(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, timeout: 8_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      if (error) reject(error)
      else resolve(stdout)
    })
  })
}

/** Processes spawned by this manager are isolated in a POSIX group, never a user's PTY. */
export async function stopCommandProcessTree(child: ChildProcess, startedAt: number): Promise<void> {
  const pid = child.pid
  if (!pid) return
  if (process.platform !== 'win32') {
    try { process.kill(-pid, 'SIGTERM') } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
      return
    }
    await pause(250)
    try { process.kill(-pid, 'SIGKILL') } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
    }
    return
  }

  const system32 = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')
  const taskkill = path.join(system32, 'taskkill.exe')
  const leaderExited = () => child.exitCode !== null || child.signalCode !== null
  // The original ChildProcess owns only its original process identity. A reused PID
  // is not authority to inspect or kill the new process's descendants.
  if (leaderExited() && alive(pid)) throw new Error('Original command PID has been reused; refusing to infer or stop an unrelated process tree')
  // A leader may already have exited while descendants retain its output pipes. Windows
  // still reports their parent PID; collect that tree before asking taskkill to stop it.
  // Creation time prevents adopting a process that predates this command's launch.
  const query = 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,@{Name="Created";Expression={$_.CreationDate.ToUniversalTime().ToString("o")}} | ConvertTo-Json -Compress'
  let targets = [pid]
  try {
    const raw = await execute(path.join(system32, 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', query])
    const parsed = JSON.parse(raw)
    const processes = (Array.isArray(parsed) ? parsed : [parsed]) as Array<{ ProcessId: number; ParentProcessId: number; Created: string }>
    if (leaderExited() && (alive(pid) || processes.some(process => process.ProcessId === pid))) {
      throw new Error('Exited command PID is present in the process snapshot; refusing to infer an unrelated process tree')
    }
    const found = new Set<number>([pid])
    let changed = true
    while (changed) {
      changed = false
      for (const process of processes) {
        if (found.has(process.ParentProcessId) && !found.has(process.ProcessId) && Date.parse(process.Created) >= startedAt - 2_000) {
          found.add(process.ProcessId); changed = true
        }
      }
    }
    targets = [...found].reverse()
    // Never send a stale leader PID to taskkill after its ChildProcess exit event.
    if (leaderExited()) targets = targets.filter(target => target !== pid)
  } catch (error) {
    if (leaderExited()) throw new Error(`Cannot inspect descendants of exited command: ${String(error)}`)
    // taskkill /T can still discover the tree while the original leader is alive.
  }
  for (const target of targets) {
    if (!alive(target)) continue
    try { await execute(taskkill, ['/PID', String(target), '/T', '/F']) }
    catch (error) { if (alive(target)) throw new Error(`Could not stop command process tree: ${String(error)}`) }
  }
  for (let attempt = 0; attempt < 20 && targets.some(alive); attempt++) await pause(25)
  if (targets.some(alive)) throw new Error('Command process tree did not exit after taskkill')
}
