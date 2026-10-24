/** Real JSONL and native SQLite failure/interleaving contracts; all summaries are local deferred values. */
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { closeDb, getDb, initDb } from '../../sqlite/db.js'
import type { LocalSqliteProcessClient } from '../../sqlite/local-process-client.js'
import { createConversationHistory } from '../factory.js'
import { JSONLConversationHistory } from '../jsonl-history.js'
import { withSessionHistoryMutation } from '../serialization.js'
import { isSessionHistoryCompressing, waitForSessionHistoryCompression } from '../serialization.js'
import { rootRunStore } from '../../root-runs/index.js'

let fixture: string, db: LocalSqliteProcessClient
let tenantId='isolation-contract'
const sessionId='code-b'
let ctx={tenantId,sessionId}
const fixtureRoot=path.resolve('.e2e-tmp')
const pending=new Set<Promise<unknown>>()
const releases=new Set<()=>void>()
function deferred<T>() {let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done});return {promise,resolve}}
async function promptly<T>(operation:Promise<T>):Promise<T> {
  let timer:ReturnType<typeof setTimeout>|undefined
  try {return await Promise.race([operation,new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(new Error('Operation waited for a model or for its own queue')),1_000)})])}
  finally {if(timer)clearTimeout(timer)}
}
beforeEach(async()=>{
  const previous=getDb() as LocalSqliteProcessClient;closeDb();await previous.whenClosed()
  fs.mkdirSync(fixtureRoot,{recursive:true});fixture=fs.mkdtempSync(path.join(fixtureRoot,'history-contract-'))
  // SQLite tombstones belong to a tenant/session across client instances. Each
  // fixture represents a separate tenant so clear cannot suppress the next seed.
  tenantId=path.basename(fixture);ctx={tenantId,sessionId}
  vi.stubEnv('DATA_DIR',path.join(fixture,'agent.db'));vi.stubEnv('HISTORY_BACKEND','jsonl')
  db=getDb() as LocalSqliteProcessClient;await initDb()
})
afterEach(async()=>{
  for(const release of releases)release();releases.clear()
  await Promise.allSettled([...pending]);pending.clear()
  closeDb();await db.whenClosed();vi.restoreAllMocks();vi.unstubAllEnvs()
  if(path.dirname(fixture)!==fixtureRoot||!path.basename(fixture).startsWith('history-contract-'))throw new Error('Unsafe isolation fixture cleanup')
  fs.rmSync(fixture,{recursive:true,force:true,maxRetries:5,retryDelay:20})
})
async function seed(backend:'jsonl'|'sqlite') {
  vi.stubEnv('HISTORY_BACKEND',backend)
  const history=createConversationHistory()
  for(let index=0;index<8;index++)await history.append({id:'original-'+index,role:index%2?'assistant':'user',content:'Synthetic requirement '+index,metadata:{sameSize:'a'}},ctx)
  await history.append({id:'call',role:'assistant',content:'Synthetic diagnostic',toolCall:{id:'tool-1',name:'read_file',args:{path:'synthetic.txt'}}},ctx)
  await history.append({id:'result',role:'tool',content:'Synthetic output '.repeat(100),toolCallId:'tool-1',toolName:'read_file'},ctx)
  return history
}
async function pause(history:ReturnType<typeof createConversationHistory>,context:typeof ctx & {signal?:AbortSignal}=ctx) {
  const started=deferred<void>(),gate=deferred<string>()
  releases.add(()=>gate.resolve('Synthetic local summary'))
  const operation=history.compress(context,async()=>{started.resolve();return gate.promise},2)
  pending.add(operation);void operation.catch(()=>{})
  await started.promise
  return {operation,finish:()=>gate.resolve('Synthetic local summary')}
}

