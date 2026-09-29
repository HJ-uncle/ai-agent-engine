import type { ChildProcess } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { stopCommandProcessTree } from '../process-tree.js'

describe('Windows command process identity', () => {
  it.skipIf(process.platform !== 'win32')('refuses an exited leader PID that now identifies a live unrelated process', async () => {
    // A stale ChildProcess says its leader exited, while that numeric PID is alive.
    // Using this worker's real PID proves the check refuses before any tree killer.
    const stale = { pid: process.pid, exitCode: 0, signalCode: null } as ChildProcess
    await expect(stopCommandProcessTree(stale, Date.now() - 1_000)).rejects.toThrow('PID has been reused')
    expect(process.kill(process.pid, 0)).toBe(true)
  })
})
