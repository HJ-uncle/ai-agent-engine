// Local read-only aggregate scan; no text, session IDs or file names are emitted.
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { createGzip } from 'node:zlib'
import { Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createHash } from 'node:crypto'
const root = path.resolve(process.argv[2]), output = path.resolve(process.argv[3])
const files = []
function discover(dir) {
  for(const e of fs.readdirSync(dir,{withFileTypes:true})) {
    const p=path.join(dir,e.name), s=fs.lstatSync(p)
    if(s.isSymbolicLink()) continue
    if(s.isDirectory()) discover(p)
    else if(s.isFile() && e.name.endsWith('.jsonl')) files.push({p,size:s.size,mtime:s.mtimeMs})
  }
}
discover(root);files.sort((a,b)=>b.size-a.size)
const byteSize = v => v == null ? 0 : Buffer.byteLength(typeof v==='string'?v:JSON.stringify(v))
const aggregate={files:files.length,physicalBytes:files.reduce((s,f)=>s+f.size,0),rows:0,invalidRows:0,types:{},decodedFields:{},topFiles:[],changedDuringScan:0,
  microcompactCopies:{matchedUpdates:0,matchingDecodedBytes:0,unmatchedUpdates:0},embeddedDataUrls:{occurrences:0,encodedCharacters:0,uniqueOccurrences:0,uniqueEncodedCharacters:0}}
const imageHashes=new Set()
const hash=v=>createHash('sha256').update(typeof v==='string'?v:JSON.stringify(v)).digest('hex')
for(let i=0;i<files.length;i++) {
  const file=files[i], local={rank:i+1,physicalBytes:file.size,rows:0,invalidRows:0,types:{},decodedFields:{}}
  const originals=new Map()
  if(file.size) for await(const line of readline.createInterface({input:fs.createReadStream(file.p,{end:file.size-1}),crlfDelay:Infinity})) {
    if(!line.trim())continue
    aggregate.rows++;local.rows++
    let row;try{row=JSON.parse(line)}catch{aggregate.invalidRows++;local.invalidRows++;continue}
    const type=['user','assistant','system','tool','summary','update','tombstone','usage'].includes(row.type)?row.type:'other'
    const bytes=Buffer.byteLength(line)+1
    for(const dst of [aggregate,local]) {dst.types[type]??={rows:0,bytes:0};dst.types[type].rows++;dst.types[type].bytes+=bytes}
    const fields={payloadContent:row.payload?.content,modelInputContent:row.payload?.modelInputContent,reasoningContent:row.payload?.reasoningContent,
      toolCall:row.payload?.toolCall,metadata:row.payload?.metadata,updateArchiveContent:row.archiveContent,updateContent:row.content,summary:row.summary}
    for(const [k,v]of Object.entries(fields))for(const dst of [aggregate,local])dst.decodedFields[k]=(dst.decodedFields[k]??0)+byteSize(v)
    if(row.type==='tool' && row.uuid && row.payload?.content!==undefined)originals.set(row.uuid,hash(row.payload.content))
    if(row.type==='update' && row.archiveContent!==undefined){
      if(originals.get(row.targetUuid)===hash(row.archiveContent)){aggregate.microcompactCopies.matchedUpdates++;aggregate.microcompactCopies.matchingDecodedBytes+=byteSize(row.archiveContent)}
      else aggregate.microcompactCopies.unmatchedUpdates++
    }
    for(const value of [row.payload?.content,row.payload?.modelInputContent,row.archiveContent])if(value!==undefined){
      const text=typeof value==='string'?value:JSON.stringify(value)
      for(const match of text.matchAll(/data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/]+={0,2}/gi)){
        const image=match[0],id=hash(image);aggregate.embeddedDataUrls.occurrences++;aggregate.embeddedDataUrls.encodedCharacters+=image.length
        if(!imageHashes.has(id)){imageHashes.add(id);aggregate.embeddedDataUrls.uniqueOccurrences++;aggregate.embeddedDataUrls.uniqueEncodedCharacters+=image.length}
      }
    }
  }
  const after=fs.statSync(file.p);if(after.size!==file.size||after.mtimeMs!==file.mtime)aggregate.changedDuringScan++
  if(i<3){let gzipBytes=0;await pipeline(fs.createReadStream(file.p,{end:file.size-1}),createGzip({level:6}),new Writable({write(chunk,_encoding,done){gzipBytes+=chunk.length;done()}}));local.gzipLevel6Bytes=gzipBytes;aggregate.topFiles.push(local)}
}
fs.writeFileSync(output,JSON.stringify(aggregate,null,2)+'\n');console.log(JSON.stringify(aggregate,null,2))
