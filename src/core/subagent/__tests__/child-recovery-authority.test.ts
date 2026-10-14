/** Real isolated WAL connections verify frozen publication/usage, atomic failure and bounded SQL recovery. */
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { InStatement, Transaction } from '@libsql/client'
import { LocalSqliteProcessClient } from '../../../storage/sqlite/local-process-client.js'
import { SubagentStore } from '../store.js'
import { assertChildUsageFence, childUsageContribution, ensureParentChildUsage, readChildUsageFence, readDurableChildUsage } from '../child-usage-authority.js'
import { admitPublishedChild, advancePublicationBoundary, capturePublishedFence, ensurePublicationOwner, lookupPublishedChild, readLiveChildUsage, readPublishedPage, type PublicationScope } from '../published-store.js'
import type { CreateSubagentRun } from '../types.js'

const scope: PublicationScope = { tenantId:'synthetic-tenant', parentSessionId:'parent', rootSessionId:'root', parentTurnId:'current-turn', rootRunId:'root-run', attemptId:'attempt-1', streamId:'stream-1' }
let dir: string, a: LocalSqliteProcessClient, b: LocalSqliteProcessClient, sa: SubagentStore, sb: SubagentStore
const fixtures: {path:string;cleaned:boolean}[]=[]
function input(runId:string,turnId=scope.parentTurnId,extra:Partial<CreateSubagentRun>={}):CreateSubagentRun { return { ...scope,parentConversationId:turnId,runId,parentToolCallId:'delegate-'+runId,parentMessageId:'dispatch-'+runId,childSessionId:'child-'+runId,modelId:'synthetic-only',task:'No model invocation',description:'Scalar contract',...extra } }
async function tx<T>(db:LocalSqliteProcessClient,mode:'read'|'write',fn:(q:Transaction)=>Promise<T>):Promise<T> {
  const q=await db.transaction(mode)
  try { const result=await fn(q); if(mode==='write')await q.commit(); return result }
  catch(error){ if(mode==='write')await q.rollback(); throw error } finally {q.close()}
}
const capture = () => tx(a,'read',q=>capturePublishedFence(q,scope))
const admit = (event:number,runId:string,seq:number) => tx(a,'write',q=>admitPublishedChild(q,scope,event,runId,seq))
async function create(runId:string,turnId=scope.parentTurnId) { return (await sa.createRunDelta(input(runId,turnId))).header }
async function usage(store:SubagentStore,runId:string,tokens:number,invocationId='usage-'+tokens) {
  const mutation=await store.recordUsageDelta(scope.tenantId,runId,{invocationId,promptTokens:tokens,completionTokens:0})
  if(!mutation)throw new Error('Missing synthetic run'); return mutation.header
}
beforeEach(async()=>{
  const fixtureRoot=path.resolve(process.cwd(),'child-recovery-fixtures')
  fs.mkdirSync(fixtureRoot,{recursive:true});dir=fs.mkdtempSync(path.join(fixtureRoot,'owned-'))
  fixtures.push({path:dir,cleaned:false})
  const url='file:'+path.join(dir,'fixture.db').replaceAll('\\','/')
  a=new LocalSqliteProcessClient({url});await a.execute('PRAGMA journal_mode=WAL')
  sa=new SubagentStore(a);await sa.captureChildUsage(scope.tenantId,scope.parentSessionId)
  b=new LocalSqliteProcessClient({url});sb=new SubagentStore(b)
  await sb.captureChildUsage(scope.tenantId,scope.parentSessionId)
  await tx(a,'write',q=>ensurePublicationOwner(q,scope))
})
afterEach(async()=>{
  vi.restoreAllMocks();a.close();b.close();await Promise.all([a.whenClosed(),b.whenClosed()])
  const resolved=path.resolve(dir),root=path.resolve(process.cwd(),'child-recovery-fixtures')
  if(path.dirname(resolved)!==root||!path.basename(resolved).startsWith('owned-'))throw new Error('Unsafe fixture cleanup')
  fs.rmSync(resolved,{recursive:true,force:true,maxRetries:10,retryDelay:100});fixtures.at(-1)!.cleaned=!fs.existsSync(resolved)
  fs.writeFileSync(path.resolve(process.cwd(),'child-recovery.fixtures.json'),JSON.stringify({fixtures},null,2))
})