describe.each(['jsonl','sqlite'] as const)('%s two-phase compression',backend=>{
  it('zero retention microcompacts every tool result and keeps original archive evidence',async()=>{
    const history=await seed(backend)
    expect((await history.microCompactToolResults(ctx,{keepRecent:0})).cleared).toBe(1)
    expect((await history.getFullHistory(ctx)).find(row=>row.id==='result')?.content).toBe('[tool result cleared]')
    expect((await history.getArchive?.(ctx))?.messages.find(row=>row.id==='result')?.content).toBe('Synthetic output '.repeat(100))
  })
  it('clear options allow immediate legitimate reuse when tombstone is explicitly disabled',async()=>{
    const history=await seed(backend)
    await history.clear(ctx,{tombstone:false})
    await history.append({id:'new-turn',role:'user',content:'New synthetic requirement'},ctx)
    expect((await history.getFullHistory(ctx)).map(row=>row.id)).toEqual(['new-turn'])
  })
  it('other session append/read succeeds while the summary is pending',async()=>{
    const history=await seed(backend),paused=await pause(history)
    const other={tenantId,sessionId:'code-a'}
    await promptly(history.append({id:'independent',role:'user',content:'Independent synthetic requirement'},other))
    expect((await promptly(history.getFullHistory(other))).map(row=>row.id)).toEqual(['independent'])
    paused.finish();await paused.operation
  })
  it('orders same-session admission while other sessions can start and queued admission can abort',async()=>{
    const history=await seed(backend),first=await pause(history),second=await pause(history),controller=new AbortController()
    expect(isSessionHistoryCompressing(tenantId,sessionId)).toBe(true)
    let admitted=false
    const next=rootRunStore.create(tenantId,sessionId,'synthetic-model',[],{},undefined,controller.signal).then(run=>{admitted=true;return run})
    pending.add(next);void next.catch(()=>{})
    await promptly(rootRunStore.create(tenantId,'independent','synthetic-model',[],{}))
    expect(admitted).toBe(false)
    first.finish();await first.operation
    expect(isSessionHistoryCompressing(tenantId,sessionId)).toBe(true)
    controller.abort(new Error('Synthetic queued admission cancellation'))
    await expect(promptly(next)).rejects.toThrow('Synthetic queued admission cancellation')
    expect(await rootRunStore.list(tenantId,sessionId)).toEqual([])
    second.finish();await expect(second.operation).rejects.toMatchObject({code:'HISTORY_COMPRESSION_CONFLICT'})
    await promptly(waitForSessionHistoryCompression(tenantId,sessionId))
    expect(isSessionHistoryCompressing(tenantId,sessionId)).toBe(false)
    expect((await promptly(rootRunStore.create(tenantId,sessionId,'synthetic-model',[],{}))).status).toBe('running')
  })
  it.each(['append','edit','clear','truncate','microcompact','same-size-metadata'] as const)('refuses stale summary after same-session %s',async mutation=>{
    const history=await seed(backend),paused=await pause(history)
    if(mutation==='append')await promptly(history.append({id:'later',role:'user',content:'Later requirement'},ctx))
    else if(mutation==='edit')await promptly(history.updateMessageContent('original-0',tenantId,'Changed requirement',5))
    else if(mutation==='clear')await promptly(history.clear(ctx))
    else if(mutation==='truncate')await promptly(history.deleteMessagesAfterId(1,sessionId,tenantId))
    else if(mutation==='microcompact')await promptly(history.microCompactToolResults(ctx,{keepRecent:1,maxChars:1}))
    else if(backend==='sqlite')await db.execute({sql:'UPDATE conversations SET metadata=? WHERE tenant_id=? AND session_id=? AND message_id=?',args:['{"sameSize":"b"}',tenantId,sessionId,'original-0']})
    else await promptly(history.updateMessageContent('original-0',tenantId,'Synthetic requirement 0',5,{sameSize:'b'}))
    const mutated=await history.getFullHistory(ctx)
    paused.finish();await expect(paused.operation).rejects.toMatchObject({code:'HISTORY_COMPRESSION_CONFLICT'})
    expect(await history.getFullHistory(ctx)).toEqual(mutated)
    expect(mutated.some(row=>row.metadata?.isCompactSummary)).toBe(false)
  })
  it('competing summary commits once and rejects the other prepared prefix',async()=>{
    const history=await seed(backend),first=await pause(history),second=await pause(history)
    first.finish();await first.operation
    const committed=await history.getFullHistory(ctx)
    second.finish();await expect(second.operation).rejects.toMatchObject({code:'HISTORY_COMPRESSION_CONFLICT'})
    expect(await history.getFullHistory(ctx)).toEqual(committed)
  })
  it('rejects an ignored-signal summary immediately and refuses late writes after new admission',async()=>{
    const history=await seed(backend),controller=new AbortController(),before=await history.getFullHistory(ctx)
    const paused=await pause(history,{...ctx,signal:controller.signal})
    controller.abort(new Error('Synthetic cancellation'))
    await expect(promptly(paused.operation)).rejects.toThrow('Synthetic cancellation')
    expect(isSessionHistoryCompressing(tenantId,sessionId)).toBe(false)
    await promptly(rootRunStore.create(tenantId,sessionId,'synthetic-model',[],{}))
    expect(await history.getFullHistory(ctx)).toEqual(before)
    paused.finish();await new Promise<void>(resolve=>setImmediate(resolve))
    expect(await history.getFullHistory(ctx)).toEqual(before)
  })
  it('clear cancels an ignored-signal summary and permits a new turn without a late summary',async()=>{
    const history=await seed(backend),paused=await pause(history)
    await promptly(withSessionHistoryMutation(tenantId,sessionId,()=>history.clear(ctx,{tombstone:false})))
    await expect(promptly(paused.operation)).rejects.toMatchObject({code:'HISTORY_COMPRESSION_CONFLICT'})
    expect(isSessionHistoryCompressing(tenantId,sessionId)).toBe(false)
    await promptly(rootRunStore.create(tenantId,sessionId,'synthetic-model',[],{}))
    await history.append({id:'new-turn',role:'user',content:'New synthetic requirement'},ctx)
    paused.finish();await new Promise<void>(resolve=>setImmediate(resolve))
    expect((await history.getFullHistory(ctx)).map(row=>row.id)).toEqual(['new-turn'])
  })
  it('mutation barrier rejects summary even before destructive work modifies the file',async()=>{
    const history=await seed(backend),paused=await pause(history),started=deferred<void>(),gate=deferred<void>()
    releases.add(()=>gate.resolve())
    const mutation=withSessionHistoryMutation(tenantId,sessionId,async()=>{started.resolve();await gate.promise})
    pending.add(mutation);await started.promise;paused.finish()
    await expect(paused.operation).rejects.toMatchObject({code:'HISTORY_COMPRESSION_CONFLICT'})
    gate.resolve();await mutation
  })
  it('summary rejection and empty history never persist a summary',async()=>{
    const history=await seed(backend),before=await history.getFullHistory(ctx)
    await expect(history.compress(ctx,async()=>{throw new Error('Synthetic summarizer rejection')},2)).rejects.toThrow('Synthetic summarizer rejection')
    expect(isSessionHistoryCompressing(tenantId,sessionId)).toBe(false)
    expect(await history.getFullHistory(ctx)).toEqual(before)
    const summarize=vi.fn(async()=> 'Never used')
    expect(await history.compress({tenantId,sessionId:'empty'},summarize,2)).toEqual({preTokens:0,postTokens:0})
    expect(summarize).not.toHaveBeenCalled()
    expect(isSessionHistoryCompressing(tenantId,'empty')).toBe(false)
  })
})

