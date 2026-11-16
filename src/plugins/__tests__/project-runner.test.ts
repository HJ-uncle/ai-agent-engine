import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createPluginProject } from '../project.js'
import { pluginProjectRunner } from '../project-runner.js'

let root: string
const fixtures = path.resolve('.e2e-tmp/plugin-project-runner')
beforeEach(() => { fs.mkdirSync(fixtures, { recursive: true }); root = fs.mkdtempSync(path.join(fixtures, 'case-')) })
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true } catch { return false } }
afterEach(() => {
  const record = path.join(root, 'project', 'processes.json')
  if (fs.existsSync(record)) {
    const owned = JSON.parse(fs.readFileSync(record, 'utf8')) as { leader: number; descendant: number }
    // Failure-only cleanup of PIDs emitted by this just-created fixture.
    for (const pid of [owned.descendant, owned.leader]) if (alive(pid)) { try { process.kill(pid, 'SIGKILL') } catch { /* Already exited. */ } }
  }
  if (path.dirname(root) !== fixtures || !path.basename(root).startsWith('case-') || fs.lstatSync(root).isSymbolicLink()) throw new Error('Unsafe runner fixture cleanup')
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  if (!fs.readdirSync(fixtures).length) fs.rmdirSync(fixtures)
})

function fixture(source: string, expected: unknown, timeoutMs?: number): string {
  const directory = path.join(root, 'project')
  createPluginProject(directory, 'json-tool')
  fs.writeFileSync(path.join(directory, 'main.mjs'), source)
  fs.writeFileSync(path.join(directory, 'examples/cases.json'), JSON.stringify({ cases: [{ name: 'fixture', tool: 'normalize_text', args: { text: 'x' }, expected }] }))
  if (timeoutMs !== undefined) fs.writeFileSync(path.join(directory, 'scripts/test.mjs'), pluginProjectRunner.replace('const TEST_TIMEOUT_MS = Number(process.env.AETHER_PLUGIN_TEST_TIMEOUT_MS ?? 0);', `const TEST_TIMEOUT_MS = ${timeoutMs};`))
  return directory
}

async function run(directory: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(directory, 'scripts/test.mjs')], { cwd: directory, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const stdout: Buffer[] = [], stderr: Buffer[] = []
    const watchdog = setTimeout(() => {
      child.kill(); child.stdout.destroy(); child.stderr.destroy(); child.unref()
      reject(new Error('Standalone runner did not settle within the test deadline'))
    }, 18000)
    child.stdout.on('data', chunk => stdout.push(chunk)); child.stderr.on('data', chunk => stderr.push(chunk))
    child.once('error', error => { clearTimeout(watchdog); reject(error) })
    child.once('close', code => { clearTimeout(watchdog); resolve({ code, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') }) })
  })
}

describe('self-contained plugin project runner', () => {
  it('runs large inputs, results and diagnostics without the old plugin process limits', async () => {
    const expected = 'x'.repeat(3 * 1024 * 1024)
    const directory = fixture(`let raw='';for await(const part of process.stdin)raw+=part;
      if(process.execArgv.some(flag=>flag.includes('max-old-space-size')))throw new Error('Unexpected memory ceiling');
      console.log('diagnostic'.repeat(1024*1024));console.error('diagnostic'.repeat(128*1024));
      console.log(JSON.stringify({result:JSON.parse(raw).args.text}));`, expected)
    fs.writeFileSync(path.join(directory, 'examples/cases.json'), JSON.stringify({ cases: [{ name: 'large', tool: 'normalize_text', args: { text: expected }, expected }] }))
    const result = await run(directory)
    expect(result.code, result.stderr).toBe(0)
    expect(result.stdout).toContain('1 business cases passed')
    expect(fs.existsSync(path.join(directory, '.e2e-tmp'))).toBe(false)
  })
  it.each(['running', 'exited'])('cleans owned inherited-stdio descendants when the leader is %s', async mode => {
    const source = [
      "import fs from 'node:fs'", "import { spawn } from 'node:child_process'",
      "const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true, stdio: ['ignore', 'inherit', 'inherit'] })",
      "fs.writeFileSync('processes.json', JSON.stringify({ leader: process.pid, descendant: descendant.pid }))",
      mode === 'exited' ? 'setTimeout(() => process.exit(0), 20)' : 'setInterval(() => {}, 1000)',
    ].join('\n')
    const directory = fixture(source, null, 600)
    const result = await run(directory)
    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain(mode === 'running' ? 'Plugin test timed out after 600ms' : 'Plugin did not return JSON (exit 0)')
    expect(result.stderr).not.toContain('process cleanup failed')
    const owned = JSON.parse(fs.readFileSync(path.join(directory, 'processes.json'), 'utf8')) as { leader: number; descendant: number }
    expect(alive(owned.descendant)).toBe(false)
    expect(alive(owned.leader)).toBe(false)
  }, 22000)

  it.each([
    [{ error: 'diagnostic failure' }, false],
    [{ error: { code: 'FIXTURE', message: 'structured failure' } }, false],
    [{ error: null, count: 3 }, true],
    [{ error: { statistics: 7 }, count: 3 }, true],
    [{ result: { success: false, error: 'business value' } }, true],
  ] as const)('matches the host failure-envelope rules for %j', async (value, accepted) => {
    const expected = 'result' in value ? value.result : value
    const directory = fixture(`console.log(${JSON.stringify(JSON.stringify(value))})`, expected)
    const result = await run(directory)
    expect(result.code === 0, result.stderr).toBe(accepted)
    if (accepted) expect(result.stdout).toContain('1 business cases passed')
  })
})
