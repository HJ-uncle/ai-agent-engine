import { createHash } from 'node:crypto'
import type { Transaction } from '@libsql/client'
import type { StreamSnapshot } from '../stream-pipeline/stream-bus.js'
import { requireChildRecovery } from './child-usage-authority.js'
const bootstrapHash = (value: string) => createHash('sha256').update(value).digest('hex')

type BodySnapshot = Omit<StreamSnapshot,'subagentWatermarks'> & { projectionIndices: number[]; bodyArchive?: BootstrapBodyArchive }
export interface BootstrapBodyArchive {
  protocolVersion: 1; source: 'sealed-current-turn'; sha256: string; byteLength: number; chunkCount: number
  originalProjectionCount: number; originalCurrentTurnComplete: boolean; previewComplete: false
  endpoint: '/chat/snapshot/body'
}
const PREVIEW_BYTES = 96 * 1024
const MAX_BODY_BYTES = 8 * 1024 * 1024
const CHUNK_CODEPOINTS = 8192
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value),'utf8')
function nextChunkEnd(value: string, start: number): number {
  let end = start, count = 0
  while (end < value.length && count < CHUNK_CODEPOINTS) {
    const first = value.charCodeAt(end++)
    if (first >= 0xd800 && first <= 0xdbff && end < value.length) {
      const second = value.charCodeAt(end)
      if (second >= 0xdc00 && second <= 0xdfff) end++
    }
    count++
  }
  return end
}
function preview(value: unknown): unknown {
  if (typeof value === 'string') return value.length > 1024 ? value.slice(0,512)+'\n[…正文已归档，请打开完整内容…]\n'+value.slice(-256) : value
  if (Array.isArray(value)) return value.slice(0,16).map(preview)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0,64).map(([key,item])=>[key,preview(item)]))
  return value
}
/** The archive contains only the retained ordinary projection; child bodies
 * were already detached into admitted references before this function. */
export function prepareBootstrapBody(full: BodySnapshot): { snapshot: BodySnapshot; chunks: string[] } {
  const encoded = JSON.stringify(full), byteLength = Buffer.byteLength(encoded,'utf8')
  if (byteLength <= PREVIEW_BYTES) return {snapshot:full,chunks:[]}
  if (byteLength > MAX_BODY_BYTES) requireChildRecovery('bootstrap_body_budget')
  // Walk UTF-16 boundaries without allocating one object per character. The
  // existing codepoint chunk contract and sealed byte digest remain unchanged.
  const chunks: string[] = []
  for (let offset=0; offset<encoded.length;) {
    const end=nextChunkEnd(encoded,offset);chunks.push(encoded.slice(offset,end));offset=end
  }
  const archive: BootstrapBodyArchive = {protocolVersion:1,source:'sealed-current-turn',sha256:bootstrapHash(encoded),byteLength,chunkCount:chunks.length,
    originalProjectionCount:full.projection.length,originalCurrentTurnComplete:full.projectionTruncated!==true,previewComplete:false,endpoint:'/chat/snapshot/body'}
  const {projection: _projection,projectionIndices: _indices,...header}=full
  const snapshot: BodySnapshot={...header,projection:[],projectionIndices:[],projectionTruncated:true,bodyArchive:archive}
  // Run identity/version and the published billing snapshot must survive the
  // preview. Other positions are optional and explicitly archived, never empty.
  const selected=new Map<number,StreamSnapshot['projection'][number]>()
  let selectedBytes=0
  const headerBytes=bytes(snapshot)
  if(headerBytes>PREVIEW_BYTES)requireChildRecovery('response_budget')
  const select=(frame: StreamSnapshot['projection'][number],index: number):void=>{
    if(selected.has(index))return
    const bounded=preview(frame) as StreamSnapshot['projection'][number]
    // Empty array brackets are already in headerBytes. Each additional frame
    // contributes its own bytes, its index and two commas after the first.
    const addition=bytes(bounded)+bytes([full.projectionIndices[index]])-2+(selected.size>0?2:0)
    if(headerBytes+selectedBytes+addition>PREVIEW_BYTES){if(frame.run||frame.usage)requireChildRecovery('response_budget');return}
    selected.set(index,bounded);selectedBytes+=addition
  }
  for(let index=0;index<full.projection.length;index++){
    const frame=full.projection[index];if(frame.run||frame.usage)select(frame,index)
  }
  for(let index=0;index<full.projection.length;index++)select(full.projection[index],index)
  const ordered=[...selected].sort(([a],[b])=>a-b)
  snapshot.projection=ordered.map(([,payload])=>payload);snapshot.projectionIndices=ordered.map(([position])=>full.projectionIndices[position])
  return {snapshot,chunks}
}
/** Receipt verification is bounded by the declared 8 MiB body limit. It hashes
 * SQL keyset pages and checks exact chunk indices, bytes and the sealed digest. */
