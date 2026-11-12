import { afterAll, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readdirSync, rmdirSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { collectToolEvidence, durableArtifactEvidence, sseToolTraces } from '../../../scripts/diagnostics/plugin-real-world-evidence.mjs'

const parent=resolve('.e2e-tmp/plugin-real-world-evidence-unit')
mkdirSync(parent,{recursive:true})
const root=mkdtempSync(join(parent,'run-')),owned=[]
const event=value=>'data: '+JSON.stringify(value)+'\n\n'
afterAll(()=>{for(const file of owned)unlinkSync(file);rmdirSync(root);if(readdirSync(parent).length===0)rmdirSync(parent)})

describe('real model acceptance evidence',()=>{
  it('keeps the actual approved result instead of the earlier waiting result',()=>{
    const text=event({toolCall:{toolCallId:'a',name:'plugin_test',args:{id:'中文',revision:4},rootRunId:'run'}})
      +event({toolResult:{toolCallId:'a',name:'plugin_test',success:false,status:'waiting',output:'confirmation'}})
      +event({toolResult:{toolCallId:'a',name:'plugin_test',success:true,status:'succeeded',output:'{"failed":0}'}})
    expect(sseToolTraces(text)).toEqual([{id:'a',name:'plugin_test',args:{id:'中文',revision:4},rootRunId:'run',success:true,status:'succeeded',text:'{"failed":0}',output:{failed:0}}])
  })
  it('survives a compacted history by combining per-turn SSE without snapshots',()=>{
    const first=join(root,'stage-0-initial.sse.txt'),second=join(root,'stage-1-initial.sse.txt')
    owned.push(first,second)
    writeFileSync(first,event({toolResult:{toolCallId:'create',name:'plugin_create',args:{manifest:{id:'flow'}},success:true,status:'succeeded',output:'{"revision":1}'}}))
    writeFileSync(second,'data: [DONE]\n'+'data: {broken\n'+event({toolResult:{toolCallId:'update',name:'plugin_update',args:{id:'flow',expectedRevision:1},success:true,status:'succeeded',output:'{"revision":2}'}}))
    utimesSync(first,1,1);utimesSync(second,2,2)
    expect(collectToolEvidence(root).map(c=>[c.id,c.output.revision])).toEqual([['create',1],['update',2]])
    expect(collectToolEvidence(root,f=>f.startsWith('stage-1-')).map(c=>c.name)).toEqual(['plugin_update'])
  })
  it('preserves a failed mixed test batch and its stated reason',()=>{
    const text=event({toolResult:{toolCallId:'mixed',name:'plugin_test',args:{revision:37},success:false,status:'failed',output:'{"results": [truncated',error:'1 个插件测试用例失败'}})
    const [trace]=sseToolTraces(text)
    expect(trace.success).toBe(false)
    expect(trace.error).toBe('1 个插件测试用例失败')
    expect(trace.output).toBeUndefined()
    expect(trace.args.revision).toBe(37)
  })
  it('checks truncated-response business evidence against the actual same-call durable file',()=>{
    const path=join(root,'durable.json'),newContent=JSON.stringify({affected:['src/真实.ts']}),plugin={id:'project-impact',revision:79,hash:'sha256:published'}
    owned.push(path);writeFileSync(path,newContent)
    const change={path,toolCallId:'actual-call',kind:'write',truncated:false,newContent,newHash:'sha256:'+createHash('sha256').update(newContent).digest('hex')}
    const call={id:'actual-call',success:true,status:'succeeded',text:'{"result": [truncated',toolMetadata:{outputTruncated:true,plugin,changes:[change]}}
    const evidence=durableArtifactEvidence(call,{workspace:root,plugin})
    expect(evidence.result).toEqual({affected:['src/真实.ts']})
    expect(evidence.businessEvidenceSource).toBe('durable-json-artifact')
    expect(evidence.outputTruncated).toBe(true)
    expect(evidence.artifacts[0].byteLength).toBe(Buffer.byteLength(newContent))
    expect(call.output).toBeUndefined()
    expect(()=>durableArtifactEvidence({...call,id:'different-call'},{workspace:root,plugin})).toThrow('different tool call')
    expect(()=>durableArtifactEvidence(call,{workspace:root,plugin:{...plugin,revision:80}})).toThrow('exact published plugin')
    expect(()=>durableArtifactEvidence(call,{workspace:join(root,'elsewhere'),plugin})).toThrow('escapes')
    writeFileSync(path,newContent+' ')
    expect(()=>durableArtifactEvidence(call,{workspace:root,plugin})).toThrow('differs from complete write receipt')
  })
})
