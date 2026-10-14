/** Real SQLite, builtin registry, ReAct receipts and resumed child plans; only provider responses are scripted. */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { pino } from 'pino'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentContext, Message } from '../../../core/agent-context/types.js'
import type { LLMAdapter } from '../../../core/llm-adapter/types.js'
import { ReActStrategy } from '../../../core/agent-loop/react.js'
import { SubagentRunner } from '../../../core/subagent/runner.js'
import { SubagentPool } from '../../../core/subagent/pool.js'
import { SubagentStore } from '../../../core/subagent/store.js'
import type { CreateSubagentRun } from '../../../core/subagent/types.js'
import { ToolRegistry } from '../../../core/tool-registry/index.js'
import { SQLiteConversationHistory } from '../../conversation/history.js'
import { closeDb, getDb, initDb } from '../../sqlite/db.js'
import type { LocalSqliteProcessClient } from '../../sqlite/local-process-client.js'
import { TodoStore, TaskPlanIdentityError, type TaskPlan } from '../index.js'
import { planTool, todoTools, PLAN_UPDATE_RECOVERY_PROMPT } from '../../../tools/todo/todo-tool.js'
import { getToolOutputLimit } from '../../../core/agent-loop/tool-output-limit.js'

const tenantId='plan-recovery-tenant'
const store=new TodoStore()
const clients:LocalSqliteProcessClient[]=[]
let fixtureDir:string
function context(sessionId:string):AgentContext {
  const tools=new ToolRegistry();tools.register(planTool)
  return {tenantId,sessionId,workspaceDir:fixtureDir,tools,history:new SQLiteConversationHistory(),logger:pino({level:'silent'}),
    rootRunId:randomUUID(),turnId:randomUUID(),userMessageId:randomUUID(),assistantMessageId:randomUUID(),tokenBudget:100_000,toolProfile:'code'}
}
async function seed(sessionId:string,step='核对真实结果'):Promise<TaskPlan> {
  return store.updatePlan(tenantId,sessionId,{plan:[{step,status:'in_progress'}]})
}
beforeAll(async()=>{
  fixtureDir=fs.mkdtempSync(path.join(os.tmpdir(),'aether-plan-recovery-'))
  vi.stubEnv('DATA_DIR',path.join(fixtureDir,'agent.db'));closeDb()
  clients.push(getDb() as LocalSqliteProcessClient);await initDb()
})
beforeEach(async()=>{
  vi.stubEnv('OSM_MODE','balanced');vi.stubEnv('TOOL_OUTPUT_MAX_CHARS',undefined);vi.stubEnv('CODE_TOOL_OUTPUT_MAX_CHARS',undefined)
  await getDb().execute('DROP TRIGGER IF EXISTS reject_recovery_plan_insert')
  await getDb().execute('DELETE FROM task_plan_items');await getDb().execute('DELETE FROM task_plans');await getDb().execute('DELETE FROM todos')
})
afterAll(async()=>{
  vi.restoreAllMocks();closeDb();for(const client of clients)client.close()
  await Promise.all(clients.map(client=>client.whenClosed()));vi.unstubAllEnvs()
  const target=path.resolve(fixtureDir)
  if(path.dirname(target)!==path.resolve(os.tmpdir())||!path.basename(target).startsWith('aether-plan-recovery-'))throw new Error('Unsafe recovery fixture cleanup')
  fs.rmSync(target,{recursive:true,force:true,maxRetries:10,retryDelay:100})
})

