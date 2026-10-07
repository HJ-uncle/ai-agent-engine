import { applyThinkingPreference } from './thinking.js'
import { observeRequest, observeStreamRequest } from './request-attempt.js'
import type { RequestAttemptUsage } from './types.js'
import type { LLMAdapter, LLMResponse, LLMAdapterOptions, LLMStreamChunk } from './types.js'
import type { Message } from '../agent-context/index.js'
import { estimateTokens } from '../utils/tokens.js'

interface OllamaMessage {
  role: string
  content: string
}

export class OllamaAdapter implements LLMAdapter {
  readonly provider = 'ollama'
  private baseUrl: string

  constructor(readonly model: string = 'llama3.2', baseUrl?: string) {
    this.baseUrl = baseUrl || process.env.OLLAMA_BASE_URL || 'http://localhost:11434'
  }

  private toOllamaMessages(messages: Message[], systemPrompt?: string): OllamaMessage[] {
    const result: OllamaMessage[] = []
    if (systemPrompt) {
      result.push({ role: 'system', content: systemPrompt })
    }
    for (const msg of messages) {
      if (msg.role === 'tool') {
        result.push({ role: 'user', content: `Tool result: ${msg.content}` })
      } else {
        const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
        // Keep compacted history as conversation context, separate from the
        // system prompt (some Ollama templates only retain one system message).
        result.push(msg.role === 'system'
          ? { role: 'user', content: `[Historical context]\n${content}` }
          : { role: msg.role, content })
      }
    }
    return result
  }

  async complete(messages: Message[], options?: LLMAdapterOptions): Promise<LLMResponse> {
    options = applyThinkingPreference(options, this.provider, options?.model ?? this.model)
    const ollamaMessages = this.toOllamaMessages(messages, options?.systemPrompt)

    const requestBody: any = {
      model: options?.model ?? this.model,
      messages: ollamaMessages,
      stream: false,
      options: {
        temperature: options?.temperature,
        num_predict: options?.maxTokens,
      },
    }

    if (options?.thinkingConfig) {
      Object.assign(requestBody, options.thinkingConfig)
    }

    const data = await observeRequest(async () => {
      const response = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody), signal: options?.signal,
      })
      if (!response.ok) throw Object.assign(new Error(`Ollama API error: ${response.status} ${response.statusText}`), { status: response.status })
      return await response.json() as { model: string; message: { content: string }; prompt_eval_count?: number; eval_count?: number; done_reason?: string }
    }, { ...options, model: requestBody.model, requestInputTokenEstimate: Math.max(options?.requestInputTokenEstimate ?? 0, estimateTokens(JSON.stringify({ messages: requestBody.messages, tools: requestBody.tools, system: requestBody.system }))) }, this.provider, requestBody.model,
      data => data.prompt_eval_count === undefined && data.eval_count === undefined ? undefined : { promptTokens: data.prompt_eval_count ?? 0, completionTokens: data.eval_count ?? 0 })

    return {
      content: data.message.content,
      promptTokens: data.prompt_eval_count ?? 0,
      completionTokens: data.eval_count ?? 0,
      finishReason: data.done_reason === 'length' ? 'length' : 'stop',
      model: data.model,
    }
  }

  async *stream(messages: Message[], options?: LLMAdapterOptions): AsyncIterable<LLMStreamChunk> {
    options = applyThinkingPreference(options, this.provider, options?.model ?? this.model)
    const ollamaMessages = this.toOllamaMessages(messages, options?.systemPrompt)

    const requestBody: any = {
      model: options?.model ?? this.model,
      messages: ollamaMessages,
      stream: true,
      options: {
        temperature: options?.temperature,
        num_predict: options?.maxTokens,
      },
    }

    if (options?.thinkingConfig) {
      Object.assign(requestBody, options.thinkingConfig)
    }

    interface Frame { model: string; message?: { content?: string }; done?: boolean; done_reason?: string; prompt_eval_count?: number; eval_count?: number }
    const observed = await observeStreamRequest<Frame>(async () => {
      const response = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody), signal: options?.signal,
      })
      if (!response.ok) throw Object.assign(new Error(`Ollama API error: ${response.status}`), { status: response.status })
      if (!response.body) throw Object.assign(new Error('Ollama stream response has no body'), { code: 'INCOMPLETE_STREAM', retryable: true })
      const reader = response.body.getReader()
      return (async function* () {
        const decoder = new TextDecoder()
        let pending = ''
        try {
          while (true) {
            const { done, value } = await reader.read()
            pending += decoder.decode(value, { stream: !done })
            const lines = pending.split('\n')
            pending = lines.pop() ?? ''
            for (const line of lines) if (line.trim()) yield JSON.parse(line) as Frame
            if (done) { if (pending.trim()) yield JSON.parse(pending) as Frame; break }
          }
        } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
      })()
    }, { ...options, model: requestBody.model, requestInputTokenEstimate: Math.max(options?.requestInputTokenEstimate ?? 0, estimateTokens(JSON.stringify({ messages: requestBody.messages, tools: requestBody.tools, system: requestBody.system }))) }, this.provider, requestBody.model,
      (data): RequestAttemptUsage | undefined => data.prompt_eval_count === undefined && data.eval_count === undefined ? undefined : { promptTokens: data.prompt_eval_count ?? 0, completionTokens: data.eval_count ?? 0 },
      data => data.done === true)
    let terminal: Frame | undefined
    for await (const data of observed) {
      if (data.message?.content) yield { content: data.message.content, done: false }
      if (data.done) terminal = data
    }
    if (terminal) yield { done: true, finishReason: terminal.done_reason === 'length' ? 'length' : 'stop', promptTokens: terminal.prompt_eval_count ?? 0, completionTokens: terminal.eval_count ?? 0, model: terminal.model }
  }

  countTokens(content: string | any[]): number {
    return estimateTokens(content)
  }
}