export async function readBootstrapBody(tx: Pick<Transaction,'execute'>, checkpointId: string, encodedPreview: string, restore = false): Promise<BodySnapshot> {
  let snapshot: BodySnapshot
  try { snapshot=JSON.parse(encodedPreview) as BodySnapshot } catch { requireChildRecovery('bootstrap_body_corrupt') }
  const archive=snapshot.bodyArchive
  if(!archive)return snapshot
  if(archive.protocolVersion!==1||archive.source!=='sealed-current-turn'||archive.previewComplete!==false||archive.endpoint!=='/chat/snapshot/body'||
    !/^[a-f0-9]{64}$/.test(archive.sha256)||!Number.isSafeInteger(archive.byteLength)||archive.byteLength<1||archive.byteLength>MAX_BODY_BYTES||
    !Number.isSafeInteger(archive.chunkCount)||archive.chunkCount<1||archive.chunkCount>Math.ceil(MAX_BODY_BYTES/CHUNK_CODEPOINTS)||!Number.isSafeInteger(archive.originalProjectionCount)||
    archive.originalProjectionCount<1||archive.originalProjectionCount>16384||typeof archive.originalCurrentTurnComplete!=='boolean')requireChildRecovery('bootstrap_body_corrupt')
  const hash=createHash('sha256'),parts:string[]=[];let after=-1,count=0,total=0
  for(;;){
    const rows=(await tx.execute({sql:'SELECT part_index,chunk,digest FROM parent_turn_bootstrap_body_chunks WHERE checkpoint_id=? AND part_index>? ORDER BY part_index LIMIT 128',args:[checkpointId,after]})).rows
    for(const row of rows){
      const chunk=String(row.chunk),index=Number(row.part_index)
      if(index!==count||bootstrapHash(chunk)!==row.digest||nextChunkEnd(chunk,0)!==chunk.length)requireChildRecovery('bootstrap_body_corrupt')
      hash.update(chunk);total+=Buffer.byteLength(chunk,'utf8');if(total>MAX_BODY_BYTES)requireChildRecovery('bootstrap_body_corrupt')
      if(restore)parts.push(chunk);after=index;count++
    }
    if(rows.length<128)break
  }
  if(count!==archive.chunkCount||total!==archive.byteLength||hash.digest('hex')!==archive.sha256)requireChildRecovery('bootstrap_body_corrupt')
  if(!restore)return snapshot
  let full:BodySnapshot
  try{full=JSON.parse(parts.join('')) as BodySnapshot}catch{requireChildRecovery('bootstrap_body_corrupt')}
  if(full.bodyArchive||full.streamId!==snapshot.streamId||full.eventId!==snapshot.eventId||full.finished!==snapshot.finished||
    !Array.isArray(full.projection)||!Array.isArray(full.projectionIndices)||full.projection.length!==archive.originalProjectionCount||
    full.projection.length!==full.projectionIndices.length||(full.projectionTruncated!==true)!==archive.originalCurrentTurnComplete)requireChildRecovery('bootstrap_body_corrupt')
  return full
}
