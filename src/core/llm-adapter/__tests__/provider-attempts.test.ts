/** Exercises real SDK adapter serialization/fetch paths without a live model or credentials. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OpenAIAdapter } from '../openai.js'
import { AnthropicAdapter } from '../anthropic.js'
import { RetryingAdapter, withRetry } from '../retry.js'
import { OllamaAdapter } from '../ollama.js'
import type { LLMAdapter, LLMAdapterOptions, LLMRequestAttemptEvent, LLMStreamChunk } from '../types.js'
import { estimateTokens } from '../../utils/tokens.js'

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })
const messages = [{role:'user' as const, content:'inspect project'}]
async function consume(adapter: LLMAdapter, signal: AbortSignal, events: LLMRequestAttemptEvent[]) {
  const chunks: LLMStreamChunk[] = []
  for await (const chunk of adapter.stream(messages, {model:adapter.model,signal,onRequestAttempt:event=>{events.push(event)}})) chunks.push(chunk)
  return chunks
}

describe('actual request attempts', () => {
  it('omits the engine-side max_tokens field for an unbounded Code request', async () => {
    const wire = 'data: ' + JSON.stringify({ id: 'm', choices: [{ index: 0, delta: { content: 'done' }, finish_reason: null }] }) + '\n\n'
      + 'data: ' + JSON.stringify({ id: 'm', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1 } }) + '\n\ndata: [DONE]\n\n'
    const fetchMock = vi.fn(async () => new Response(wire, { headers: { 'content-type': 'text/event-stream' } }))
    vi.stubGlobal('fetch', fetchMock)
    const adapter = new OpenAIAdapter('test-model', 'fake-key', 'http://model.invalid')
    for await (const _chunk of adapter.stream(messages, {
      model: adapter.model,
      signal: new AbortController().signal,
      unboundedOutput: true,
    })) { /* consume the complete request */ }
    const body = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body)) as Record<string, unknown>
    expect(body).not.toHaveProperty('max_tokens')
    expect(body).not.toHaveProperty('max_completion_tokens')
  })

  it('uses the gateway maximum for an unbounded DeepSeek V4 Code request', async () => {
    const wire = 'data: ' + JSON.stringify({ id: 'm', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1 } }) + '\n\ndata: [DONE]\n\n'
    const fetchMock = vi.fn(async () => new Response(wire, { headers: { 'content-type': 'text/event-stream' } }))
    vi.stubGlobal('fetch', fetchMock)
    const adapter = new OpenAIAdapter('deepseek-v4.1-flash', 'fake-key', 'http://model.invalid')
    for await (const _chunk of adapter.stream(messages, {
      model: adapter.model,
      signal: new AbortController().signal,
      unboundedOutput: true,
      // A near-full context used to turn the protocol field into 400. The
      // provider fallback must remain its wire maximum instead of inheriting
      // that estimate as an accidental completion cap.
      contextWindow: 1_000_000,
      requestInputTokenEstimate: 999_600,
    })) { /* consume the complete request */ }
    const body = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body)) as Record<string, unknown>
    expect(body.max_completion_tokens).toBe(393216)
    expect(Number.isInteger(body.max_completion_tokens)).toBe(true)
  })

  it('preserves an explicitly requested DeepSeek V4 completion limit', async () => {
    const wire = 'data: ' + JSON.stringify({ id: 'm', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1 } }) + '\n\ndata: [DONE]\n\n'
    const fetchMock = vi.fn(async () => new Response(wire, { headers: { 'content-type': 'text/event-stream' } }))
    vi.stubGlobal('fetch', fetchMock)
    const adapter = new OpenAIAdapter('deepseek-v4.1-flash', 'fake-key', 'http://model.invalid')
    for await (const _chunk of adapter.stream(messages, {
      model: adapter.model,
      signal: new AbortController().signal,
      maxTokens: 400,
      unboundedOutput: true,
    })) { /* consume the complete request */ }
    const body = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body)) as Record<string, unknown>
    expect(body.max_completion_tokens).toBe(400)
  })

  it('caps an oversized unbounded Anthropic-compatible request at the gateway limit', async () => {
    const streamMock = vi.fn(() => ({
      async *[Symbol.asyncIterator]() { yield { type: 'message_stop' } },
      finalMessage: async () => ({ model: 'deepseek-v4.1-flash', stop_reason: 'end_turn', usage: { input_tokens: 3, output_tokens: 1 } }),
      abort: vi.fn(),
    }))
    const adapter = new AnthropicAdapter('deepseek-v4.1-flash', 'fake-key', 'http://model.invalid', { 'X-Access-Token': 'fake-token' })
    ;(adapter as any).client = { messages: { stream: streamMock } }
    for await (const _chunk of adapter.stream(messages, {
      model: adapter.model,
      signal: new AbortController().signal,
      unboundedOutput: true,
      contextWindow: 1_000_000,
      requestInputTokenEstimate: 999_600,
    })) { /* consume the complete request */ }
    const request = (streamMock.mock.calls[0] as unknown as [Record<string, unknown>])[0]
    expect(request.max_tokens).toBe(393216)
  })

  it('does not retry a 400 body error even when its message contains a 5', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({error:{message:'Request 512 body format invalid',type:'invalid_request_error'}}),{status:400,headers:{'content-type':'application/json'}}))
    vi.stubGlobal('fetch', fetchMock)
    const events: LLMRequestAttemptEvent[]=[]
    const adapter = new RetryingAdapter(new OpenAIAdapter('test-model','fake-key','http://model.invalid'))
    await expect(adapter.complete(messages,{model:adapter.model,onRequestAttempt:event=>{events.push(event)}})).rejects.toThrow('format invalid')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(events.map(event=>event.type)).toEqual(['start','finish'])
    expect(events[1]).toMatchObject({outcome:'failed'})
    expect(events[1]).not.toHaveProperty('usage')
  })

  it('records parameter compatibility retries as distinct requests and keeps cache tokens a subset', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({error:{message:"Unsupported parameter: 'temperature'",type:'invalid_request_error'}}),{status:400,headers:{'content-type':'application/json'}}))
      .mockResolvedValueOnce(new Response(JSON.stringify({id:'answer',choices:[{message:{role:'assistant',content:'done'},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:2,prompt_tokens_details:{cached_tokens:6}}}),{headers:{'content-type':'application/json'}}))
    vi.stubGlobal('fetch',fetchMock)
    const events: LLMRequestAttemptEvent[]=[]
    const adapter=new OpenAIAdapter('test-model','fake-key','http://model.invalid')
    const result=await adapter.complete(messages,{model:adapter.model,temperature:0.7,maxTokens:42,onRequestAttempt:event=>{events.push(event)}})
    expect(result.content).toBe('done')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(events.map(event=>event.type)).toEqual(['start','finish','start','finish'])
    expect(events[0].requestAttemptId).not.toBe(events[2].requestAttemptId)
    expect(events[3]).toMatchObject({outcome:'succeeded',usage:{promptTokens:10,completionTokens:2,cacheHitTokens:6,cacheMissTokens:4}})
    expect(events[0]).toMatchObject({maxOutputTokens:42})
  })

  it.each(['openai','anthropic'] as const)('cancels %s before first delta without success or another request', async provider => {
    let started!:()=>void
    const ready=new Promise<void>(resolve=>{started=resolve})
    const fetchMock=vi.fn((_url:unknown,init?:RequestInit)=>new Promise<Response>((_resolve,reject)=>{
      started()
      init?.signal?.addEventListener('abort',()=>reject(init.signal?.reason),{once:true})
    }))
    vi.stubGlobal('fetch',fetchMock)
    const adapter=provider==='openai'?new OpenAIAdapter('test-model','fake-key','http://model.invalid'):new AnthropicAdapter('claude-test','fake-key','http://model.invalid',{'X-Access-Token':'fake-token'})
    const events:LLMRequestAttemptEvent[]=[]
    const controller=new AbortController()
    const pending=consume(adapter,controller.signal,events)
    const rejected=expect(pending).rejects.toThrow()
    await ready
    controller.abort()
    await rejected
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(events.map(event=>event.type)).toEqual(['start','finish'])
    expect(events[1]).toMatchObject({outcome:'cancelled'})
  })

  it('aborting retry backoff prevents the next request', async () => {
    const controller=new AbortController()
    const operation=vi.fn(async()=>{throw Object.assign(new Error('busy'),{status:429})})
    const pending=withRetry(operation,{maxRetries:2,baseDelayMs:20000,maxDelayMs:20000},controller.signal)
    const rejected=expect(pending).rejects.toMatchObject({name:'AbortError'})
    await Promise.resolve()
    controller.abort()
    await rejected
    expect(operation).toHaveBeenCalledTimes(1)
  })

  it.each(['openai','anthropic'] as const)('retains %s output-limit termination and reported usage', async provider=>{
    const frames=provider==='openai' ? [
      {id:'m',model:'test-model',choices:[{index:0,delta:{content:'partial'},finish_reason:null}]},
      {id:'m',model:'test-model',choices:[{index:0,delta:{},finish_reason:'length'}],usage:{prompt_tokens:10,completion_tokens:4}},
    ] : [
      {type:'message_start',message:{id:'m',type:'message',role:'assistant',model:'claude-test',content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:3,output_tokens:0,cache_read_input_tokens:5,cache_creation_input_tokens:2}}},
      {type:'content_block_start',index:0,content_block:{type:'text',text:''}},
      {type:'content_block_delta',index:0,delta:{type:'text_delta',text:'partial'}},
      {type:'content_block_stop',index:0},
      {type:'message_delta',delta:{stop_reason:'max_tokens',stop_sequence:null},usage:{output_tokens:4}},
      {type:'message_stop'},
    ]
    const wire=frames.map(frame=>(provider==='anthropic'?'event: '+(frame as {type:string}).type+'\n':'')+'data: '+JSON.stringify(frame)+'\n\n').join('')+(provider==='openai'?'data: [DONE]\n\n':'')
    vi.stubGlobal('fetch',vi.fn(async()=>new Response(wire,{headers:{'content-type':'text/event-stream'}})))
    const adapter=provider==='openai'?new OpenAIAdapter('test-model','fake-key','http://model.invalid'):new AnthropicAdapter('claude-test','fake-key','http://model.invalid',{'X-Access-Token':'fake'})
    const events:LLMRequestAttemptEvent[]=[]
    const chunks=await consume(adapter,new AbortController().signal,events)
    expect(chunks.at(-1)).toMatchObject({done:true,finishReason:'length',promptTokens:10,completionTokens:4})
    expect(events.at(-1)).toMatchObject({type:'finish',usage:{promptTokens:10,completionTokens:4}})
    if(provider==='anthropic') expect(events.at(-1)).toMatchObject({usage:{cacheHitTokens:5,cacheWriteTokens:2}})
  })

  it('collects a fragmented Ollama stream and closes its attempt before publishing done', async()=>{
    const encoder=new TextEncoder()
    vi.stubGlobal('fetch',vi.fn(async()=>new Response(new ReadableStream<Uint8Array>({start(controller){
      controller.enqueue(encoder.encode('{"model":"local","message":{"content":"ok"},"done":false}\n{"mo'))
      controller.enqueue(encoder.encode('del":"local","done":true,"prompt_eval_count":3,"eval_count":2}\n'))
      controller.close()
    }}))))
    const events:LLMRequestAttemptEvent[]=[]
    const chunks=await consume(new OllamaAdapter('local'),new AbortController().signal,events)
    expect(chunks.map(chunk=>chunk.content).filter(Boolean)).toEqual(['ok'])
    expect(events[1]).toMatchObject({outcome:'succeeded',usage:{promptTokens:3,completionTokens:2}})
    expect(chunks.at(-1)).toMatchObject({done:true,promptTokens:3,completionTokens:2})
  })
})


