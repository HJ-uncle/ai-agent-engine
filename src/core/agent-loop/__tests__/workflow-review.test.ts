import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentContext, Message, ToolCall, ToolResult } from '../../agent-context/index.js'
import type { LLMAdapter, LLMAdapterOptions, LLMStreamChunk } from '../../llm-adapter/types.js'
import type { RunOutcome } from '../../subagent/types.js'
import { ReActStrategy, type ReActOptions } from '../react.js'
import { estimateRequestInput, FINALIZATION_PROMPT } from '../finalization.js'
import { ToolProgressTracker, WORKFLOW_REVIEW_PROMPT, toolFailureLimit } from '../tool-progress.js'

vi.mock('../../../storage/todo/index.js', () => ({ TodoStore: class { async list() { return [] } } }))
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks() })
const succeeded = (output = 'new evidence'): ToolResult => ({success:true,status:'succeeded',output})
const read = (line: number): ToolCall => ({id:String(line),name:'read_file',args:{path:'PRIVATE_SOURCE',start_line:line,end_line:line}})

describe('periodic workflow review without manufacturing no-progress failures', () => {
  it('retains exploration focus through varying reads at the 33 and 64 operation boundaries', () => {
    const tracker=new ToolProgressTracker(()=> 'readonly')
    for(let index=1;index<=31;index++) {expect(tracker.observe([read(index)],[succeeded()])).toBe(0);expect(tracker.workflowReviewPrompt()).toBeUndefined()}
    expect(tracker.observe([read(32),read(33)],[succeeded(),succeeded()])).toBe(0)
    expect(tracker.hasCompletedProgress()).toBe(true)
    expect(tracker.recoveryPrompt()).toBeUndefined()
    for(let index=0;index<3;index++)expect(tracker.workflowReviewPrompt()).toBe(WORKFLOW_REVIEW_PROMPT)
    tracker.markWorkflowReviewDispatched()
    expect(tracker.workflowReviewPrompt()).toBe(WORKFLOW_REVIEW_PROMPT)
    for(let index=34;index<=64;index++) {
      expect(tracker.observe([read(index)],[succeeded()])).toBe(0)
      expect(tracker.hasCompletedProgress()).toBe(true)
      expect(tracker.recoveryPrompt()).toBeUndefined()
      expect(tracker.workflowReviewPrompt()).toBe(WORKFLOW_REVIEW_PROMPT)
      tracker.markWorkflowReviewDispatched()
    }
  })


  it('keeps dispatched focus through actions and later read evidence in the same turn', () => {
    const tracker=new ToolProgressTracker(call=>call.name==='read_file'?'readonly':call.name==='unknown_mode'?undefined:'serial')
    for(let index=1;index<=32;index++)tracker.observe([read(index)],[succeeded()])
    tracker.markWorkflowReviewDispatched()
    const excluded:Array<{call:ToolCall,result:ToolResult}>= [
      ...['plan_update','todo_list','todo_create','todo_update','todo_delete'].map(name=>({call:{...read(100),name},result:succeeded()})),
      {call:{...read(101),name:'command_output'},result:{...succeeded(),metadata:{commandJob:{status:'running'}}}},
      {call:{...read(102),name:'task_status'},result:succeeded('{"status":"queued"}')},
      {call:{...read(103),name:'write_file'},result:{success:false,status:'cancelled',output:'cancelled'}},
      {call:{...read(104),name:'write_file'},result:{success:false,status:'interrupted',output:'interrupted'}},
      {call:{...read(105),name:'write_file'},result:{success:false,status:'failed',output:'temporary timeout',metadata:{retryable:true}}},
      {call:{...read(106),name:'write_file'},result:{success:false,status:'failed',output:'invalid input'}},
      {call:{...read(107),name:'unknown_mode'},result:succeeded()},
      {call:read(108),result:succeeded()},
    ]
    for(const {call,result} of excluded) {
      tracker.observe([call],[result])
      tracker.markWorkflowReviewDispatched()
      expect(tracker.workflowReviewPrompt()).toBe(WORKFLOW_REVIEW_PROMPT)
    }
    tracker.observe([{...read(109),name:'write_file'}],[succeeded('written')])
    expect(tracker.workflowReviewPrompt()).toBe(WORKFLOW_REVIEW_PROMPT)
    for(let index=110;index<141;index++) {
      expect(tracker.observe([read(index)],[succeeded()])).toBe(0)
      expect(tracker.workflowReviewPrompt()).toBe(WORKFLOW_REVIEW_PROMPT)
    }
    expect(tracker.observe([read(141)],[succeeded()])).toBe(0)
    expect(tracker.workflowReviewPrompt()).toBe(WORKFLOW_REVIEW_PROMPT)
  })


  it.each([
    ...['done','failed','cancelled'].map(status=>({name:'task_status',result:succeeded(JSON.stringify({status}))})),
    ...['succeeded','failed','cancelled'].map(status=>({name:'command_output',result:{...succeeded('terminal command output'),metadata:{commandJob:{status}}}})),
    {name:'task_list',result:succeeded('[]')},
  ])('keeps focus after a successful $name query regardless of the observed terminal state',({name,result})=>{
    // The registry serializes task queries; serialization alone is not a mutation.
    const tracker=new ToolProgressTracker(call=>call.name==='read_file'?'readonly':'serial')
    for(let index=1;index<=32;index++)tracker.observe([read(index)],[succeeded()])
    tracker.markWorkflowReviewDispatched()
    expect(tracker.observe([{...read(100),name,args:{taskId:'task'}}],[result])).toBe(0)
    expect(tracker.hasCompletedProgress()).toBe(true)
    expect(tracker.workflowReviewPrompt()).toBe(WORKFLOW_REVIEW_PROMPT)
    tracker.markWorkflowReviewDispatched()
    expect(tracker.observe([read(101)],[succeeded()])).toBe(0)
    expect(tracker.workflowReviewPrompt()).toBe(WORKFLOW_REVIEW_PROMPT)
  })

  it.each(['write_file','edit_file','execute_cmd','subagent'])('retains focus after a successful permitted %s action',name=>{
    const tracker=new ToolProgressTracker(call=>call.name==='read_file'?'readonly':'serial')
    for(let index=1;index<=32;index++)tracker.observe([read(index)],[succeeded()])
    tracker.markWorkflowReviewDispatched()
    expect(tracker.workflowReviewPrompt()).toBe(WORKFLOW_REVIEW_PROMPT)
    expect(tracker.observe([{...read(100),name}],[succeeded('completed authorized action')])).toBe(0)
    expect(tracker.workflowReviewPrompt()).toBe(WORKFLOW_REVIEW_PROMPT)
    expect(tracker.hasCompletedProgress()).toBe(true)
  })


  it('retains focus across 500 identical successful diagnostic commands without a new stop condition', () => {
    vi.stubEnv('MAX_CONSECUTIVE_FAILURES', undefined)
    const tracker = new ToolProgressTracker(call => call.name === 'read_file' ? 'readonly' : 'serial')
    for (let index = 0; index < 32; index++) tracker.observe([read(index)], [succeeded()])
    tracker.markWorkflowReviewDispatched()
    const command: ToolCall = { id: 'diagnostic', name: 'execute_cmd', args: { command: 'node', args: ['-v'] } }
    let consecutive = 0
    for (let index = 0; index < 500; index++) {
      consecutive = tracker.observe([command], [succeeded('v24')])
      tracker.markWorkflowReviewDispatched()
      expect(tracker.workflowReviewPrompt()).toBe(WORKFLOW_REVIEW_PROMPT)
    }
    expect(consecutive).toBe(499)
    expect(toolFailureLimit()).toBe(Infinity)
    expect(consecutive).toBeLessThan(toolFailureLimit())
  })

  it('retains focus through novel command arguments and output while preserving progress accounting', () => {
    const tracker = new ToolProgressTracker(() => 'serial')
    for (let index = 0; index < 32; index++) tracker.observe([read(index)], [succeeded()])
    tracker.markWorkflowReviewDispatched()
    for (let index = 0; index < 100; index++) {
      const call: ToolCall = { id: String(index), name: 'execute_cmd', args: { command: 'node', args: ['-e', 'console.log(' + index + ')'] } }
      expect(tracker.observe([call], [succeeded('stdout ' + index)])).toBe(0)
      expect(tracker.hasCompletedProgress()).toBe(true)
      expect(tracker.workflowReviewPrompt()).toBe(WORKFLOW_REVIEW_PROMPT)
    }
  })

  it('keeps focus isolated from the counters and hints of a new turn', () => {
    const first = new ToolProgressTracker(() => 'readonly')
    for (let index = 0; index < 32; index++) first.observe([read(index)], [succeeded()])
    first.markWorkflowReviewDispatched()
    const next = new ToolProgressTracker(() => 'readonly')
    expect(first.workflowReviewPrompt()).toBe(WORKFLOW_REVIEW_PROMPT)
    expect(next.workflowReviewPrompt()).toBeUndefined()
    expect(next.recoveryPrompt()).toBeUndefined()
    expect(next.hasCompletedProgress()).toBe(false)
    next.observe([read(0)], [succeeded()])
    expect(next.workflowReviewPrompt()).toBeUndefined()
  })

  it('reviews changed temporary writes and commands without classifying them as repeated calls', () => {
    const tracker=new ToolProgressTracker(()=> 'serial')
    for(let index=0;index<16;index++) {
      const write:ToolCall={id:'write'+index,name:'write_file',args:{path:`.ae/tmp/probe${index}.mjs`,content:'changed'+index}}
      const execute:ToolCall={id:'exec'+index,name:'execute_cmd',args:{command:'node',args:[`.ae/tmp/probe${index}.mjs`]}}
      expect(tracker.observe([write],[succeeded()])).toBe(0)
      expect(tracker.observe([execute],[succeeded('80 checks passed')])).toBe(0)
    }
    expect(tracker.workflowReviewPrompt()).toBe(WORKFLOW_REVIEW_PROMPT)
    expect(tracker.hasCompletedProgress()).toBe(true)
    expect(tracker.recoveryPrompt()).toBeUndefined()
  })

  it.each(['plan_update','todo_list','todo_create','todo_update','todo_delete'])('does not count %s controls as substantive operations', name=> {
    const tracker=new ToolProgressTracker()
    for(let index=0;index<100;index++)tracker.observe([{...read(index),name}],[succeeded('plan '+index)])
    expect(tracker.workflowReviewPrompt()).toBeUndefined()
  })

  it('excludes active polls, cancellation, interruption and transient infrastructure failure', () => {
    const tracker=new ToolProgressTracker(()=> 'readonly')
    for(let index=0;index<100;index++)tracker.observe([
      {...read(index),name:'command_output'},read(index),read(index),read(index)
    ],[
      {...succeeded(),metadata:{commandJob:{status:'running'}}},
      {success:false,status:'cancelled',output:'cancelled'},
      {success:false,status:'interrupted',output:'interrupted'},
      {success:false,status:'failed',output:'gateway unavailable',metadata:{retryable:true}}
    ])
    expect(tracker.workflowReviewPrompt()).toBeUndefined()
    expect(tracker.hasCompletedProgress()).toBe(false)
  })

  it('advice after permanent failures does not reopen reasoning output recovery', () => {
    const tracker=new ToolProgressTracker(()=> 'readonly')
    for(let index=0;index<32;index++)tracker.observe([read(index)],[{success:false,status:'failed',output:'invalid input'}])
    expect(tracker.workflowReviewPrompt()).toBe(WORKFLOW_REVIEW_PROMPT)
    expect(tracker.hasCompletedProgress()).toBe(false)
  })
})