it('JSONL abort arriving during mkdir prevents the summary append and consumes no sequence',async()=>{
  const history=await seed('jsonl'),before=await history.getFullHistory(ctx),controller=new AbortController()
  const paused=await pause(history,{...ctx,signal:controller.signal})
  const mkdir=fs.promises.mkdir.bind(fs.promises)
  vi.spyOn(fs.promises,'mkdir').mockImplementation(async(...args:Parameters<typeof fs.promises.mkdir>)=>{
    const result=await mkdir(...args);controller.abort(new Error('Abort before append'));return result
  })
  paused.finish();await expect(paused.operation).rejects.toThrow('Abort before append')
  vi.restoreAllMocks();expect(await history.getFullHistory(ctx)).toEqual(before)
  const transcript=path.join(path.dirname(process.env.DATA_DIR!), 'sessions',tenantId,sessionId+'.jsonl')
  expect(fs.readFileSync(transcript,'utf8').split('\n').filter(Boolean).map(line=>JSON.parse(line)).filter(row=>row.type==='summary')).toEqual([])
  const lastSeq=(before.at(-1) as {dbId?:number})?.dbId
  await history.append({id:'after-cancel',role:'user',content:'Next requirement'},ctx)
  expect((await history.getMessageById('after-cancel',tenantId))?.dbId).toBe(lastSeq!+1)
})