describe('stream retry boundary', () => {
  it('retries a 429 before the first delta and accounts for both physical attempts', async () => {
    const wire = 'data: ' + JSON.stringify({id:'m',choices:[{index:0,delta:{content:'done'},finish_reason:null}]}) + '\n\n'
      + 'data: ' + JSON.stringify({id:'m',choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:4,completion_tokens:2}}) + '\n\ndata: [DONE]\n\n'
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({error:{message:'rate limit',type:'rate_limit_error'}}),{status:429,headers:{'content-type':'application/json'}}))
      .mockResolvedValueOnce(new Response(wire,{headers:{'content-type':'text/event-stream'}}))
    vi.stubGlobal('fetch',fetchMock)
    const events:LLMRequestAttemptEvent[]=[]
    const adapter = new RetryingAdapter(new OpenAIAdapter('test-model','fake-key','http://model.invalid'),{maxRetries:2,baseDelayMs:1,maxDelayMs:1})
    const chunks = await consume(adapter,new AbortController().signal,events)
    expect(chunks.map(chunk=>chunk.content).join('')).toBe('done')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(events.map(event=>event.type)).toEqual(['start','finish','start','finish'])
    expect(events[0].requestAttemptId).not.toBe(events[2].requestAttemptId)
    expect(events[1]).toMatchObject({outcome:'failed'})
    expect(events[3]).toMatchObject({outcome:'succeeded',usage:{promptTokens:4,completionTokens:2}})
  })

  it('does not replay a stream after partial output, even on a retryable error', async () => {
    const stream = vi.fn(async function* () {
      yield {content:'partial',done:false}
      throw Object.assign(new Error('connection reset'),{code:'ECONNRESET'})
    })
    const adapter = new RetryingAdapter({provider:'test',model:'test',countTokens:()=>1,complete:vi.fn(),stream},{maxRetries:2,baseDelayMs:1,maxDelayMs:1})
    const chunks:LLMStreamChunk[]=[]
    const pending=(async()=>{for await(const chunk of adapter.stream(messages)) chunks.push(chunk)})()
    await expect(pending).rejects.toThrow('connection reset')
    expect(stream).toHaveBeenCalledTimes(1)
    expect(chunks).toEqual([{content:'partial',done:false}])
  })

  it('does not retry a 400 stream body error', async () => {
    const fetchMock=vi.fn(async()=>new Response(JSON.stringify({error:{message:'Request 512 body format invalid',type:'invalid_request_error'}}),{status:400,headers:{'content-type':'application/json'}}))
    vi.stubGlobal('fetch',fetchMock)
    const events:LLMRequestAttemptEvent[]=[]
    const adapter = new RetryingAdapter(new OpenAIAdapter('test-model','fake-key','http://model.invalid'),{maxRetries:2,baseDelayMs:1,maxDelayMs:1})
    await expect(consume(adapter,new AbortController().signal,events)).rejects.toThrow('format invalid')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(events.map(event=>event.type)).toEqual(['start','finish'])
    expect(events[1]).toMatchObject({outcome:'failed'})
  })
})

