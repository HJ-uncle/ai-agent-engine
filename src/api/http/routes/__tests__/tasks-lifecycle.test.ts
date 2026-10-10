import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'
import { expect, it } from 'vitest'

it('owns a real poller per HTTP instance and exits naturally after both instances close', async () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'aether-task-poller-close-'))
  const routesUrl = pathToFileURL(path.resolve('src/api/http/routes/tasks.ts')).href
  const fastifyUrl = pathToFileURL(path.resolve('node_modules/fastify/fastify.js')).href
  const script = `
    import assert from 'node:assert/strict';
    const {default: Fastify}=await import(${JSON.stringify(fastifyUrl)});
    const {taskRoutes}=await import(${JSON.stringify(routesUrl)});
    const timers=()=>process.getActiveResourcesInfo().filter(name=>name==='Timeout').length;
    const baseline=timers();
    const first=Fastify(); const second=Fastify();
    await first.register(taskRoutes); await second.register(taskRoutes);
    await first.ready(); await second.ready();
    assert.equal(timers(),baseline+2,'Each HTTP instance must own a real polling timer');
    await first.close();
    assert.equal(timers(),baseline+1,'Closing the first HTTP instance must retain the other poller');
    await second.close();
    assert.equal(timers(),baseline,'Closing both HTTP instances must clear all polling timers');
    console.log('independent-pollers-closed');
  `
  const env: NodeJS.ProcessEnv = { ...process.env, DATA_DIR: path.join(fixture, 'agent.db'), LOG_LEVEL: 'silent' }
  delete env.NODE_OPTIONS
  const scriptPath = path.join(fixture, 'close-pollers.mjs')
  fs.writeFileSync(scriptPath, script)
  const child = spawn(process.execPath, ['--import', 'tsx', scriptPath], {
    env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  })
  let stdout = ''; let stderr = ''
  child.stdout.on('data', chunk => { stdout += chunk.toString() })
  child.stderr.on('data', chunk => { stderr += chunk.toString() })
  let timer: NodeJS.Timeout | undefined
  try {
    const code = await Promise.race([
      new Promise<number | null>((resolve, reject) => { child.once('exit', resolve); child.once('error', reject) }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => { child.kill(); reject(new Error('HTTP close retained its polling process')) }, 6000) }),
    ])
    expect(code, stderr).toBe(0)
    expect(stdout).toContain('independent-pollers-closed')
  } finally {
    clearTimeout(timer)
    if (child.exitCode === null && child.signalCode === null) child.kill()
    if (path.dirname(fixture) !== path.resolve(os.tmpdir()) || !path.basename(fixture).startsWith('aether-task-poller-close-')) throw new Error('Unsafe fixture cleanup')
    fs.rmSync(fixture, { recursive: true, force: true })
  }
}, 10000)