it('JSONL clear completes via logical tombstone when Windows refuses rename',async()=>{
  const history=await seed('jsonl')
  vi.spyOn(fs.promises,'rename').mockRejectedValue(Object.assign(new Error('Synthetic Windows busy file'),{code:'EBUSY'}))
  await promptly(history.clear(ctx));expect(await history.getFullHistory(ctx)).toEqual([])
  expect(await new JSONLConversationHistory().getFullHistory(ctx)).toEqual([])
})

it('SQLite CAS catches agent ownership changes and rolls back without deleting rows',async()=>{
  const history=await seed('sqlite'),paused=await pause(history)
  await db.execute({sql:'INSERT INTO agents(id,tenant_id,name,system_prompt,created_at,updated_at) VALUES(?,?,?,?,?,?)',args:['synthetic-agent',tenantId,'Synthetic agent','Synthetic instruction',1,1]})
  await db.execute({sql:'UPDATE conversations SET agent_id=? WHERE tenant_id=? AND session_id=? AND message_id=?',args:['synthetic-agent',tenantId,sessionId,'call']})
  const before=await db.execute({sql:'SELECT * FROM conversations WHERE tenant_id=? AND session_id=? ORDER BY id',args:[tenantId,sessionId]})
  paused.finish();await expect(paused.operation).rejects.toMatchObject({code:'HISTORY_COMPRESSION_CONFLICT'})
  expect((await db.execute({sql:'SELECT * FROM conversations WHERE tenant_id=? AND session_id=? ORDER BY id',args:[tenantId,sessionId]})).rows).toEqual(before.rows)
  await history.compress(ctx,async()=> 'Fresh synthetic summary',2)
  expect((await db.execute({sql:'SELECT agent_id FROM conversations WHERE message_id=?',args:['call']})).rows[0]?.agent_id).toBe('synthetic-agent')
})

it.each(['delete','last-insert'] as const)('native SQLite abort after %s rolls back context and usage then releases the queue',async boundary=>{
  const history=await seed('sqlite'),controller=new AbortController()
  await db.execute({sql:'UPDATE conversations SET token_usage=? WHERE tenant_id=? AND session_id=? AND message_id=?',args:['{"promptTokens":10,"completionTokens":2,"totalTokens":12}',tenantId,sessionId,'original-1']})
  const before=(await db.execute({sql:'SELECT * FROM conversations WHERE tenant_id=? AND session_id=? ORDER BY id',args:[tenantId,sessionId]})).rows
  const call=db.call.bind(db);let rebuilt=0,wroteArchive=false,abortedAfterWrite=false
  vi.spyOn(db,'call').mockImplementation(async(op,args=[],tx)=>{
    const result=await call(op,args,tx)
    const statement=args[0],sql=typeof statement==='string'?statement:statement&&typeof statement==='object'&&'sql' in statement?String(statement.sql):''
    if(op==='execute'&&tx){
      if(sql.startsWith('INSERT INTO conversation_usage_archive'))wroteArchive=true
      if(sql.startsWith('INSERT INTO conversations'))rebuilt++
      if((boundary==='delete'&&sql.startsWith('DELETE FROM conversations'))||(boundary==='last-insert'&&rebuilt===3)){
        abortedAfterWrite=true;controller.abort(new Error('Synthetic abort after native '+boundary))
      }
    }
    return result
  })
  await expect(history.compress({...ctx,signal:controller.signal},async()=> 'Synthetic summary',2)).rejects.toThrow('Synthetic abort after native '+boundary)
  expect(wroteArchive).toBe(true);expect(abortedAfterWrite).toBe(true)
  vi.restoreAllMocks()
  expect((await promptly(db.execute({sql:'SELECT * FROM conversations WHERE tenant_id=? AND session_id=? ORDER BY id',args:[tenantId,sessionId]}))).rows).toEqual(before)
  expect((await promptly(db.execute({sql:'SELECT * FROM conversation_usage_archive WHERE tenant_id=? AND session_id=?',args:[tenantId,sessionId]}))).rows).toEqual([])
  await promptly(history.compress(ctx,async()=> 'Fresh summary after rollback',2))
  expect((await history.getFullHistory(ctx)).some(row=>row.metadata?.isCompactSummary)).toBe(true)
  expect((await history.getSessionUsage(ctx)).totalTokens).toBe(12)
})