describe('plan identity failure recovery',()=>{
  it.each(['guessed','foreign-session','foreign-tenant'] as const)('rejects %s ID with only the scoped saved snapshot and no side effects',async kind=>{
    const own=await seed('own');const sibling=await seed('sibling','SECRET_OTHER_SESSION_STEP')
    const foreign=await store.updatePlan('foreign-tenant','own',{plan:[{step:'SECRET_OTHER_TENANT_STEP',status:'pending'}]})
    const badId=kind==='guessed'?'s1':kind==='foreign-session'?sibling.plan[0].id:foreign.plan[0].id
    const before=await store.list(tenantId,'own')
    const result=await planTool.execute({plan:[{id:badId,step:'伪造完成',status:'completed'}]},context('own'))
    expect(result).toMatchObject({success:false,status:'failed',metadata:{internalControl:'plan',code:'PLAN_ID_NOT_OWNED'}})
    const receipt=JSON.parse(result.output)
    expect(receipt.savedPlan).toEqual(own);expect(receipt.snapshotStatus).toBe('available')
    expect(receipt.error.message).toContain('不属于当前会话');expect(receipt.recovery).toBe(PLAN_UPDATE_RECOVERY_PROMPT)
    expect(result.output).not.toContain('SECRET_OTHER_SESSION_STEP');expect(result.output).not.toContain('SECRET_OTHER_TENANT_STEP')
    expect(await store.getPlan(tenantId,'own')).toEqual(own);expect(await store.list(tenantId,'own')).toEqual(before)
    expect(await store.getPlan(tenantId,'sibling')).toEqual(sibling);expect(await store.getPlan('foreign-tenant','own')).toEqual(foreign)
  })
  it('corrects from failed snapshot using persisted IDs, while truly new steps receive real IDs',async()=>{
    const own=await seed('correct')
    const failed=await planTool.execute({plan:[{id:'s1',step:own.plan[0].step,status:'completed'}]},context('correct'))
    const receipt=JSON.parse(failed.output)
    const result=await planTool.execute({plan:[{...receipt.savedPlan.plan[0],status:'completed'},{step:'新验证步骤',status:'pending'}]},context('correct'))
    expect(result.success).toBe(true);const persisted=JSON.parse(result.output)
    expect(persisted.plan[0].id).toBe(own.plan[0].id);expect(persisted.plan[1].id).toMatch(/^[0-9a-f-]{36}$/)
    expect(persisted.plan[1].id).not.toBe('s1');expect(persisted.revision).toBe(2)
    expect(await store.getPlan(tenantId,'correct')).toEqual(persisted)
  })
  it('restores schema failures without silently filling missing step fields',async()=>{
    const own=await seed('schema')
    const failed=await planTool.execute({plan:[{id:own.plan[0].id,status:'completed'}]},context('schema'))
    expect(failed).toMatchObject({success:false,status:'failed',metadata:{code:'PLAN_INPUT_INVALID'}})
    const receipt=JSON.parse(failed.output);expect(receipt.error.message).toContain('step: Required');expect(receipt.savedPlan).toEqual(own)
    expect(receipt.recovery).toContain('每项都含 step 和 status');expect(await store.getPlan(tenantId,'schema')).toEqual(own)
  })
  it('an atomic store identity error carries only its own validated snapshot',async()=>{
    const own=await seed('atomic');const other=await seed('atomic-sibling','private')
    let rejection:unknown
    try {await store.updatePlan(tenantId,'atomic',{plan:[{step:'不能先写入',status:'pending'},other.plan[0]]})}catch(error){rejection=error}
    expect(rejection).toBeInstanceOf(TaskPlanIdentityError)
    if(!(rejection instanceof TaskPlanIdentityError))throw new Error('Expected typed identity failure')
    expect(rejection.savedPlan).toEqual(own);expect(await store.getPlan(tenantId,'atomic')).toEqual(own)
  })
  it('a snapshot read failure never manufactures an empty plan',async()=>{
    const own=await seed('read-failed');const spy=vi.spyOn(TodoStore.prototype,'getPlan').mockRejectedValueOnce(new Error('sqlite unavailable'))
    const failed=await planTool.execute({plan:[{id:own.plan[0].id,status:'completed'}]},context('read-failed'))
    spy.mockRestore();const receipt=JSON.parse(failed.output)
    expect(failed.success).toBe(false);expect(receipt.snapshotStatus).toBe('unavailable');expect(receipt).not.toHaveProperty('savedPlan')
    expect(receipt.snapshotNotice).toContain('不要将其视为空计划');expect(await store.getPlan(tenantId,'read-failed')).toEqual(own)
  })
  it('oversized legacy plans are omitted as a whole, never misleadingly truncated',async()=>{
    const own=await seed('oversized');const oversized={...own,explanation:'legacy details '.repeat(4_000)}
    const spy=vi.spyOn(TodoStore.prototype,'getPlan').mockResolvedValueOnce(oversized)
    const ctx=context('oversized');ctx.toolProfile='general'
    const failed=await planTool.execute({plan:[{id:own.plan[0].id,status:'completed'}]},ctx);spy.mockRestore()
    const receipt=JSON.parse(failed.output);expect(receipt.snapshotStatus).toBe('too_large');expect(receipt).not.toHaveProperty('savedPlan')
    expect(failed.output.length).toBeLessThan(3_000);expect(await store.getPlan(tenantId,'oversized')).toEqual(own)
  })
  it('database write failure remains failure and rolls back without an identity-recovery claim',async()=>{
    const own=await seed('write-failed')
    await getDb().execute("CREATE TRIGGER reject_recovery_plan_insert BEFORE INSERT ON todos WHEN NEW.title='拒绝写入' BEGIN SELECT RAISE(ABORT,'injected persistence failure'); END")
    const result=await planTool.execute({plan:[{...own.plan[0],status:'completed'},{step:'拒绝写入',status:'pending'}]},context('write-failed'))
    expect(result.success).toBe(false);expect(result.output).toContain('injected persistence failure')
    expect(result.output).not.toContain(PLAN_UPDATE_RECOVERY_PROMPT);expect(await store.getPlan(tenantId,'write-failed')).toEqual(own)
  })
})