type EstimateProvider = 'openai' | 'anthropic' | 'ollama'
type EstimateMode = 'complete' | 'stream'

/** The response stays tiny so reservation assertions measure the outgoing request, not usage. */
function estimateResponse(provider: EstimateProvider, mode: EstimateMode): Response {
  if (mode === 'complete') {
    const body = provider === 'openai'
      ? { id: 'estimate', choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1 } }
      : provider === 'anthropic'
        ? { id: 'estimate', type: 'message', role: 'assistant', model: 'claude-test', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 3, output_tokens: 1 } }
        : { model: 'local', message: { role: 'assistant', content: 'ok' }, done: true, prompt_eval_count: 3, eval_count: 1 }
    return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
  }
  if (provider === 'ollama') {
    return new Response(JSON.stringify({ model: 'local', message: { content: 'ok' }, done: true, prompt_eval_count: 3, eval_count: 1 }) + '\n')
  }
  const frames = provider === 'openai' ? [
    { id: 'estimate', choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: null }] },
    { id: 'estimate', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1 } },
  ] : [
    { type: 'message_start', message: { id: 'estimate', type: 'message', role: 'assistant', model: 'claude-test', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 3, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } },
    { type: 'message_stop' },
  ]
  const wire = frames.map(frame =>
    (provider === 'anthropic' ? `event: ${(frame as { type: string }).type}\n` : '') +
    `data: ${JSON.stringify(frame)}\n\n`,
  ).join('') + (provider === 'openai' ? 'data: [DONE]\n\n' : '')
  return new Response(wire, { headers: { 'content-type': 'text/event-stream' } })
}

