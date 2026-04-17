import type { LLMAdapter, LLMResponse, LLMAdapterOptions, LLMStreamChunk } from './types.js'
import type { Message } from '../agent-context/index.js'

interface OllamaMessage {
  role: string
  content: string
}

export class OllamaAdapter implements LLMAdapter {
  readonly provider = 'ollama'
  private baseUrl: string

  constructor(readonly model: string = 'llama3.2') {
    this.baseUrl = process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434'
  }

  private toOllamaMessages(messages: Message[], systemPrompt?: string): OllamaMessage[] {
    const result: OllamaMessage[] = []
    if (systemPrompt) {
      result.push({ role: 'system', content: systemPrompt })
    }
    for (const msg of messages) {
      if (msg.role === 'tool') {
        result.push({ role: 'user', content: `Tool result: ${msg.content}` })
      } else if (msg.role !== 'system') {
        result.push({ role: msg.role, content: msg.content })
      }
    }
    return result
  }

  async complete(messages: Message[], options?: LLMAdapterOptions): Promise<LLMResponse> {
    const ollamaMessages = this.toOllamaMessages(messages, options?.systemPrompt)

    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: options?.model ?? this.model,
        messages: ollamaMessages,
        stream: false,
        options: {
          temperature: options?.temperature,
          num_predict: options?.maxTokens,
        },
      }),
    })

    if (!response.ok) {
      throw new Error(`Ollama API error: ${response.status} ${response.statusText}`)
    }

    const data = await response.json() as {
      message: { content: string }
      prompt_eval_count?: number
      eval_count?: number
    }

    return {
      content: data.message.content,
      promptTokens: data.prompt_eval_count ?? 0,
      completionTokens: data.eval_count ?? 0,
      finishReason: 'stop',
    }
  }

  async *stream(messages: Message[], options?: LLMAdapterOptions): AsyncIterable<LLMStreamChunk> {
    const ollamaMessages = this.toOllamaMessages(messages, options?.systemPrompt)

    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: options?.model ?? this.model,
        messages: ollamaMessages,
        stream: true,
        options: {
          temperature: options?.temperature,
          num_predict: options?.maxTokens,
        },
      }),
    })

    if (!response.ok || !response.body) {
      throw new Error(`Ollama API error: ${response.status}`)
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        const text = decoder.decode(value)
        const lines = text.split('\n').filter(Boolean)

        for (const line of lines) {
          const data = JSON.parse(line) as {
            message?: { content?: string }
            done?: boolean
            prompt_eval_count?: number
            eval_count?: number
          }

          if (data.message?.content) {
            yield { content: data.message.content, done: false }
          }

          if (data.done) {
            yield {
              done: true,
              promptTokens: data.prompt_eval_count ?? 0,
              completionTokens: data.eval_count ?? 0,
            }
          }
        }
      }
    } finally {
      reader.releaseLock()
    }
  }

  countTokens(text: string): number {
    return Math.ceil(text.length / 4)
  }
}