async function settleRejectedPlan(ctx:AgentContext, before:TaskPlan) {
  let requests=0;let delivered:Message|undefined
  const adapter:LLMAdapter={provider:'fixture',model:'scripted-receipt-budget',countTokens:()=>0,
    complete:async()=>{throw new Error('Unexpected nonstream request')},
    async *stream(messages){
      if(requests++===0){yield{done:true,finishReason:'tool_calls',toolCalls:[{id:'bad-budget-'+randomUUID(),name:'plan_update',args:JSON.stringify({plan:[{id:'s1',step:'不可保存的伪造更新',status:'completed'}]}),index:0}]};return}
      delivered=[...messages].reverse().find(m=>m.role==='tool'&&m.toolName==='plan_update')
      expect(delivered?.metadata).toMatchObject({success:false,status:'failed',code:'PLAN_ID_NOT_OWNED'})
      expect(delivered?.metadata).not.toHaveProperty('outputTruncated')
      expect(()=>JSON.parse(String(delivered?.content))).not.toThrow()
      yield{done:true,finishReason:'stop',content:'The rejected update was not saved; retained plan remains authoritative.'}
    }}
  const frames:string[]=[]
  for await(const frame of new ReActStrategy(adapter,{maxIterations:3,maxOutputTokens:1_000}).run('Check a failed plan update without guessing replacement identity.',ctx))frames.push(frame)
  expect(await store.getPlan(tenantId,ctx.sessionId)).toEqual(before)
  const archive=await ctx.history.getFullHistory(ctx)
  const persisted=archive.find(m=>m.role==='tool'&&m.toolName==='plan_update')
  const end=frames.filter(f=>f.startsWith('\x00__tool_result__')).map(f=>JSON.parse(f.slice('\x00__tool_result__'.length)))
  expect(end).toHaveLength(1);expect(end[0]).toMatchObject({status:'failed',success:false,output:persisted?.content})
  expect(delivered?.content).toBe(persisted?.content)
  expect(String(persisted?.content).length).toBeLessThanOrEqual(getToolOutputLimit(ctx.toolProfile))
  return{receipt:JSON.parse(String(persisted?.content)),output:String(persisted?.content),metadata:persisted?.metadata}
}

