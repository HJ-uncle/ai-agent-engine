import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import test from 'node:test'
import assert from 'node:assert/strict'
import { RetainedEventTail } from './retained-event-tail.mjs'
test('tail retains real timestamps and decodes split UTF-8 without repeated or partial frames',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'continuation-event-tail-'));t.after(()=>{assert.equal(path.dirname(root),os.tmpdir());assert.match(path.basename(root),/^continuation-event-tail-/);fs.rmSync(root,{recursive:true,force:true})})
  const file=path.join(root,'events.jsonl'),event={at:123,id:'real',data:{content:'中文✓'}},bytes=Buffer.from(JSON.stringify(event)+'\n'),split=bytes.indexOf(Buffer.from('中文'))+1
  fs.writeFileSync(file,bytes.subarray(0,split));const tail=new RetainedEventTail()
  assert.deepEqual(tail.read(file),[]);fs.appendFileSync(file,bytes.subarray(split));assert.deepEqual(tail.read(file),[event]);assert.deepEqual(tail.read(file),[])
  const next={at:130,id:'next',data:{toolCall:{name:'execute_cmd'}}};fs.appendFileSync(file,JSON.stringify(next)+'\n');assert.deepEqual(tail.read(file),[next]);assert.equal(tail.offset,fs.statSync(file).size)
  fs.truncateSync(file,0);assert.throws(()=>tail.read(file),/truncated/)
})
