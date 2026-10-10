import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const engineRoot = path.resolve(import.meta.dirname, '../..')
const fixture = fs.mkdtempSync(path.join(engineRoot, '.tmp', 'two-end-sdk-smoke-'))
const require = createRequire(path.join(engineRoot, 'sdk-package/package.json'))
const { AgentEngineSdk } = require(path.join(engineRoot, 'sdk-package/dist/index.js'))
const { startProcess } = require(path.join(engineRoot, 'sdk-package/dist/embedded/processManager.js'))
const token = 'two-end-sdk-fixture-token'
const results = []
const port = async () => {
  const server = net.createServer()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const value = server.address().port
  await new Promise(resolve => server.close(resolve))
  return value
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const awaitFile = async file => {
  const end = Date.now() + 5000
  while (!fs.existsSync(file)) { assert(Date.now() < end, 'Child did not write evidence'); await sleep(10) }
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}
const envFor = dir => ({
  AUTH_ENABLED: 'false', AETHER_INSTANCE_TOKEN: token, ENCRYPTION_KEY: '7'.repeat(64),
  WORKSPACE_ROOT: dir, AETHER_GLOBAL_DIR: path.join(dir, 'global'), LOG_LEVEL: 'silent',
  QA_LOG_ENABLED: 'false', PUBLIC_DIR: path.join(dir, 'absent-public'), HISTORY_BACKEND: 'jsonl',
})
for (const kind of ['default-entry-directory', 'default-entry-file', 'custom-renamed-entry']) {
  const directory = path.join(fixture, kind)
  fs.mkdirSync(directory, { recursive: true })
  let binaryPath
  if (kind === 'custom-renamed-entry') {
    binaryPath = path.join(directory, 'renamed-engine.mjs')
    fs.writeFileSync(binaryPath, `import ${JSON.stringify(pathToFileURL(path.join(engineRoot, 'sdk-package/bin/dist/main.js')).href)}\n`)
  }
  const dataDir = kind === 'default-entry-directory' ? directory : path.join(directory, 'chosen.db')
  const sdk = new AgentEngineSdk({ mode: 'embedded', embedded: {
    preferredPort: await port(), dataDir, binaryPath, startupTimeoutMs: 60000,
    env: { ...envFor(directory), SKILLS_ROOT: path.join(engineRoot, 'sdk-package/bin/SKILLs') },
  } })
  let baseUrl
  try {
    ;({ baseUrl } = await sdk.start())
    assert((await sdk.healthCheck()).ok)
    const response = await fetch(baseUrl + '/meta', { headers: { 'X-Aether-Instance-Token': token } })
    assert.equal(response.status, 200)
    const metadata = await response.json()
    const manifest = JSON.parse(fs.readFileSync(path.join(engineRoot, 'dist/runtime/build-manifest.json'), 'utf8'))
    assert.equal(metadata.data.buildId, manifest.buildId)
    const expectedDatabase = kind === 'default-entry-directory' ? path.join(directory, 'agent.db') : dataDir
    assert(fs.statSync(expectedDatabase).isFile())
    results.push({ kind, started: true, health: true, buildId: metadata.data.buildId, database: expectedDatabase, baseUrl })
  } finally { await sdk.stop() }
  await assert.rejects(fetch(baseUrl + '/health', { signal: AbortSignal.timeout(1500) }))
}

const skillsRoot = path.join(fixture, 'skills-layout')
const dist = path.join(skillsRoot, 'dist')
fs.mkdirSync(path.join(dist, 'skills'), { recursive: true })
fs.mkdirSync(path.join(skillsRoot, 'SKILLs'), { recursive: true })
const script = path.join(dist, 'named-entry.cjs')
const marker = path.join(fixture, 'skills-marker.json')
fs.writeFileSync(script, `require('node:fs').writeFileSync(process.env.PROBE_RESULT, JSON.stringify({ skills: process.env.SKILLS_ROOT, cwd: process.cwd() })); setInterval(()=>{},1000)\n`)
const inheritedSkills = process.env.SKILLS_ROOT
try {
  delete process.env.SKILLS_ROOT
  for (const kind of ['exact-uppercase-directory', 'inherited-override']) {
    if (fs.existsSync(marker)) fs.unlinkSync(marker)
    if (kind === 'inherited-override') process.env.SKILLS_ROOT = path.join(fixture, 'inherited-skills')
    const handle = startProcess({ binPath: script, cwd: fixture, port: await port(), env: { PROBE_RESULT: marker } })
    try {
      const evidence = await awaitFile(marker)
      assert.equal(evidence.skills, kind === 'inherited-override' ? process.env.SKILLS_ROOT : path.join(skillsRoot, 'SKILLs'))
      assert.equal(evidence.cwd.toLowerCase(), fixture.toLowerCase())
      results.push({ kind, passed: true, selectedSkills: evidence.skills, cwd: evidence.cwd })
    } finally { await handle.stop() }
  }
} finally {
  if (inheritedSkills === undefined) delete process.env.SKILLS_ROOT
  else process.env.SKILLS_ROOT = inheritedSkills
}
fs.writeFileSync(path.join(fixture, 'result.json'), JSON.stringify({ passed: true, checks: results.length, results }, null, 2))
console.log(JSON.stringify({ passed: true, checks: results.length, evidence: path.join(fixture, 'result.json') }))