function fixture(profile:'code'|'general', operations=34, mutationAt?:number) {
  vi.stubEnv('MAX_CONSECUTIVE_FAILURES',undefined)
  const history:Message[]=[],requests:Array<{messages:Message[],options:LLMAdapterOptions}>=[],outcomes:RunOutcome[]=[]
  let request=0
  const ctx={tenantId:'tenant',sessionId:'child',rootRunId:'root',turnId:'turn',userMessageId:'user',assistantMessageId:'assistant',workspaceDir:'.',
    toolProfile:profile,tokenBudget:100000,modelCaps:{contextWindow:100000},
    logger:{debug:vi.fn(),info:vi.fn(),warn:vi.fn(),error:vi.fn()},
    history:{append:vi.fn(async(message:Message)=>{history.push(message);return message.id??'saved'}),getHistory:vi.fn(async()=>[...history]),getFullHistory:vi.fn(async()=>[...history]),
      microCompactToolResults:vi.fn(async()=>({cleared:0,freedTokens:0})),compress:vi.fn(async()=>({preTokens:0,postTokens:0}))},
    tools:{list:()=>['read_file',...(mutationAt?['write_file']:[])].map(name=>({name,description:name,parameters:{type:'object'}})),has:()=>true,executionMode:(name:string)=>name==='write_file'?'serial':'readonly',preflight:vi.fn(async()=>undefined),
      execute:vi.fn(async(_name:string,args:Record<string,unknown>)=>({success:true,output:`line ${args.start_line} TOOL_OUTPUT_ATTACK`}))},
    runObserver:{onOutcome:vi.fn(async(outcome:RunOutcome)=>{outcomes.push(outcome)}),onToolStart:vi.fn(),onToolEnd:vi.fn()}
  } as unknown as AgentContext
  const stream:LLMAdapter['stream']=async function*(messages:Message[],options?:LLMAdapterOptions):AsyncGenerator<LLMStreamChunk>{
    requests.push({messages:[...messages],options:options!})
    if(request++<operations && options?.tools?.length) {
      const name=request===mutationAt?'write_file':'read_file'
      const args=name==='write_file'?{path:'PRIVATE_SOURCE',content:'approved implementation'}:read(request).args
      yield{done:true,toolCalls:[{id:'call-'+request,name,args:JSON.stringify(args),index:0}],finishReason:'tool_calls'}
    }
    else yield{done:true,content:'Supported review conclusion.',finishReason:'stop'}
  }
  const llm:LLMAdapter={model:'model',provider:'mock',complete:vi.fn(),countTokens:()=>0,stream:vi.fn(stream)}
  async function run(options:ReActOptions={}){const frames:string[]=[];for await(const frame of new ReActStrategy(llm,{systemPrompt:'Read-only comprehensive audit; do not modify files.',...options}).run('Investigate the full requested source and deliver a review.',ctx))frames.push(frame);return frames}
  return{ctx,history,requests,outcomes,llm,run}
}

