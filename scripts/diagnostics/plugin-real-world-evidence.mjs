import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'

/** A truncated model-visible response is not reconstructed as tool output.
 * Verify independent durable-write evidence against the same actual call. */
export function durableArtifactEvidence(call,{workspace,plugin}){
  const metadata=call.toolMetadata
  assert(call.success&&call.status==='succeeded','Only successful tool calls have accepted artifact evidence')
  assert.equal(metadata?.outputTruncated,true,'Fallback requires explicit tool-output truncation')
  assert.deepEqual(metadata.plugin,{id:plugin.id,revision:plugin.revision,hash:plugin.hash},'Artifact evidence must identify the exact published plugin')
  assert(Array.isArray(metadata.changes)&&metadata.changes.length,'Truncated call has no durable write receipts')
  const boundary=resolve(workspace)+sep,seen=new Set()
  const artifacts=metadata.changes.map(change=>{
    assert.equal(change.toolCallId,call.id,'Write receipt belongs to a different tool call')
    assert.equal(change.kind,'write');assert.equal(change.truncated,false,'Write receipt content must be complete')
    assert.equal(typeof change.newContent,'string');assert.match(change.newHash,/^sha256:[a-f0-9]{64}$/)
    const target=resolve(change.path);assert(target.startsWith(boundary),'Artifact escapes isolated workspace')
    assert(!seen.has(target),'Duplicate artifact write receipt');seen.add(target)
    for(let current=target;;){assert(existsSync(current),'Artifact path does not exist');assert(!lstatSync(current).isSymbolicLink(),'Artifact path traverses a link or junction');const parent=dirname(current);if(parent===current)break;current=parent}
    const bytes=readFileSync(target),expected=Buffer.from(change.newContent,'utf8'),sha256=createHash('sha256').update(bytes).digest('hex')
    assert.equal(Buffer.compare(bytes,expected),0,'Artifact differs from complete write receipt content')
    assert.equal(sha256,change.newHash.slice(7),'Artifact differs from durable write receipt hash')
    return {path:target,byteLength:bytes.byteLength,sha256,toolCallId:call.id,verified:true}
  })
  const jsonArtifacts=artifacts.filter(a=>a.path.toLowerCase().endsWith('.json'))
  assert.equal(jsonArtifacts.length,1,'Truncated business evidence requires one unambiguous JSON report')
  const artifact=jsonArtifacts[0],result=JSON.parse(readFileSync(artifact.path,'utf8'))
  return {businessEvidenceSource:'durable-json-artifact',outputTruncated:true,artifactPath:artifact.path,toolCallId:call.id,plugin:metadata.plugin,result,artifacts}
}

/** SSE retains tool evidence even when the model context/history is compacted. */
export function sseToolTraces(text) {
  const calls=new Map()
  for(const line of text.split(/\r?\n/)){
    if(!line.startsWith('data: {'))continue
    let event;try{event=JSON.parse(line.slice(6))}catch{continue}
    const call=event.toolCall,result=event.toolResult,item=result??call
    if(!item?.toolCallId)continue
    const previous=calls.get(item.toolCallId)??{},next={...previous,id:item.toolCallId,name:item.name??item.toolName,args:item.args??previous.args,rootRunId:item.rootRunId??previous.rootRunId}
    if(result){next.success=result.success===true;next.status=result.status;next.text=result.output;const error=result.error??result.metadata?.error;if(error!==undefined)next.error=error;else delete next.error;try{next.output=typeof result.output==='string'?JSON.parse(result.output):result.output}catch{next.output=undefined}}
    calls.set(item.toolCallId,next)
  }
  return [...calls.values()]
}

export function collectToolEvidence(directory,acceptFile=()=>true){
  const files=readdirSync(directory).filter(f=>f.endsWith('.sse.txt')&&acceptFile(f)).sort((a,b)=>statSync(join(directory,a)).mtimeMs-statSync(join(directory,b)).mtimeMs)
  const calls=new Map()
  for(const file of files)for(const call of sseToolTraces(readFileSync(join(directory,file),'utf8'))){const prior=calls.get(call.id);calls.set(call.id,call.status?{...prior,...call}:{...call,...prior})}
  return [...calls.values()]
}