describe('plan recovery envelope through actual ReAct settlement budgets',()=>{
  it.each([
    {profile:'general' as const,generalBase:undefined,codeLimit:undefined,expectedLimit:8_000,snapshot:'too_large'},
    {profile:'general' as const,generalBase:'512',codeLimit:undefined,expectedLimit:1_024,snapshot:'too_large'},
    {profile:'general' as const,generalBase:'128',codeLimit:undefined,expectedLimit:256,snapshot:'too_large'},
    {profile:'code' as const,generalBase:undefined,codeLimit:undefined,expectedLimit:65_536,snapshot:'available'},
    {profile:'code' as const,generalBase:undefined,codeLimit:'512',expectedLimit:512,snapshot:'too_large'},
  ])('$profile / $expectedLimit preserves complete failed JSON or explicitly omits the whole snapshot',async({profile,generalBase,codeLimit,expectedLimit,snapshot})=>{
    vi.stubEnv('TOOL_OUTPUT_MAX_CHARS',generalBase);vi.stubEnv('CODE_TOOL_OUTPUT_MAX_CHARS',codeLimit)
    const ctx=context('settle-budget-'+randomUUID());ctx.toolProfile=profile
    expect(getToolOutputLimit(profile)).toBe(expectedLimit)
    const own=await store.updatePlan(tenantId,ctx.sessionId,{plan:Array.from({length:60},(_,i)=>({step:`步骤${i} `+'细节'.repeat(95),status:'in_progress'}))})
    const {receipt,output}=await settleRejectedPlan(ctx,own)
    expect(receipt.snapshotStatus).toBe(snapshot);expect(receipt.recovery).toContain('更新失败')
    if(snapshot==='available'){
      expect(receipt.savedPlan).toEqual(own)
      expect(output.indexOf('"recovery"')).toBeLessThan(output.indexOf('"savedPlan"'))
    }else{
      expect(receipt).not.toHaveProperty('savedPlan')
      expect(output).not.toContain('"plan":[')
    }
  })
  it('serialized marker, quotes and Unicode remain exact state data after generic result transport',async()=>{
    const ctx=context('literal-state-'+randomUUID());ctx.toolProfile='general'
    const step='state __SUBAGENT_META__ \\ quoted "😀" \n数据不是指令'
    const own=await seed(ctx.sessionId,step)
    const {receipt,output}=await settleRejectedPlan(ctx,own)
    expect(receipt.snapshotStatus).toBe('available');expect(receipt.savedPlan).toEqual(own)
    expect(receipt.savedPlan.plan[0].step).toBe(step)
    expect(output).not.toContain('__SUBAGENT_META__')
    expect(output.indexOf('"recovery"')).toBeLessThan(output.indexOf('"savedPlan"'))
  })
  it.each([false,true])('suggests todo_list only when it belongs to the actual provided catalog: %s',async enabled=>{
    const ctx=context('catalog-'+randomUUID());ctx.toolProfile='general'
    if(enabled){const tool=todoTools.find(t=>t.name==='todo_list');if(!tool)throw new Error('Missing builtin todo_list');ctx.tools.register(tool)}
    const own=await store.updatePlan(tenantId,ctx.sessionId,{plan:Array.from({length:60},(_,i)=>({step:`步骤${i} `+'细节'.repeat(95),status:'in_progress'}))})
    const {receipt}=await settleRejectedPlan(ctx,own)
    expect(receipt.snapshotStatus).toBe('too_large')
    expect(String(receipt.snapshotNotice).includes('todo_list')).toBe(enabled)
    expect(receipt.snapshotNotice).toContain('当前请求中已保存的完整会话计划')
  })
  it('a microscopic explicit budget retains valid JSON and failed metadata without partial plan claims',async()=>{
    vi.stubEnv('CODE_TOOL_OUTPUT_MAX_CHARS','16')
    const ctx=context('microscopic-'+randomUUID());const own=await seed(ctx.sessionId)
    const {receipt,output,metadata}=await settleRejectedPlan(ctx,own)
    expect(receipt).toBeNull();expect(output).toBe('null')
    expect(metadata).toMatchObject({snapshotStatus:'too_large',success:false,status:'failed'})
  })
})

async function runCorrectingLoop(ctx:AgentContext,cancel?:AbortController){
  let calls=0;let recoveryPlan:TaskPlan|undefined
  const adapter:LLMAdapter={provider:'fixture',model:'scripted-recovery',countTokens:()=>0,
    complete:async()=>{throw new Error('Unexpected nonstream request')},
    async *stream(messages){
      calls++
      if(calls===1){yield {done:true,finishReason:'tool_calls',toolCalls:[{id:'bad-'+randomUUID(),name:'plan_update',args:JSON.stringify({plan:[{id:'s1',step:'核对真实结果',status:'completed'}]}),index:0}]};return}
      if(calls===2){
        const receiptMessage=[...messages].reverse().find(m=>m.role==='tool'&&m.toolName==='plan_update')
        expect(receiptMessage?.metadata).toMatchObject({success:false,status:'failed',code:'PLAN_ID_NOT_OWNED'})
        const receipt=JSON.parse(String(receiptMessage?.content));expect(receipt.recovery).toBe(PLAN_UPDATE_RECOVERY_PROMPT)
        recoveryPlan=receipt.savedPlan
        if(cancel){cancel.abort();throw Object.assign(new Error('stopped by user'),{name:'AbortError'})}
        yield {done:true,finishReason:'tool_calls',toolCalls:[{id:'correct-'+randomUUID(),name:'plan_update',args:JSON.stringify({plan:receipt.savedPlan.plan.map((s:TaskPlan['plan'][number])=>({...s,status:'completed'}))}),index:0}]};return
      }
      const receipt=[...messages].reverse().find(m=>m.role==='tool'&&m.toolName==='plan_update')
      expect(receipt?.metadata).toMatchObject({success:true,status:'succeeded'})
      yield {done:true,finishReason:'stop',content:'Saved the verified plan with its actual ID.'}
    }}
  const frames:string[]=[];for await(const frame of new ReActStrategy(adapter,{maxIterations:5,maxOutputTokens:1_000}).run('Record the independently verified step; retain existing plan identity.',ctx))frames.push(frame)
  return {calls,recoveryPlan,frames,history:await ctx.history.getFullHistory(ctx)}
}