it('native SQLite summary INSERT failure rolls back prior DELETE and archive writes',async()=>{
  const history=await seed('sqlite')
  await db.execute({sql:'UPDATE conversations SET token_usage=? WHERE tenant_id=? AND session_id=? AND message_id=?',args:['{"promptTokens":10,"completionTokens":2,"totalTokens":12}',tenantId,sessionId,'original-1']})
  const before=(await db.execute({sql:'SELECT * FROM conversations WHERE tenant_id=? AND session_id=? ORDER BY id',args:[tenantId,sessionId]})).rows
  await db.execute("CREATE TRIGGER reject_summary BEFORE INSERT ON conversations WHEN NEW.role='system' BEGIN SELECT RAISE(ABORT, 'Synthetic summary failure'); END")
  await expect(history.compress(ctx,async()=> 'Synthetic summary',2)).rejects.toThrow('Synthetic summary failure')
  expect((await promptly(db.execute({sql:'SELECT * FROM conversations WHERE tenant_id=? AND session_id=? ORDER BY id',args:[tenantId,sessionId]}))).rows).toEqual(before)
  expect((await db.execute({sql:'SELECT * FROM conversation_usage_archive WHERE tenant_id=? AND session_id=?',args:[tenantId,sessionId]})).rows).toEqual([])
  await db.execute('DROP TRIGGER reject_summary')
  await promptly(history.compress(ctx,async()=> 'Fresh summary after failure',2))
  expect((await history.getSessionUsage(ctx)).totalTokens).toBe(12)
})

it('SQLite cancellation after commit request dispatch reports the real successful commit',async()=>{
  const history=await seed('sqlite'),controller=new AbortController(),call=db.call.bind(db)
  let dispatched=false,acknowledged=false,summaryTransaction:Parameters<typeof call>[2]
  vi.spyOn(db,'call').mockImplementation(async(op,args=[],tx)=>{
    const statement=args[0],sql=typeof statement==='string'?statement:statement&&typeof statement==='object'&&'sql' in statement?String(statement.sql):''
    // Schema migrations also commit. Cancel only the transaction that actually
    // replaced this history, after its native commit request has been sent.
    if(op==='execute'&&tx&&sql.startsWith('DELETE FROM conversations'))summaryTransaction=tx
    const operation=call(op,args,tx)
    if(op==='commit'&&tx&&tx===summaryTransaction){dispatched=true;controller.abort(new Error('Synthetic abort after commit dispatch'))}
    const value=await operation
    if(op==='commit'&&tx&&tx===summaryTransaction)acknowledged=true
    return value
  })
  await expect(history.compress({...ctx,signal:controller.signal},async()=> 'Synthetic committed summary',2)).resolves.toMatchObject({preTokens:expect.any(Number),postTokens:expect.any(Number)})
  expect(dispatched).toBe(true);expect(acknowledged).toBe(true);expect(controller.signal.aborted).toBe(true)
  vi.restoreAllMocks()
  expect((await history.getFullHistory(ctx)).some(row=>row.metadata?.isCompactSummary)).toBe(true)
  expect(isSessionHistoryCompressing(tenantId,sessionId)).toBe(false)
})

it('JSONL cancellation after appendFile dispatch reports the real successful append',async()=>{
  const history=await seed('jsonl'),controller=new AbortController(),append=fs.promises.appendFile.bind(fs.promises)
  let dispatched=false,acknowledged=false
  vi.spyOn(fs.promises,'appendFile').mockImplementation(async(...args:Parameters<typeof fs.promises.appendFile>)=>{
    const operation=append(...args);dispatched=true
    controller.abort(new Error('Synthetic abort after append dispatch'))
    await operation;acknowledged=true
  })
  await expect(history.compress({...ctx,signal:controller.signal},async()=> 'Synthetic committed summary',2)).resolves.toMatchObject({preTokens:expect.any(Number),postTokens:expect.any(Number)})
  expect(dispatched).toBe(true);expect(acknowledged).toBe(true);expect(controller.signal.aborted).toBe(true)
  vi.restoreAllMocks()
  expect((await history.getFullHistory(ctx)).some(row=>row.metadata?.isCompactSummary)).toBe(true)
  expect(isSessionHistoryCompressing(tenantId,sessionId)).toBe(false)
})
