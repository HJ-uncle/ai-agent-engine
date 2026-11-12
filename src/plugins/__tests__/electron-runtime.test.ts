import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { stopCommandProcessTree } from '../../core/command-jobs/process-tree.js'

const require = createRequire(import.meta.url)
const root = path.resolve('.')
function electronExecutable(): string | undefined {
  if (process.env.PLUGIN_ELECTRON_EXECUTABLE) return path.resolve(process.env.PLUGIN_ELECTRON_EXECUTABLE)
  if (process.versions.electron) return process.execPath
  try { return require('electron') as string } catch { /* The engine itself has no Electron dependency. */ }
  const sibling = path.resolve(root, '..', 'aether-code', 'node_modules', 'electron', 'dist',
    process.platform === 'win32' ? 'electron.exe' : process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : 'electron')
  return fs.existsSync(sibling) ? sibling : undefined
}
const executable = electronExecutable()

describe.skipIf(!executable)('real Electron-as-Node plugin runtime', () => {
  it('keeps stdin JSON/EOF, Node isolation and cancellation correct under the desktop executable', async () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-electron-runtime-'))
    const runner = path.join(fixture, 'host.mjs')
    const tsxApi = pathToFileURL(path.join(path.dirname(require.resolve('tsx/esm/api')), 'index.mjs')).href
    const serviceModule = pathToFileURL(path.join(root, 'src/plugins/service.ts')).href
    const runtimeModule = pathToFileURL(path.join(root, 'src/plugins/runtime.ts')).href
    fs.writeFileSync(runner, [
      "import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';",
      'import {tsImport} from ' + JSON.stringify(tsxApi) + ';',
      'const {PluginService}=await tsImport(' + JSON.stringify(serviceModule) + ',import.meta.url);',
      'const {runPlugin}=await tsImport(' + JSON.stringify(runtimeModule) + ',import.meta.url);',
      'const fixture=' + JSON.stringify(fixture) + ';',
      "assert(process.versions.electron);assert.equal(process.env.ELECTRON_RUN_AS_NODE,'1');",
      // Launch-time secrets are present in the host but must not cross to the plugin.
      "process.env.NODE_OPTIONS='--require=nonexistent-secret-module.cjs';process.env.PLUGIN_ELECTRON_TEST_SECRET='not-for-plugin';",
      "const service=new PluginService(path.join(fixture,'plugins'));",
      "const manifest={apiVersion:1,id:'electron-stdin',name:'Electron stdin',version:'1',description:'Real desktop host runtime test',runtime:'node',tools:[{name:'echo',description:'Echo exact stdin',entry:'main.mjs',inputSchema:{type:'object',properties:{text:{type:'string'},value:{type:'integer'}},required:['text'],additionalProperties:false}},{name:'hang',description:'Cancellation',entry:'hang.mjs',inputSchema:{type:'object'}}]};",
      "const main=\"let raw='';let chunks=0;for await(const chunk of process.stdin){raw+=chunk;chunks++}const payload=JSON.parse(raw);console.log(JSON.stringify({result:{payload,rawBytes:Buffer.byteLength(raw),chunks,electron:process.versions.electron,asNode:process.env.ELECTRON_RUN_AS_NODE,options:process.env.NODE_OPTIONS??null,secret:process.env.PLUGIN_ELECTRON_TEST_SECRET??null,requireType:typeof require,argv:process.argv}}));\";",
      "await service.create('fixture',{manifest,files:{'main.mjs':main,'hang.mjs':\"for await(const chunk of process.stdin){};setInterval(()=>{},1000)\"}});",
      "const snapshot=await service.snapshot('fixture','electron-stdin',1,{allowDraft:true});",
      "const args={text:'苹果 stdin 🍎\\r\\n'+'x'.repeat(180000),value:73};",
      "const first=await runPlugin(snapshot,'echo',args,{timeoutMs:5000});",
      "assert.deepEqual(first.result.payload,{tool:'echo',args});assert.equal(first.result.asNode,'1');assert(first.result.electron);assert.equal(first.result.options,null);assert.equal(first.result.secret,null);assert.equal(first.result.requireType,'undefined');assert.equal(first.result.rawBytes,Buffer.byteLength(JSON.stringify({tool:'echo',args})+'\\n'));",
      "await assert.rejects(()=>runPlugin(snapshot,'echo',{text:7}),error=>error.code==='PLUGIN_ARGUMENTS');",
      "const abort=new AbortController();const pending=runPlugin(snapshot,'hang',{}, {signal:abort.signal,timeoutMs:5000});setTimeout(()=>abort.abort(),200);await assert.rejects(pending,error=>error.code==='PLUGIN_CANCELLED');",
      "const again=await runPlugin(snapshot,'echo',{text:'after cancellation',value:9},{timeoutMs:5000});assert.equal(again.result.payload.args.value,9);",
      "console.log(JSON.stringify({host:{electron:process.versions.electron,execPath:process.execPath},stdin:{bytes:first.result.rawBytes,chunks:first.result.chunks,text:args.text.slice(0,16),value:first.result.payload.args.value},isolated:{nodeOptions:first.result.options,secret:first.result.secret,requireType:first.result.requireType},cancelled:true,reusable:true}));",
    ].join('\n'))
    let child: ReturnType<typeof spawn> | undefined
    try {
      const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
        child = spawn(executable!, [runner], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '' },
          cwd: root, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' })
        const startedAt = Date.now()
        let stdout = '', stderr = '', timeout = false
        const timer = setTimeout(() => { timeout = true; void stopCommandProcessTree(child!, startedAt) }, 20_000)
        child.stdout!.on('data', chunk => { stdout += chunk.toString() })
        child.stderr!.on('data', chunk => { stderr += chunk.toString() })
        child.once('error', error => { clearTimeout(timer); reject(error) })
        child.once('close', code => { clearTimeout(timer); timeout ? reject(new Error('Electron runtime regression exceeded deadline: ' + stderr)) : resolve({ code, stdout, stderr }) })
      })
      expect(result.code, result.stderr).toBe(0)
      const report = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1)!)
      expect(report).toMatchObject({ host: { execPath: executable }, stdin: { value: 73 }, isolated: { nodeOptions: null, secret: null, requireType: 'undefined' }, cancelled: true, reusable: true })
      expect(report.stdin.bytes).toBeGreaterThan(180_000)
      expect(report.stdin.chunks).toBeGreaterThan(0)
    } finally {
      if (path.dirname(fixture) !== path.resolve(os.tmpdir()) || !path.basename(fixture).startsWith('plugin-electron-runtime-')) throw new Error('Unsafe Electron fixture cleanup')
      fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    }
  }, 30_000)
})
