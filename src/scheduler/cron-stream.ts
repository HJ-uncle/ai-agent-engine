import type { RootRunStatus } from '../storage/root-runs/index.js'
export interface CronStreamOutcome { runId?:string; status?:RootRunStatus }
/** Retain only the current SSE frame; the persistent root supplies the final outcome. */
export async function consumeCronStream(response:Response,sessionId:string,onRun:(runId:string)=>void):Promise<CronStreamOutcome> {
  if (!response.body) throw new Error('Cron chat rejected: missing stream')
  if (response.headers.get('content-type')?.includes('application/json')) throw new Error('Cron chat rejected: expected SSE, received JSON response')
  const reader=response.body.getReader();const decoder=new TextDecoder();let buffer=''
  const outcome:CronStreamOutcome={};const maxFrameChars=1024*1024
  function frame(block:string) {
    const data=block.split(/\r?\n/).filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trim()).join('\n')
    if (!data || data==='[DONE]') return
    let event:{code?:number;error?:unknown;run?:{runId?:string;sessionId?:string;status?:RootRunStatus}}
    try {event=JSON.parse(data)} catch {throw new Error('Cron chat rejected: malformed SSE')}
    if (!event || typeof event!=='object' || event.error || (event.code!=null && event.code!==200)) throw new Error('Cron chat rejected: error envelope')
    if (!event.run || event.run.sessionId!==sessionId) return
    if (!event.run.runId) throw new Error('Cron chat rejected: missing run identity')
    if (outcome.runId && outcome.runId!==event.run.runId) throw new Error('Cron chat rejected: conflicting run identity')
    outcome.runId=event.run.runId;outcome.status=event.run.status;onRun(outcome.runId)
  }
  try {
    for (;;) {
      const {value,done}=await reader.read();buffer+=decoder.decode(value,{stream:!done})
      for (;;) {
        const separator=/\r?\n\r?\n/.exec(buffer);if (!separator) break
        if (separator.index>maxFrameChars) throw new Error('Cron SSE frame exceeds size limit')
        frame(buffer.slice(0,separator.index));buffer=buffer.slice(separator.index+separator[0].length)
      }
      if (buffer.length>maxFrameChars) throw new Error('Cron SSE frame exceeds size limit')
      if (done) break
    }
    if (buffer.trim()) frame(buffer)
    return outcome
  } finally {await reader.cancel().catch(()=>{});reader.releaseLock()}
}
