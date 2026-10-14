// Archive semantics plus bounded work for ordinary current-turn previews.
import {createHash} from 'node:crypto'
import {afterEach,expect,it,vi} from 'vitest'
import {prepareBootstrapBody,readBootstrapBody} from '../turn-bootstrap-body.js'
import type {Transaction} from '@libsql/client'
type Body=Parameters<typeof prepareBootstrapBody>[0]
const digest=(value:string)=>createHash('sha256').update(value).digest('hex')
const fixture=(projection:Body['projection']):Body=>({schemaVersion:1,streamId:'owned-body',eventId:'owned-body:5',finished:false,projection,projectionIndices:projection.map((_,index)=>index)})
afterEach(()=>vi.restoreAllMocks())
it('leaves a small body intact without inventing an archive',()=>{
 const input=fixture([{run:{runId:'root'}},{content:'Visible body'},{usage:{totalTokens:7}}]),result=prepareBootstrapBody(input)
 expect(result.snapshot).toBe(input);expect(result.chunks).toEqual([]);expect(result.snapshot.bodyArchive).toBeUndefined()
})
it('preserves sealed Unicode bytes and codepoint chunk boundaries at a multi-megabyte body',()=>{
 const input=fixture([{run:{runId:'root'}},{content:('🍏中文\"\\\n').repeat(120000)},{usage:{totalTokens:11}}]),encoded=JSON.stringify(input),result=prepareBootstrapBody(input)
 expect(result.chunks.join('')).toBe(encoded);expect(result.snapshot.bodyArchive).toMatchObject({sha256:digest(encoded),byteLength:Buffer.byteLength(encoded),chunkCount:result.chunks.length,originalProjectionCount:3,originalCurrentTurnComplete:true})
 for(const chunk of result.chunks){expect([...chunk].length).toBeLessThanOrEqual(8192);expect(chunk).not.toMatch(/^[\udc00-\udfff]|[\ud800-\udbff]$/)}
 expect(Buffer.byteLength(JSON.stringify(result.snapshot))).toBeLessThanOrEqual(96*1024)
 expect(result.snapshot.projection).toContainEqual({run:{runId:'root'}});expect(result.snapshot.projection).toContainEqual({usage:{totalTokens:11}})
})
it('keeps required run and billing anchors when late in a dense ordinary projection',()=>{
 const input=fixture([...Array.from({length:1800},(_,index)=>({content:`${index}:`+'x'.repeat(320)})),{run:{runId:'root',status:'running'}},{usage:{totalTokens:250,inputTokens:200,outputTokens:50}}]),result=prepareBootstrapBody(input)
 expect(result.snapshot.projection).toContainEqual(input.projection.at(-2));expect(result.snapshot.projection).toContainEqual(input.projection.at(-1))
 expect(result.snapshot.projectionIndices).toEqual([...result.snapshot.projectionIndices].sort((a,b)=>a-b));expect(new Set(result.snapshot.projectionIndices).size).toBe(result.snapshot.projection.length)
 expect(Buffer.byteLength(JSON.stringify(result.snapshot))).toBeLessThanOrEqual(96*1024)
 expect(result.chunks.join('')).toBe(JSON.stringify(input))
})
it('serializes a dense projection only a linear number of frame visits',()=>{
 const input=fixture(Array.from({length:1800},(_,index)=>({content:`${index}:`+'x'.repeat(320)})))
 const spy=vi.spyOn(JSON,'stringify');prepareBootstrapBody(input)
 const visits=spy.mock.calls.reduce((sum,[value])=>sum+(value&&typeof value==='object'&&'projection' in value&&Array.isArray(value.projection)?value.projection.length:0),0)
 // Repeatedly serializing the growing preview makes this exceed 300,000 visits.
 expect(visits).toBeLessThanOrEqual(input.projection.length*2)
})
it('does not allocate a character array while splitting the sealed body',()=>{
 const input=fixture([{content:'x'.repeat(2*1024*1024)}]),spy=vi.spyOn(Array,'from');prepareBootstrapBody(input)
 expect(spy.mock.calls.filter(([value])=>typeof value==='string')).toHaveLength(0)
})
it('rejects a body exceeding its persisted eight MiB contract',()=>{
 expect(()=>prepareBootstrapBody(fixture([{content:'x'.repeat(8*1024*1024)}]))).toThrow('bootstrap_body_budget')
})
it('rejects an oversized required header instead of emitting an oversized preview',()=>{
 const input={...fixture([{content:'x'.repeat(120000)}]),error:'x'.repeat(100000)}
 expect(()=>prepareBootstrapBody(input)).toThrow('response_budget')
})
it('rechecks exact chunk bytes when restoring and rejects a changed body',async()=>{
 const input=fixture([{content:'🍏'.repeat(50000)}]),result=prepareBootstrapBody(input),encodedPreview=JSON.stringify(result.snapshot)
 const rows=result.chunks.map((chunk,part_index)=>({part_index,chunk,digest:digest(chunk),length:3}))
 const execute=vi.fn<Transaction['execute']>(async query=>{
  if(typeof query==='string'||!query.args||!Array.isArray(query.args))throw Error('Expected a keyset statement')
  const after=Number(query.args[1]);return {rows:rows.filter(row=>row.part_index>after).slice(0,128),columns:[],columnTypes:[],rowsAffected:0,lastInsertRowid:undefined,toJSON:()=>({})}
 })
 const tx={execute} as Pick<Transaction,'execute'>
 // readBootstrapBody only executes keyset reads; no write or transaction action.
 expect(await readBootstrapBody(tx,'checkpoint',encodedPreview,true)).toEqual(input)
 rows[0].chunk='changed'
 await expect(readBootstrapBody(tx,'checkpoint',encodedPreview,true)).rejects.toThrow('bootstrap_body_corrupt')
})
