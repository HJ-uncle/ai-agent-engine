import { describe, expect, it } from 'vitest'
import { consumeCronStream } from '../cron-stream.js'
const event = (status: string, runId = 'owned') => 'data: ' + JSON.stringify({run:{runId,sessionId:'s',status}}) + '\r\n\r\n'
function chunks(text: string, size = 7) {
  const bytes = new TextEncoder().encode(text)
  return new Response(new ReadableStream({ start(controller) {
    for(let i=0;i<bytes.length;i+=size) controller.enqueue(bytes.slice(i,i+size))
    controller.close()
  }}), {headers:{'content-type':'text/event-stream'}})
}
describe('bounded Cron SSE consumption', () => {
  it('handles fragmented UTF8 and CRLF frames while retaining the run identity', async () => {
    const ids: string[] = []
    await consumeCronStream(chunks(event('running')+'data: {"content":"中文"}\r\n\r\n'+event('succeeded')), 's', id => ids.push(id))
    expect(ids).toEqual(['owned','owned'])
  })
  it('does not retain the accumulated transcript', async () => {
    const frame='data: '+JSON.stringify({content:'x'.repeat(8192)})+'\n\n'
    await consumeCronStream(chunks(event('running')+frame.repeat(300)+event('succeeded'),16384),'s',()=>{})
  })
  it('rejects oversized unfinished frames and conflicting identities', async () => {
    await expect(consumeCronStream(chunks('data: '+ 'x'.repeat(1024*1024+1),8192),'s',()=>{})).rejects.toThrow('size limit')
    await expect(consumeCronStream(chunks(event('running')+event('succeeded','other')),'s',()=>{})).rejects.toThrow('conflicting')
  })
  it('rejects HTTP200 JSON failures and SSE failure envelopes', async () => {
    await expect(consumeCronStream(new Response('{"code":40001}',{headers:{'content-type':'application/json'}}),'s',()=>{})).rejects.toThrow('received JSON')
    await expect(consumeCronStream(chunks('data: {"code":40001}\n\n'),'s',()=>{})).rejects.toThrow('error envelope')
  })
})
