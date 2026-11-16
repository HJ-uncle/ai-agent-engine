import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PluginService } from '../service.js'
import { getPluginTemplate } from '../templates.js'
import { runPlugin } from '../runtime.js'
import type { PluginRunOptions } from '../types.js'

const fixtures = path.resolve('.e2e-tmp/plugin-node-stream')
let root: string, service: PluginService
beforeEach(() => {
  fs.mkdirSync(fixtures, { recursive: true })
  root = fs.mkdtempSync(path.join(fixtures, 'case-'))
  service = new PluginService(path.join(root, 'plugins'))
})
afterEach(() => {
  vi.restoreAllMocks()
  if (path.dirname(root) !== fixtures || fs.lstatSync(root).isSymbolicLink()) throw new Error('Unsafe fixture cleanup')
  fs.rmSync(root, { recursive: true, force: true })
  if (fs.existsSync(fixtures) && !fs.readdirSync(fixtures).length) fs.rmdirSync(fixtures)
})
async function run(source: string, capability: NonNullable<PluginRunOptions['capability']>) {
  const template = getPluginTemplate('json-tool')
  template.files['main.mjs'] = `let input='';for await(const chunk of process.stdin)input+=chunk;${source}`
  await service.create('tenant-stream', template)
  await service.publish('tenant-stream', template.manifest.id, 1)
  return runPlugin(await service.snapshot('tenant-stream', template.manifest.id, 1), 'normalize_text', { text: 'x' }, { capability })
}

describe('Node plugin streaming IPC', () => {
  it('delivers Unicode deltas before completion and waits for asynchronous event consumers', async () => {
    const timers = vi.spyOn(globalThis, 'setTimeout')
    const stages: string[] = []
    const output = await run(`
      const events=[];
      const result=await $AE.ai.stream({modelId:'test',prompt:'x'},{onEvent:async e=>{
        if(e.type==='text-delta'){
          await new Promise(resolve=>setTimeout(resolve,20));
          events.push(e.text);
        }
      }});
      console.log(JSON.stringify({result:{text:result.text,events}}));
    `, async (call, _signal, onEvent) => {
      expect(call).toMatchObject({ capability: 'ai.run', method: 'stream' })
      await onEvent!({ type: 'text-delta', text: '先到🙂' }); stages.push('first-ack')
      await onEvent!({ type: 'text-delta', text: '再到' }); stages.push('second-ack')
      const result = { text: '先到🙂再到', model: 'test', usage: { inputTokens: 1, outputTokens: 2 } }
      await onEvent!({ type: 'complete', result }); stages.push('complete-ack')
      return result
    })
    expect(output.result).toEqual({ text: '先到🙂再到', events: ['先到🙂', '再到'] })
    expect(stages).toEqual(['first-ack', 'second-ack', 'complete-ack'])
    expect(timers.mock.calls.some(([, delay]) => delay === 30000 || delay === 60000 || delay === 120000)).toBe(false)
  })

  it('supports more than four simultaneous SDK calls without a hidden Node request cap', async () => {
    let count = 0, release!: () => void
    const ready = new Promise<void>(resolve => { release = resolve })
    try {
      const output = await run(`
        const values=await Promise.all(Array.from({length:6},()=> $AE.models.list()));
        console.log(JSON.stringify({result:values.length}));
      `, async () => {
        if (++count === 6) release()
        await ready
        return { models: [] }
      })
      expect(output.result).toBe(6)
      expect(count).toBe(6)
    } finally { release() }
  })

  it('cancels the host request when the plugin aborts its stream', async () => {
    let cancelled = false
    const output = await run(`
      const controller=new AbortController();
      try{await $AE.ai.stream({modelId:'test',prompt:'x'},{signal:controller.signal,onEvent:e=>{
        if(e.type==='text-delta')controller.abort();
      }});console.log(JSON.stringify({result:'unexpected'}))}
      catch(error){console.log(JSON.stringify({result:{name:error.name}}))}
    `, async (_call, signal, onEvent) => {
      signal.addEventListener('abort', () => { cancelled = true }, { once: true })
      await onEvent!({ type: 'text-delta', text: 'partial' })
      throw new Error('should never finish successfully')
    })
    expect(output.result).toEqual({ name: 'AbortError' })
    expect(cancelled).toBe(true)
  })

  it('rejects a failed consumer and aborts upstream instead of hanging for another chunk', async () => {
    let cancelled = false
    const output = await run(`
      try{await $AE.agents.stream({modelId:'test',task:'x'},{onEvent:()=>{throw new Error('render failed')}})}
      catch(error){console.log(JSON.stringify({result:{message:error.message}}))}
    `, async (call, signal, onEvent) => {
      expect(call).toMatchObject({ capability: 'agents.manage', method: 'stream' })
      signal.addEventListener('abort', () => { cancelled = true }, { once: true })
      await onEvent!({ type: 'text-delta', text: 'partial' })
    })
    expect(output.result).toEqual({ message: 'render failed' })
    expect(cancelled).toBe(true)
  })

  it('exposes MCP tool discovery without changing ordinary run behavior', async () => {
    const calls: string[] = []
    const output = await run(`
      const tools=await $AE.mcp.tools({serverId:'test'});
      const result=await $AE.ai.run({modelId:'test',prompt:'x'});
      console.log(JSON.stringify({result:{tools,text:result.text}}));
    `, async call => {
      calls.push(call.capability + ':' + call.method)
      return call.method === 'tools' ? { tools: [{ name: 'inspect', inputSchema: { type: 'object' } }] } : { text: 'ordinary' }
    })
    expect(calls).toEqual(['mcp.read:tools', 'ai.run:run'])
    expect(output.result).toMatchObject({ text: 'ordinary', tools: { tools: [{ name: 'inspect' }] } })
  })
})