function estimateAdapter(provider: EstimateProvider): LLMAdapter {
  if (provider === 'openai') return new OpenAIAdapter('test-model', 'fake-key', 'http://model.invalid')
  // SDK 0.20 normally binds node-fetch; this supported auth path forwards through the stubbed global fetch.
  if (provider === 'anthropic') return new AnthropicAdapter('claude-test', 'fake-key', 'http://model.invalid', { 'X-Access-Token': 'fake-token' })
  return new OllamaAdapter('local', 'http://model.invalid')
}

const largeSystemPrompt = 'SERIALIZED_SYSTEM_INPUT: follow the project instructions carefully. '.repeat(400)
const largeTool = {
  name: 'inspect_project',
  description: 'Inspect the requested project without changing files.',
  parameters: {
    type: 'object',
    properties: Object.fromEntries(Array.from({ length: 24 }, (_, index) => [
      `scope_${index}`,
      { type: 'string', description: `SERIALIZED_TOOL_SCHEMA_${index}: path constraints and expected evidence. `.repeat(32) },
    ])),
  },
  execute: async () => ({ success: true, output: 'This fixture tool must not execute' }),
}

/** The budget concerns model input, independently of transport flags and output-token limits. */
function serializedInputEstimate(body: Record<string, unknown>): number {
  return estimateTokens(JSON.stringify({ messages: body.messages, tools: body.tools, system: body.system }))
}