describe('authoritative child usage and exact published prefix P1',()=>{
  it('preserves unknown known lower bounds and matches the established usage fallback',()=>{
    expect(childUsageContribution({totalTokens:80,unknown:true},99)).toEqual({tokens:80,unknown:true,finishedAt:99})
    expect(childUsageContribution({inputTokens:3,outputTokens:7})).toEqual({tokens:10,unknown:false})
    expect(childUsageContribution({inputTokens:3})).toEqual({tokens:0,unknown:true})
    expect(childUsageContribution({totalTokens:Infinity,inputTokens:3,outputTokens:7})).toEqual({tokens:0,unknown:true})
  })
  it('increments authority only for metric changes and invocation dedup has no second effect',async()=>{
    await create('one');const unknown=await sa.captureChildUsage(scope.tenantId,scope.parentSessionId)
    expect(await sa.childUsageAt(unknown)).toMatchObject({totalTokens:0,count:1,unknown:1})
    const header=await usage(sa,'one',80,'unique')
    const once=await sa.captureChildUsage(scope.tenantId,scope.parentSessionId)
    expect(once.revision).toBe(unknown.revision+1)
    await sa.recordUsageDelta(scope.tenantId,'one',{invocationId:'unique',promptTokens:80,completionTokens:0})
    await sa.appendHeader(scope.tenantId,'one','output.updated',{partialOutput:'More text without billing'})
    expect(await sa.captureChildUsage(scope.tenantId,scope.parentSessionId)).toEqual(once)
    expect(await sa.childUsageAt(once)).toMatchObject({totalTokens:80,count:1,unknown:0})
    expect((await sa.getRunHeader(scope.tenantId,'one'))!.lastSeq).toBe(header.lastSeq+1)
  })
  it('rolls invocation, checkpoint, usage ledger and ordinary lifecycle back together on authority fault',async()=>{
    const before=await create('one'),fence=await sa.captureChildUsage(scope.tenantId,scope.parentSessionId)
    await a.execute(`CREATE TRIGGER synthetic_usage_failure BEFORE INSERT ON subagent_usage_contributions WHEN NEW.valid_from>1 BEGIN SELECT RAISE(ABORT,'synthetic-authority-fault'); END`)
    await expect(usage(sa,'one',80,'faulted-invocation')).rejects.toThrow('synthetic-authority-fault')
    expect((await sa.getRunHeader(scope.tenantId,'one'))!.lastSeq).toBe(before.lastSeq)
    expect(await sa.captureChildUsage(scope.tenantId,scope.parentSessionId)).toEqual(fence)
    expect(Number((await a.execute("SELECT count(*) AS count FROM subagent_usage_invocations WHERE invocation_id='faulted-invocation'")).rows[0].count)).toBe(0)
    await a.execute('DROP TRIGGER synthetic_usage_failure');await usage(sa,'one',80,'faulted-invocation')
    expect(await sa.childUsageAt(await sa.captureChildUsage(scope.tenantId,scope.parentSessionId))).toMatchObject({totalTokens:80,count:1})
  })
  it('freezes both later pages and scalar U/R while another real WAL connection commits future children',async()=>{
    await create('current-1');const old=await usage(sa,'current-1',80);await admit(1,'current-1',old.lastSeq)
    await create('current-2');const second=await usage(sa,'current-2',20);await admit(2,'current-2',second.lastSeq)
    await create('older','old-turn');await usage(sa,'older',40)
    const fence=await capture(),first=await tx(a,'read',q=>readPublishedPage(q,fence,{limit:1}))
    expect(first.items.map(item=>item.identity.runId)).toEqual(['current-1']);expect(first.hasMore).toBe(true)
    const next=await usage(sb,'current-1',900);await tx(b,'write',q=>admitPublishedChild(q,scope,3,'current-1',next.lastSeq))
    await usage(sb,'older',700)
    const page2=await tx(a,'read',q=>readPublishedPage(q,fence,{limit:1,after:first.after!}))
    expect(page2.items.map(item=>item.identity.runId)).toEqual(['current-2']);expect(page2.hasMore).toBe(false)
    expect(await tx(a,'read',q=>readLiveChildUsage(q,fence))).toEqual({totalTokens:140,count:3,unknown:0})
    expect((await tx(a,'read',q=>lookupPublishedChild(q,fence,'current-1')))!.atSeq).toBe(old.lastSeq)
    expect(await tx(a,'read',async q=>readLiveChildUsage(q,await capturePublishedFence(q,scope)))).toEqual({totalTokens:1740,count:3,unknown:0})
  })
  it('uses an old child checkpoint despite a higher durable child sequence that has not been published',async()=>{
    await create('one');const header=await usage(sa,'one',80);await admit(1,'one',header.lastSeq)
    await usage(sb,'one',900)
    const fence=await capture()
    expect(await tx(a,'read',q=>readLiveChildUsage(q,fence))).toEqual({totalTokens:80,count:1,unknown:0})
    expect(await sa.childUsageAt(await sa.captureChildUsage(scope.tenantId,scope.parentSessionId))).toMatchObject({totalTokens:980})
  })
  it('counts separate runs of the same reusable child and accepts late terminal usage without revival',async()=>{
    await sa.createRunDelta(input('one',scope.parentTurnId,{childSessionId:'reusable',continuation:{readOnly:true,systemPrompt:'Synthetic fixture only',toolNames:[],workspacePaths:[]}}))
    await usage(sa,'one',80);await sa.appendHeader(scope.tenantId,'one','finished',{status:'succeeded',finishedAt:777})
    await sa.createRunDelta(input('two',scope.parentTurnId,{resumeFromRunId:'one'}))
    await usage(sa,'one',20);await usage(sa,'two',40)
    expect((await sa.getRunHeader(scope.tenantId,'one'))!.status).toBe('succeeded')
    expect(await sa.childUsageAt(await sa.captureChildUsage(scope.tenantId,scope.parentSessionId))).toEqual({totalTokens:140,count:2,unknown:0,finishedAt:777})
  })
  it('computes finishedAt as MAX across exactly the two admitted populations, never by subtraction',async()=>{
    await create('one');await usage(sa,'one',10);const own=(await sa.appendHeader(scope.tenantId,'one','finished',{status:'succeeded',finishedAt:100}))!.header;await admit(1,'one',own.lastSeq)
    await create('older','old-turn');await usage(sa,'older',20);await sa.appendHeader(scope.tenantId,'older','finished',{status:'succeeded',finishedAt:300})
    await create('future');await usage(sa,'future',999);await sa.appendHeader(scope.tenantId,'future','finished',{status:'succeeded',finishedAt:900})
    expect(await tx(a,'read',async q=>readLiveChildUsage(q,await capturePublishedFence(q,scope)))).toEqual({totalTokens:30,count:2,unknown:0,finishedAt:300})
  })
  it('accepts idempotent admission but rejects old sequence, duplicate event conflict and foreign scopes',async()=>{
    const one=await create('one');expect(await admit(1,'one',one.lastSeq)).toBe(1);expect(await admit(1,'one',one.lastSeq)).toBe(1)
    expect(await admit(2,'one',one.lastSeq)).toBe(1)
    const next=await usage(sa,'one',10);await admit(3,'one',next.lastSeq)
    await expect(admit(4,'one',one.lastSeq)).rejects.toMatchObject({statusCode:409,reason:'child_sequence_regression'})
    await create('same-scope-other');await expect(admit(3,'same-scope-other',1)).rejects.toMatchObject({reason:'event_conflict'})
    await create('other','old-turn');await expect(admit(3,'other',1)).rejects.toMatchObject({reason:'foreign_checkpoint'})
    await expect(tx(a,'write',q=>ensurePublicationOwner(q,{...scope,attemptId:'different'}))).rejects.toMatchObject({reason:'scope_mismatch'})
    await expect(tx(a,'write',q=>admitPublishedChild(q,{...scope,tenantId:'foreign'},4,'one',1))).rejects.toMatchObject({reason:'missing_publication_owner'})
  })
  it('preserves publication E/R and evidence after a failed admission transaction',async()=>{
    const one=await create('one');await admit(1,'one',one.lastSeq);const before=await capture();const next=await usage(sa,'one',80)
    await a.execute(`CREATE TRIGGER synthetic_mark_failure BEFORE INSERT ON parent_publication_marks WHEN NEW.event_sequence=2 BEGIN SELECT RAISE(ABORT,'synthetic-publication-fault'); END`)
    await expect(admit(2,'one',next.lastSeq)).rejects.toThrow('synthetic-publication-fault')
    expect(await capture()).toMatchObject({eventSequence:before.eventSequence,revision:before.revision})
    expect(await tx(a,'read',q=>readLiveChildUsage(q,before))).toEqual({totalTokens:0,count:1,unknown:1})
    expect(Number((await a.execute('SELECT count(*) AS count FROM parent_published_child_versions')).rows[0].count)).toBe(1)
  })
  it('records a nonchild snapshot boundary without advancing R and rejects forged prefix pairs',async()=>{
    const one=await create('one');await admit(1,'one',one.lastSeq)
    await tx(a,'write',q=>advancePublicationBoundary(q,scope,20));const fence=await capture()
    expect(fence).toMatchObject({eventSequence:20,revision:1})
    await expect(tx(a,'read',q=>readPublishedPage(q,{...fence,revision:0}))).rejects.toMatchObject({reason:'prefix_mismatch'})
    await expect(tx(a,'read',q=>capturePublishedFence(q,scope,21))).rejects.toMatchObject({reason:'retention_gap'})
  })
  it('never substitutes latest or returns empty complete when an exact admitted checkpoint disappears',async()=>{
    await create('one');const old=await usage(sa,'one',80);await admit(1,'one',old.lastSeq);const fence=await capture();await usage(sa,'one',900)
    await b.execute({sql:'DELETE FROM subagent_checkpoints WHERE tenant_id=? AND run_id=? AND seq=?',args:[scope.tenantId,'one',old.lastSeq]})
    await expect(tx(a,'read',q=>readPublishedPage(q,fence))).rejects.toMatchObject({statusCode:409,reason:'missing_checkpoint'})
    await expect(tx(a,'read',q=>readLiveChildUsage(q,fence))).rejects.toMatchObject({reason:'missing_checkpoint'})
    await expect(admit(2,'one',old.lastSeq)).rejects.toMatchObject({reason:'missing_checkpoint'})
  })
  it('invalidates old usage and publication fences on a single run clear while survivors retain exact totals',async()=>{
    const one=await create('one');await usage(sa,'one',80);await admit(1,'one',one.lastSeq);await create('two');await usage(sa,'two',20)
    const old=await sa.captureChildUsage(scope.tenantId,scope.parentSessionId),published=await capture()
    await sa.deleteRuns(scope.tenantId,['one'])
    await expect(sa.childUsageAt(old)).rejects.toMatchObject({reason:'generation_changed'})
    await expect(tx(a,'read',q=>readPublishedPage(q,published))).rejects.toMatchObject({reason:'missing_publication_owner'})
    expect(await sa.childUsageAt(await sa.captureChildUsage(scope.tenantId,scope.parentSessionId))).toEqual({totalTokens:20,count:1,unknown:0})
    await sa.deleteRunsForParent(scope.tenantId,scope.parentSessionId)
    expect(await sa.childUsageAt(await sa.captureChildUsage(scope.tenantId,scope.parentSessionId))).toEqual({totalTokens:0,count:0,unknown:0})
  })
  it('fails retained U/R and incomplete bootstrap explicitly',async()=>{
    const one=await create('one');await admit(1,'one',one.lastSeq);const fence=await capture();await usage(sa,'one',80)
    await a.execute('UPDATE subagent_usage_parent_state SET floor_revision=revision')
    await expect(tx(a,'read',q=>readLiveChildUsage(q,fence))).rejects.toMatchObject({reason:'retention_gap'})
    await a.execute('UPDATE subagent_usage_parent_state SET bootstrap_complete=0')
    await expect(sa.captureChildUsage(scope.tenantId,scope.parentSessionId)).rejects.toMatchObject({reason:'bootstrap_incomplete'})
    await expect(tx(a,'write',q=>ensureParentChildUsage(q,scope.tenantId,scope.parentSessionId))).rejects.toMatchObject({reason:'bootstrap_incomplete'})
  })
  it('keeps mature scalar observations on read transactions while another connection holds a writer',async()=>{
    await create('one');await usage(sa,'one',80);const fence=await sa.captureChildUsage(scope.tenantId,scope.parentSessionId)
    const held=await b.transaction('write');await held.execute("INSERT INTO subagent_usage_invocations VALUES ('held','held','held')")
    try {
      const writer=vi.spyOn(a,'transaction')
      expect(await sa.captureChildUsage(scope.tenantId,scope.parentSessionId)).toEqual(fence)
      expect(await sa.childUsageAt(fence)).toMatchObject({totalTokens:80})
      expect(writer.mock.calls.map(call=>call[0])).toEqual(['read','read'])
    }finally{await held.rollback();held.close()}
  })
  it('returns valid whole envelopes within byte and item limits without skipping a too-large first identity',async()=>{
    const one=await sa.createRunDelta(input('one',scope.parentTurnId,{agentName:'界😀'.repeat(100)}));await admit(1,'one',one.header.lastSeq)
    const two=await sa.createRunDelta(input('two',scope.parentTurnId,{agentName:'界😀'.repeat(100)}));await admit(2,'two',two.header.lastSeq)
    const fence=await capture(),first=await tx(a,'read',q=>readPublishedPage(q,fence,{limit:2,responseBytes:2300}))
    expect(first.items).toHaveLength(1);expect(first.hasMore).toBe(true);expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThanOrEqual(2300)
    const second=await tx(a,'read',q=>readPublishedPage(q,fence,{limit:2,responseBytes:2300,after:first.after!}));expect(second.items.map(item=>item.identity.runId)).toEqual(['two'])
    await expect(tx(a,'read',q=>readPublishedPage(q,fence,{responseBytes:1024}))).rejects.toMatchObject({reason:'oversized_identity'})
    for(const limit of [0,201,1.5,NaN])await expect(tx(a,'read',q=>readPublishedPage(q,fence,{limit}))).rejects.toThrow('Invalid published page budget')
  })
  it('handles legacy exact archives without transporting tools during bootstrap or admission',async()=>{
    const created=await sa.createRun(input('legacy','older-turn'))
    const ended=await sa.appendSnapshot(scope.tenantId,'legacy','finished',{status:'succeeded',finishedAt:123,usage:{totalTokens:42,unknown:true}})
    expect(ended).not.toBeNull()
    await a.execute('DELETE FROM subagent_usage_parent_state');await a.execute('DELETE FROM subagent_usage_contributions')
    const seen:string[]=[];const execute=a.transaction.bind(a)
    vi.spyOn(a,'transaction').mockImplementation(async mode=>{const q=await execute(mode),run=q.execute.bind(q);vi.spyOn(q,'execute').mockImplementation(async(s:InStatement)=>{seen.push(typeof s==='string'?s:s.sql);return run(s)});return q})
    const fence=await sa.captureChildUsage(scope.tenantId,scope.parentSessionId)
    expect(await sa.childUsageAt(fence)).toEqual({totalTokens:42,count:1,unknown:1,finishedAt:123})
    const legacyScope={...scope,parentTurnId:'older-turn',streamId:'legacy-stream'}
    await tx(a,'write',async q=>{await ensurePublicationOwner(q,legacyScope);await admitPublishedChild(q,legacyScope,1,'legacy',ended!.seq)})
    expect(created.snapshot.toolCalls).toEqual([])
    expect(seen.some(sql=>/SELECT\s+(snapshot|event)\b/i.test(sql))).toBe(false)
  })
  it('aggregates 10k runs as SQL scalars, with fixed bounded page rows and independent full oracle',async()=>{
    await tx(a,'write',async q=>{
      await q.execute(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<10000) INSERT INTO subagent_usage_contributions(tenant_id,parent_session_id,run_id,parent_turn_id,root_session_id,valid_from,tokens,unknown,finished_at) SELECT 'synthetic-tenant','parent','bulk-'||printf('%05d',i),CASE WHEN i%2=0 THEN 'old-turn' ELSE 'current-turn' END,'root',0,i%97,CASE WHEN i%13=0 THEN 1 ELSE 0 END,CASE WHEN i%11=0 THEN i ELSE NULL END FROM n`)
    })
    const fence=await sa.captureChildUsage(scope.tenantId,scope.parentSessionId)
    let tokens=0,unknown=0,finished=0;for(let i=1;i<=10000;i++){tokens+=i%97;if(i%13===0)unknown++;if(i%11===0)finished=i}
    const scalar=await sa.childUsageAt(fence);expect(scalar).toEqual({totalTokens:tokens,count:10000,unknown,finishedAt:finished});expect(Buffer.byteLength(JSON.stringify(scalar))).toBeLessThan(128)
    const q=await a.transaction('read');try{
      const run=q.execute.bind(q),rows:number[]=[],sql:string[]=[]
      vi.spyOn(q,'execute').mockImplementation(async statement=>{const result=await run(statement);sql.push(typeof statement==='string'?statement:statement.sql);rows.push(result.rows.length);return result})
      await readDurableChildUsage(q,fence);expect(Math.max(...rows)).toBe(1);expect(sql.some(text=>text.includes('sum(tokens)'))).toBe(true)
      const plan=await run({sql:'EXPLAIN QUERY PLAN SELECT sum(tokens) FROM subagent_usage_contributions WHERE tenant_id=? AND parent_session_id=? AND valid_from<=? AND (valid_to IS NULL OR valid_to>?)',args:[scope.tenantId,scope.parentSessionId,0,0]})
      expect(plan.rows.some(row=>String(row.detail).includes('idx_child_usage_fence'))).toBe(true)
    }finally{q.close()}
  },30000)
  it('pages a 10k published prefix by SQL keysets with at most limit plus one rows in JS',async()=>{
    await tx(a,'write',async q=>{
      await q.execute(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<10000) INSERT INTO subagent_runs SELECT 'synthetic-tenant','published-'||printf('%05d',i),'parent','delegate-'||i,'child-'||i,'succeeded',1,i,i,'{"schemaVersion":2}' FROM n`)
      await q.execute(`INSERT INTO subagent_records SELECT tenant_id,run_id,json_object('tenantId',tenant_id,'runId',run_id,'rootSessionId','root','parentSessionId','parent','parentConversationId','current-turn','parentMessageId','dispatch-'||run_id,'parentToolCallId',parent_tool_call_id,'childSessionId',child_session_id,'modelId','synthetic-only','createdAt',created_at) FROM subagent_runs`)
      await q.execute(`INSERT INTO subagent_checkpoints SELECT tenant_id,run_id,1,json_object('status','succeeded','lastSeq',1,'usage',json_object('totalTokens',created_at%97),'finishedAt',created_at,'toolCount',0,'activeToolCount',0) FROM subagent_runs`)
      await q.execute(`INSERT INTO parent_published_child_versions SELECT r.tenant_id,r.parent_session_id,'stream-1',r.run_id,r.created_at,r.created_at,NULL,1,m.record,r.created_at%97,0,r.created_at FROM subagent_runs r JOIN subagent_records m ON m.tenant_id=r.tenant_id AND m.run_id=r.run_id`)
      await q.execute(`INSERT INTO parent_publication_marks SELECT tenant_id,parent_session_id,'stream-1',created_at,created_at,run_id,1 FROM subagent_runs`)
      await q.execute('UPDATE parent_publication_state SET revision=10000,event_sequence=10000')
    })
    const fence=await capture();let after: {firstOrdinal:number;runId:string}|undefined,maxRows=0,maxBytes=0,count=0,pages=0
    const full=vi.spyOn(sa,'listRunsForParent'),views=vi.spyOn(sa,'listRunViewsForParent')
    for(;;){
      const page=await tx(a,'read',async q=>{
        const execute=q.execute.bind(q)
        vi.spyOn(q,'execute').mockImplementation(async s=>{const result=await execute(s);maxRows=Math.max(maxRows,result.rows.length);return result})
        return readPublishedPage(q,fence,{limit:200,after})
      })
      pages++;maxBytes=Math.max(maxBytes,Buffer.byteLength(JSON.stringify(page)))
      for(const item of page.items){count++;expect(item.identity.runId).toBe('published-'+String(count).padStart(5,'0'));expect(item.atSeq).toBe(1)}
      expect(page.totalPublishedCount).toBe(10000);expect(page.includedCount).toBe(200)
      if(!page.hasMore)break;after=page.after!
    }
    let expected=0;for(let i=1;i<=10000;i++)expected+=i%97
    expect(count).toBe(10000);expect(pages).toBe(50);expect(maxRows).toBe(201);expect(maxBytes).toBeLessThanOrEqual(256*1024)
    expect(full).not.toHaveBeenCalled();expect(views).not.toHaveBeenCalled()
    expect(await tx(a,'read',q=>readLiveChildUsage(q,fence))).toEqual({totalTokens:expected,count:10000,unknown:0,finishedAt:10000})
    fs.writeFileSync(path.resolve(process.cwd(),'child-recovery.metrics.json'),JSON.stringify({publishedCount:count,pages,limit:200,maxRows,maxBytes,fullHelperCalls:0},null,2))
  },30000)
  it('reopens a fresh database process and recovers the exact old fences after later commits',async()=>{
    await create('one');const old=await usage(sa,'one',80);await admit(1,'one',old.lastSeq)
    const published=await capture(),durable=await sa.captureChildUsage(scope.tenantId,scope.parentSessionId)
    const next=await usage(sb,'one',900);await tx(b,'write',q=>admitPublishedChild(q,scope,2,'one',next.lastSeq))
    a.close();await a.whenClosed();a=new LocalSqliteProcessClient({url:'file:'+path.join(dir,'fixture.db').replaceAll('\\','/')});sa=new SubagentStore(a)
    expect(await sa.childUsageAt(durable)).toEqual({totalTokens:80,count:1,unknown:0})
    expect(await tx(a,'read',q=>readLiveChildUsage(q,published))).toEqual({totalTokens:80,count:1,unknown:0})
    expect((await tx(a,'read',q=>lookupPublishedChild(q,published,'one')))!.atSeq).toBe(old.lastSeq)
  })
  it('supports a real isolated in-memory libsql process and joins its shutdown',async()=>{
    const memory=new LocalSqliteProcessClient({url:'file::memory:'})
    try{
      const store=new SubagentStore(memory);await store.createRunDelta(input('in-memory'));await usage(store,'in-memory',80)
      const fence=await store.captureChildUsage(scope.tenantId,scope.parentSessionId)
      expect(await store.childUsageAt(fence)).toEqual({totalTokens:80,count:1,unknown:0})
    }finally{memory.close();await memory.whenClosed()}
    expect(memory.closed).toBe(true)
  })
  it('rejects same-sequence contradictions and changed child identity before advancing E/R',async()=>{
    const one=await create('one');await admit(1,'one',one.lastSeq)
    await a.execute({sql:"UPDATE subagent_checkpoints SET header=json_set(header,'$.usage.totalTokens',80) WHERE tenant_id=? AND run_id=? AND seq=1",args:[scope.tenantId,'one']})
    await expect(admit(2,'one',1)).rejects.toMatchObject({reason:'checkpoint_conflict'})
    expect(await capture()).toMatchObject({eventSequence:1,revision:1})
    await a.execute({sql:"UPDATE subagent_checkpoints SET header=json_remove(header,'$.usage.totalTokens') WHERE tenant_id=? AND run_id=? AND seq=1",args:[scope.tenantId,'one']})
    const next=await usage(sa,'one',10)
    await a.execute({sql:"UPDATE subagent_records SET record=json_set(record,'$.childSessionId','foreign-child') WHERE tenant_id=? AND run_id=?",args:[scope.tenantId,'one']})
    await expect(admit(2,'one',next.lastSeq)).rejects.toMatchObject({reason:'identity_changed'})
    expect(await capture()).toMatchObject({eventSequence:1,revision:1})
  })
  it('deduplicates one model invocation across two simultaneous WAL writers without double billing',async()=>{
    await create('one');const before=await sa.captureChildUsage(scope.tenantId,scope.parentSessionId)
    const results=await Promise.all([sa.recordUsageDelta(scope.tenantId,'one',{invocationId:'shared-invocation',promptTokens:80,completionTokens:0}),sb.recordUsageDelta(scope.tenantId,'one',{invocationId:'shared-invocation',promptTokens:80,completionTokens:0})])
    expect(results.filter(result=>result!==null)).toHaveLength(1)
    const fence=await sa.captureChildUsage(scope.tenantId,scope.parentSessionId)
    expect(fence.revision).toBe(before.revision+1);expect(await sa.childUsageAt(fence)).toEqual({totalTokens:80,count:1,unknown:0})
    expect(Number((await a.execute("SELECT count(*) AS count FROM subagent_usage_invocations WHERE invocation_id='shared-invocation'")).rows[0].count)).toBe(1)
  })
  it('does not treat a modern checkpoint without its immutable identity record as retained evidence',async()=>{
    const one=await create('one');await admit(1,'one',one.lastSeq);const fence=await capture()
    await a.execute("DELETE FROM subagent_records WHERE run_id='one'")
    await expect(tx(a,'read',q=>readPublishedPage(q,fence))).rejects.toMatchObject({reason:'missing_checkpoint'})
  })
  it('refuses a missing modern bootstrap checkpoint rather than inventing complete zero usage',async()=>{
    await create('one');await usage(sa,'one',80)
    await a.execute('DELETE FROM subagent_usage_contributions');await a.execute('DELETE FROM subagent_usage_parent_state');await a.execute("DELETE FROM subagent_checkpoints WHERE run_id='one'")
    await expect(sa.captureChildUsage(scope.tenantId,scope.parentSessionId)).rejects.toMatchObject({reason:'missing_checkpoint'})
    expect(Number((await a.execute('SELECT count(*) AS count FROM subagent_usage_parent_state')).rows[0].count)).toBe(0)
  })
  it('rejects retained old publication marks even when a retry would otherwise be idempotent',async()=>{
    const one=await create('one');await admit(1,'one',one.lastSeq);const next=await usage(sa,'one',80);await admit(2,'one',next.lastSeq)
    await a.execute('UPDATE parent_publication_state SET floor_revision=2,floor_event_sequence=2')
    await expect(admit(1,'one',one.lastSeq)).rejects.toMatchObject({reason:'retention_gap'})
  })
  it('keeps tool and output progress off the billing ledger while preserving the exact authority',async()=>{
    await create('one');await usage(sa,'one',80);const fence=await sa.captureChildUsage(scope.tenantId,scope.parentSessionId)
    const sql:string[]=[],open=a.transaction.bind(a)
    vi.spyOn(a,'transaction').mockImplementation(async mode=>{const q=await open(mode),execute=q.execute.bind(q);vi.spyOn(q,'execute').mockImplementation(async statement=>{sql.push(typeof statement==='string'?statement:statement.sql);return execute(statement)});return q})
    await sa.upsertTool(scope.tenantId,'one','tool.started',{id:'read-1',name:'read_file',status:'running',args:{path:'synthetic.txt'}})
    await sa.upsertTool(scope.tenantId,'one','tool.completed',{id:'read-1',name:'read_file',status:'succeeded',output:'Synthetic output'})
    await sa.appendHeader(scope.tenantId,'one','output.updated',{partialOutput:'More synthetic output'})
    expect(sql.filter(statement=>statement.includes('subagent_usage_parent_state')||statement.includes('subagent_usage_contributions'))).toEqual([])
    expect(await sa.captureChildUsage(scope.tenantId,scope.parentSessionId)).toEqual(fence)
  })
})