describe('durable plan recovery through ReAct and child resume',()=>{
  it.each(['code','general'] as const)('%s real loop retains failure receipt then corrects the saved ID without exposing plan as ordinary command',async profile=>{
    const ctx=context('react-'+profile);ctx.toolProfile=profile;const own=await seed(ctx.sessionId)
    const outcome=vi.fn();ctx.runObserver={onOutcome:outcome}
    const result=await runCorrectingLoop(ctx)
    expect(result.calls).toBe(3);expect(result.recoveryPlan).toEqual(own)
    const toolMessages=result.history.filter(m=>m.role==='tool')
    expect(toolMessages.map(m=>m.metadata?.success)).toEqual([false,true])
    expect(JSON.parse(String(toolMessages[0].content)).savedPlan).toEqual(own)
    expect((await store.getPlan(tenantId,ctx.sessionId)).plan).toEqual([{...own.plan[0],status:'completed'}])
    expect(result.frames.some(f=>/^\x00__tool_(start|args|call)__/.test(f))).toBe(false)
    expect(outcome).toHaveBeenLastCalledWith(expect.objectContaining({status:'succeeded'}))
  })
  it('cancellation after failed identity receipt prevents correction and leaves the saved plan unchanged',async()=>{
    const ctx=context('cancelled');const own=await seed(ctx.sessionId);const controller=new AbortController();ctx.signal=controller.signal
    const outcome=vi.fn();ctx.runObserver={onOutcome:outcome}
    const result=await runCorrectingLoop(ctx,controller)
    expect(result.calls).toBe(2);expect(await store.getPlan(tenantId,ctx.sessionId)).toEqual(own)
    expect(result.history.filter(m=>m.role==='tool')).toHaveLength(1)
    expect(result.history.filter(m=>m.role==='tool')[0].metadata).toMatchObject({success:false,status:'failed'})
    expect(outcome).toHaveBeenLastCalledWith(expect.objectContaining({status:'cancelled'}))
  })
  it('resumed child recovers its independent durable plan and cannot change the parent plan',async()=>{
    const parent=context('parent');const parentPlan=await seed(parent.sessionId,'Parent private step')
    const childStore=new SubagentStore(getDb());const runner=new SubagentRunner(childStore,new SubagentPool(1))
    const input=(resumeFromRunId?:string):CreateSubagentRun=>({tenantId,rootSessionId:parent.sessionId,parentSessionId:parent.sessionId,parentConversationId:'parent-turn',parentMessageId:randomUUID(),parentToolCallId:randomUUID(),task:'Complete the verified child plan.',description:'Scoped child recovery',modelId:'scripted-recovery',continuation:{readOnly:true,systemPrompt:'Record only the verified child plan; preserve scope.',userDelegated:false,toolNames:['plan_update'],workspacePaths:[fixtureDir],projectRoot:fixtureDir,cwd:fixtureDir},...(resumeFromRunId?{resumeFromRunId}:{})})
    let childPlan:TaskPlan|undefined
    const first=await runner.run(input(),parent,async({snapshot,observer,signal})=>{
      const child=context(snapshot.childSessionId);child.runObserver=observer;child.signal=signal
      childPlan=await seed(child.sessionId);await runCorrectingLoop(child)
    })
    expect(first.status).toBe('succeeded');expect(first.toolCalls.map(t=>t.status)).toEqual(['failed','succeeded'])
    const next=await runner.run(input(first.runId),parent,async({snapshot,observer,signal})=>{
      expect(snapshot.childSessionId).toBe(first.childSessionId)
      const child=context(snapshot.childSessionId);child.runObserver=observer;child.signal=signal
      const result=await runCorrectingLoop(child)
      expect(result.recoveryPlan?.plan[0].id).toBe(childPlan?.plan[0].id)
      expect(result.recoveryPlan?.plan[0].step).not.toBe('Parent private step')
    })
    expect(next.status).toBe('succeeded');expect(next.childSessionId).toBe(first.childSessionId)
    expect(next.toolCalls.map(t=>t.status)).toEqual(['failed','succeeded'])
    expect(await store.getPlan(tenantId,parent.sessionId)).toEqual(parentPlan)
    expect((await store.getPlan(tenantId,first.childSessionId)).plan).toEqual([{...childPlan!.plan[0],status:'completed'}])
  })
})