async function collectEstimateRequests(provider: EstimateProvider, mode: EstimateMode, options: Partial<LLMAdapterOptions>) {
  const bodies: Array<Record<string, unknown>> = []
  const events: LLMRequestAttemptEvent[] = []
  const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
    if (typeof init?.body !== 'string') throw new Error('Expected serialized JSON request body')
    bodies.push(JSON.parse(init.body) as Record<string, unknown>)
    return estimateResponse(provider, mode)
  })
  vi.stubGlobal('fetch', fetchMock)
  const adapter = estimateAdapter(provider)
  // Both bounds matter: a caller's small estimate cannot omit serialized input; a larger one is conservative.
  for (const callerEstimate of [1, 200_000]) {
    const requestOptions: LLMAdapterOptions = {
      model: adapter.model, systemPrompt: largeSystemPrompt, tools: [largeTool],
      ...options, requestInputTokenEstimate: callerEstimate,
      onRequestAttempt: event => { events.push(event) },
    }
    if (mode === 'complete') await adapter.complete(messages, requestOptions)
    else for await (const _chunk of adapter.stream(messages, requestOptions)) { /* consume the real SDK stream */ }
  }
  expect(fetchMock).toHaveBeenCalledTimes(2)
  const starts = events.filter(event => event.type === 'start')
  expect(starts).toHaveLength(2)
  expect(starts[0].estimatedInputTokens).toBeGreaterThanOrEqual(serializedInputEstimate(bodies[0]))
  expect(serializedInputEstimate(bodies[1])).toBeLessThan(200_000)
  expect(starts[1].estimatedInputTokens, 'Preserve a larger caller reservation instead of overwriting it').toBe(200_000)
  return bodies
}

describe('physical request input reservations', () => {
  it.each([
    ['openai', 'complete'], ['openai', 'stream'],
    ['anthropic', 'complete'], ['anthropic', 'stream'],
    ['ollama', 'complete'], ['ollama', 'stream'],
  ] as const)('%s %s includes serialized system/tool input and preserves the larger caller estimate', async (provider, mode) => {
    const bodies = await collectEstimateRequests(provider, mode, {})
    for (const body of bodies) {
      if (provider === 'anthropic') {
        expect(body.system).toBe(largeSystemPrompt)
      } else {
        expect(body.messages).toEqual(expect.arrayContaining([{ role: 'system', content: largeSystemPrompt }]))
      }
      if (provider !== 'ollama') {
        expect(JSON.stringify(body.tools)).toContain('SERIALIZED_TOOL_SCHEMA_23')
        // Large schemas ensure counting only messages cannot accidentally pass through rounding/slack.
        expect(serializedInputEstimate(body)).toBeGreaterThan(estimateTokens(JSON.stringify(body.messages)) + 5_000)
      }
    }
  })

  it.each(['complete', 'stream'] as const)('ollama %s estimates the actual input after thinkingConfig overrides', async mode => {
    const overriddenMessages = [
      { role: 'system', content: `OVERRIDDEN_SYSTEM: ${largeSystemPrompt}` },
      { role: 'user', content: 'OVERRIDDEN_USER_INPUT: '.repeat(500) },
    ]
    const overriddenTools = [{ type: 'function', function: {
      name: largeTool.name, description: largeTool.description, parameters: largeTool.parameters,
    } }]
    const system = 'OVERRIDDEN_TOP_LEVEL_SYSTEM: '.repeat(400)
    const bodies = await collectEstimateRequests('ollama', mode, {
      thinkingConfig: { messages: overriddenMessages, tools: overriddenTools, system },
    })
    for (const body of bodies) {
      expect(body.messages).toEqual(overriddenMessages)
      expect(body.tools).toEqual(overriddenTools)
      expect(body.system).toBe(system)
    }
  })
})
