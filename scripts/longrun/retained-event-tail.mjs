import fs from 'node:fs'
import { StringDecoder } from 'node:string_decoder'

// Observe append-only event traces without rereading prior output or inventing
// timestamps. A restart creates a new tail and replays the retained originals.
export class RetainedEventTail {
  offset=0
  pending=''
  decoder=new StringDecoder('utf8')
  identity
  read(file) {
    const stat=fs.lstatSync(file)
    if(!stat.isFile()||stat.isSymbolicLink())throw new Error('Regular retained event file required')
    const identity=stat.dev+':'+stat.ino
    if(this.identity&&this.identity!==identity||stat.size<this.offset)throw new Error('Retained event trace replaced or truncated')
    this.identity=identity
    if(stat.size===this.offset)return []
    const fd=fs.openSync(file,'r'),events=[]
    try {
      const buffer=Buffer.alloc(256*1024),end=stat.size
      while(this.offset<end) {
        const bytes=fs.readSync(fd,buffer,0,Math.min(buffer.length,end-this.offset),this.offset)
        if(!bytes)throw new Error('Retained trace changed during observation')
        this.offset+=bytes
        this.pending+=this.decoder.write(buffer.subarray(0,bytes))
        let newline
        while((newline=this.pending.indexOf('\n'))!==-1) {
          const line=this.pending.slice(0,newline);this.pending=this.pending.slice(newline+1)
          if(line.trim())events.push(JSON.parse(line))
        }
      }
    }finally{fs.closeSync(fd)}
    return events
  }
}