describe('actual ReAct request admission with periodic workflow advice',()=>{
  it.each(['code','general'] as const)('keeps %s policy, budgeting and complete durable evidence through changing read ranges',async profile=>{
    const f=fixture(profile,66),frames=await f.run()
    expect(f.requests).toHaveLength(67)
    expect(f.requests.map((request,index)=>request.options.systemPrompt?.includes(WORKFLOW_REVIEW_PROMPT)?index:-1).filter(index=>index>=0)).toEqual(Array.from({length:35},(_,index)=>index+32))
    const admitted=f.requests[32]
    expect(admitted.options.systemPrompt).toContain('Read-only comprehensive audit; do not modify files.')
    expect(admitted.options.systemPrompt).not.toContain('PRIVATE_SOURCE')
    expect(admitted.options.systemPrompt).not.toContain('TOOL_OUTPUT_ATTACK')
    expect(admitted.options.requestInputTokenEstimate).toBe(estimateRequestInput(admitted.messages,admitted.options.systemPrompt,f.ctx.tools.list()))
    expect(admitted.options.requestInputTokenEstimate!+admitted.options.maxTokens!).toBeLessThanOrEqual(100000)
    expect(f.ctx.tools.execute).toHaveBeenCalledTimes(66)
    expect(f.history.filter(message=>message.role==='tool')).toHaveLength(66)
    expect(f.history.some(message=>String(message.content).includes(WORKFLOW_REVIEW_PROMPT))).toBe(false)
    expect(f.outcomes.at(-1)).toMatchObject({status:'succeeded',stopReason:'completed'})
    expect(frames.filter(frame=>!frame.startsWith('\x00__')).join('')).toBe('Supported review conclusion.')
  })



  it.each(['code','general'] as const)('keeps %s read-only focus across terminal task, command and list queries with serial registry classification',async profile=>{
    const f=fixture(profile,0)
    const queryNames=['task_status','task_list','command_output']
    f.ctx.tools.list=()=>['read_file',...queryNames].map(name=>({name,description:name,parameters:{type:'object'}}))
    f.ctx.tools.executionMode=name=>name==='read_file'?'readonly':'serial'
    f.ctx.tools.execute=vi.fn(async name=>name==='task_status'?succeeded('{"status":"done"}')
      :name==='task_list'?succeeded('[]'):name==='command_output'?{...succeeded('done'),metadata:{commandJob:{status:'succeeded'}}}:succeeded('fresh evidence'))
    const calls:ToolCall[]=[...Array.from({length:32},(_,index)=>read(index+1)),
      ...queryNames.map(name=>({...read(100),name,args:{taskId:'task'}})),read(101)]
    let callIndex=0
    f.llm.stream=vi.fn(async function*(messages:Message[],options?:LLMAdapterOptions):AsyncGenerator<LLMStreamChunk>{
      f.requests.push({messages:[...messages],options:options!})
      const call=calls[callIndex++]
      if(call)yield{done:true,toolCalls:[{id:'query-boundary-'+callIndex,name:call.name,args:JSON.stringify(call.args),index:0}],finishReason:'tool_calls'}
      else yield{done:true,content:'Supported review conclusion.',finishReason:'stop'}
    })
    await f.run()
    expect(f.requests).toHaveLength(37)
    expect(f.requests.slice(32).every(request=>request.options.systemPrompt?.includes(WORKFLOW_REVIEW_PROMPT))).toBe(true)
    expect(f.requests.every(request=>request.options.systemPrompt?.includes('Read-only comprehensive audit; do not modify files.'))).toBe(true)
    expect(f.requests.every(request=>!request.options.tools?.some(tool=>['write_file','edit_file','execute_cmd','subagent'].includes(tool.name)))).toBe(true)
    expect(f.ctx.tools.execute).toHaveBeenCalledTimes(36)
    expect(f.history.filter(message=>message.role==='tool')).toHaveLength(36)
    expect(f.history.some(message=>String(message.content).includes(WORKFLOW_REVIEW_PROMPT))).toBe(false)
    expect(f.outcomes.at(-1)).toMatchObject({status:'succeeded',stopReason:'completed'})
  })

  it('retains focused body continuation after a terminal serial task query without promoting the query into an action',async()=>{
    const f=fixture('general',32),original=f.llm.stream
    f.ctx.tools.list=()=>['read_file','task_status'].map(name=>({name,description:name,parameters:{type:'object'}}))
    f.ctx.tools.executionMode=name=>name==='read_file'?'readonly':'serial'
    f.ctx.tools.execute=vi.fn(async name=>succeeded(name==='task_status'?'{"status":"done"}':'fresh evidence'))
    f.llm.stream=vi.fn(async function*(messages:Message[],options?:LLMAdapterOptions):AsyncGenerator<LLMStreamChunk>{
      if(f.requests.length===32){
        f.requests.push({messages:[...messages],options:options!})
        yield{done:true,content:'Retained partial review. ',finishReason:'length',promptTokens:20,completionTokens:8192}
      }else if(f.requests.length===33){
        f.requests.push({messages:[...messages],options:options!})
        yield{done:true,toolCalls:[{id:'terminal-task-query',name:'task_status',args:'{"taskId":"task"}',index:0}],finishReason:'tool_calls'}
      }else yield*original(messages,options)
    })
    await f.run()
    expect(f.requests).toHaveLength(35)
    expect(f.requests.slice(32).every(request=>request.options.systemPrompt?.includes(WORKFLOW_REVIEW_PROMPT))).toBe(true)
    expect(JSON.stringify(f.requests[33].messages)).toContain('Continue the same user task')
    expect(f.requests[34].options.systemPrompt).toContain('Read-only comprehensive audit; do not modify files.')
    expect(f.requests.every(request=>request.options.tools?.map(tool=>tool.name).join(',')==='read_file,task_status')).toBe(true)
    expect(f.ctx.tools.execute).toHaveBeenCalledTimes(33)
    expect(vi.mocked(f.ctx.tools.execute).mock.calls.filter(([name])=>name==='task_status')).toHaveLength(1)
    expect(f.outcomes.at(-1)).toMatchObject({status:'succeeded',stopReason:'completed'})
  })

  it('keeps focus through complete read results and an authorized write without changing permissions',async()=>{
    const f=fixture('general',67,34)
    await f.run({systemPrompt:'Implement and verify the requested file using only the provided tools and existing permissions.'})
    expect(f.requests).toHaveLength(68)
    expect(f.requests.map((request,index)=>request.options.systemPrompt?.includes(WORKFLOW_REVIEW_PROMPT)?index:-1).filter(index=>index>=0)).toEqual(Array.from({length:36},(_,index)=>index+32))
    expect(f.requests.every(request=>JSON.stringify(request.options.tools?.map(tool=>tool.name))===JSON.stringify(['read_file','write_file']))).toBe(true)
    expect(f.requests.every(request=>!request.options.systemPrompt?.includes('PRIVATE_SOURCE') && !request.options.systemPrompt?.includes('TOOL_OUTPUT_ATTACK'))).toBe(true)
    expect(f.ctx.tools.execute).toHaveBeenCalledTimes(67)
    expect(vi.mocked(f.ctx.tools.execute).mock.calls.filter(([name])=>name==='write_file')).toHaveLength(1)
    expect(f.history.filter(message=>message.role==='tool')).toHaveLength(67)
    expect(f.history.some(message=>String(message.content).includes(WORKFLOW_REVIEW_PROMPT))).toBe(false)
    expect(f.outcomes.at(-1)).toMatchObject({status:'succeeded',stopReason:'completed'})
  })


  it('does not leak focus into a second run of the same ReAct strategy and session', async () => {
    const f = fixture('general', 34)
    const strategy = new ReActStrategy(f.llm, { systemPrompt: 'Use only the provided tools and existing permissions.' })
    const consume = async () => { for await (const _frame of strategy.run('Deliver the requested review.', f.ctx)) { /* consume the mock run */ } }
    await consume()
    expect(f.requests).toHaveLength(35)
    expect(f.requests.at(-1)!.options.systemPrompt).toContain(WORKFLOW_REVIEW_PROMPT)
    await consume()
    expect(f.requests).toHaveLength(36)
    expect(f.requests.at(-1)!.options.systemPrompt).not.toContain(WORKFLOW_REVIEW_PROMPT)
    expect(f.requests.at(-1)!.options.systemPrompt).toContain('Use only the provided tools and existing permissions.')
    expect(f.history.some(message => String(message.content).includes(WORKFLOW_REVIEW_PROMPT))).toBe(false)
    expect(f.outcomes.map(outcome => outcome.status)).toEqual(['succeeded', 'succeeded'])
  })

  it('does not conflict with explicit max-step evidence-only finalization after focus was dispatched',async()=>{
    const f=fixture('general'),frames=await f.run({maxIterations:35,finalizeOnLimit:true})
    expect(f.requests).toHaveLength(35)
    expect(f.requests[33].options.systemPrompt).toContain(WORKFLOW_REVIEW_PROMPT)
    const last=f.requests.at(-1)!
    expect(last.options.tools).toEqual([])
    expect(last.options.systemPrompt).toContain(FINALIZATION_PROMPT)
    expect(last.options.systemPrompt).not.toContain(WORKFLOW_REVIEW_PROMPT)
    expect(last.options.systemPrompt).toContain('Read-only comprehensive audit; do not modify files.')
    expect(last.options.requestInputTokenEstimate).toBe(estimateRequestInput(last.messages,last.options.systemPrompt,[]))
    expect(f.ctx.tools.execute).toHaveBeenCalledTimes(34)
    expect(f.outcomes.at(-1)).toMatchObject({status:'failed',stopReason:'max_steps'})
    expect(frames.join('')).toContain('探索步数上限')
  })

  it('does not conflict with explicit request-budget finalization after focus was dispatched',async()=>{
    const f=fixture('general')
    f.ctx.requestBudget={canAfford:vi.fn((amount:number)=>f.requests.length<34 || amount<10000)} as unknown as NonNullable<AgentContext['requestBudget']>
    await f.run()
    const last=f.requests.at(-1)!
    expect(f.requests).toHaveLength(35)
    expect(f.requests[33].options.systemPrompt).toContain(WORKFLOW_REVIEW_PROMPT)
    expect(last.options.tools).toEqual([])
    expect(last.options.systemPrompt).toContain(FINALIZATION_PROMPT)
    expect(last.options.systemPrompt).not.toContain(WORKFLOW_REVIEW_PROMPT)
    expect(f.ctx.tools.execute).toHaveBeenCalledTimes(34)
    expect(f.outcomes.at(-1)).toMatchObject({status:'failed',stopReason:'budget'})
  })

  it.each(['body','reasoning'] as const)('retains safe focus without overriding %s length recovery',async kind=>{
    const f=fixture('general',32),original=f.llm.stream
    f.llm.stream=vi.fn(async function*(messages:Message[],options?:LLMAdapterOptions):AsyncGenerator<LLMStreamChunk>{
      if(f.requests.length===32){
        f.requests.push({messages:[...messages],options:options!})
        yield{done:true,finishReason:'length',promptTokens:20,completionTokens:8192,
          ...(kind==='body'?{content:'Retained partial review. '}:{reasoningContent:'PRIVATE_REASONING'})}
      }else yield*original(messages,options)
    })
    await f.run()
    expect(f.requests).toHaveLength(34)
    expect(f.requests.map((request,index)=>request.options.systemPrompt?.includes(WORKFLOW_REVIEW_PROMPT)?index:-1).filter(index=>index>=0)).toEqual([32,33])
    if(kind==='body')expect(JSON.stringify(f.requests[33].messages)).toContain('Continue the same user task')
    else expect(f.requests[33].options.systemPrompt).toContain('before producing a public answer')
    expect(f.requests[33].options.systemPrompt).toContain(WORKFLOW_REVIEW_PROMPT)
    expect(f.requests[33].options.requestInputTokenEstimate!+f.requests[33].options.maxTokens!).toBeLessThanOrEqual(100000)
    expect(f.requests[33].messages.some(message=>String(message.content).includes(WORKFLOW_REVIEW_PROMPT))).toBe(false)
    if(kind==='reasoning')expect(JSON.stringify(f.requests[33].messages)).not.toContain('PRIVATE_REASONING')
    expect(f.ctx.tools.execute).toHaveBeenCalledTimes(32)
    expect(f.outcomes.at(-1)).toMatchObject({status:'succeeded',stopReason:'completed'})
    expect(f.history.some(message=>message.usage?.completionTokens===8192)).toBe(true)
  })

  it('retains focus through actual summarizer dispatch and repeated history preparation',async()=>{
    const f=fixture('general'),completeRequests:Array<{messages:Message[],options?:LLMAdapterOptions}>=[]
    let compressedOffset=0,summary=''
    f.ctx.history.getHistory=vi.fn(async()=>compressedOffset?[f.history[0],{role:'assistant' as const,content:summary,createdAt:Date.now()},...f.history.slice(compressedOffset)]:[...f.history])
    f.ctx.history.getFullHistory=f.ctx.history.getHistory
    f.llm.complete=vi.fn(async(messages:Message[],options?:LLMAdapterOptions)=>{
      completeRequests.push({messages:[...messages],options})
      expect(f.requests).toHaveLength(32)
      return{content:'<summary>Retained read-only audit evidence and remaining review.</summary>',promptTokens:30,completionTokens:12,finishReason:'stop' as const,model:'model'}
    })
    f.ctx.history.compress=vi.fn(async(_ctx,summarize)=>{
      summary=await summarize([...f.history])
      compressedOffset=f.history.length
      return{preTokens:4000,postTokens:50}
    })
    let reads=0
    f.ctx.tools.execute=vi.fn(async(_name,args)=>{
      if(++reads===32)vi.stubEnv('COMPRESS_THRESHOLD_RATIO','0.1')
      return{success:true,output:'line '+(args as Record<string,unknown>).start_line}
    })
    await f.run()
    expect(f.ctx.history.compress).toHaveBeenCalledTimes(1)
    expect(completeRequests.length).toBeGreaterThan(0)
    expect(completeRequests.every(request=>!request.options?.systemPrompt?.includes(WORKFLOW_REVIEW_PROMPT) && !JSON.stringify(request.messages).includes(WORKFLOW_REVIEW_PROMPT))).toBe(true)
    expect(f.requests).toHaveLength(35)
    expect(f.requests.map((request,index)=>request.options.systemPrompt?.includes(WORKFLOW_REVIEW_PROMPT)?index:-1).filter(index=>index>=0)).toEqual([32,33,34])
    expect(f.history.filter(message=>message.role==='tool')).toHaveLength(34)
    expect(f.outcomes.at(-1)).toMatchObject({status:'succeeded',stopReason:'completed'})
  })
})
