import OpenAI from 'openai'
import type { LLMAdapter, LLMResponse, LLMAdapterOptions, LLMStreamChunk } from './types.js'
import type { Message, Tool } from '../agent-context/index.js'

/**
 * Convert Message[] to OpenAI format with orphan-filtering:
 * - Collect all valid tool_call IDs emitted by assistant messages
 * - Drop any tool-result messages whose tool_call_id has no matching assistant tool_call
 * This prevents "unexpected tool_use_id" errors from Claude-via-OpenAI-proxy adapters.
 */
function messagesToOpenAI(
  messages: Message[],
): OpenAI.Chat.ChatCompletionMessageParam[] {
  // First pass: collect all valid tool_call IDs (with non-empty id & name)
  const validToolCallIds = new Set<string>()
  for (const msg of messages) {
    if (msg.role === 'assistant' && msg.toolCall) {
      const id = msg.toolCall.id || ''
      const name = msg.toolCall.name || ''
      if (id && name) {
        validToolCallIds.add(id)
      }
    }
  }

  // Second pass: convert, dropping orphaned tool results
  const result: OpenAI.Chat.ChatCompletionMessageParam[] = []
  for (const msg of messages) {
    if (msg.role === 'tool') {
      const tcId = msg.toolCallId ?? ''
      // Drop orphaned tool results (no matching assistant tool_call)
      if (tcId && !validToolCallIds.has(tcId)) {
        continue
      }
      result.push({
        role: 'tool',
        tool_call_id: tcId,
        content: msg.content,
      })
      continue
    }
    if (msg.role === 'assistant' && msg.toolCall) {
      const id = msg.toolCall.id || ''
      const name = msg.toolCall.name || ''
      if (!id || !name) {
        // Broken tool_call record — emit as plain assistant text
        result.push({
          role: 'assistant',
          content: msg.content || '(no content)',
        })
        continue
      }
      result.push({
        role: 'assistant',
        content: msg.content ?? null,
        tool_calls: [{
          id,
          type: 'function',
          function: {
            name,
            arguments: JSON.stringify(msg.toolCall.args),
          },
        }],
      })
      continue
    }
    result.push({
      role: msg.role as 'user' | 'assistant' | 'system',
      content: msg.content,
    })
  }
  return result
}

function toolToOpenAI(tool: Tool): OpenAI.Chat.ChatCompletionTool {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters as Record<string, unknown>,
    },
  }
}

// ─── Qwen/vLLM fallback: parse <tool_call> XML from text content ─────────────
// Some OpenAI-compatible endpoints (Qwen, vLLM) emit tool calls as text blocks
// instead of structured tool_calls JSON. This parser handles that case.
interface ParsedToolCall {
  id: string
  name: string
  args: Record<string, unknown>
}

// Parameter-key → tool-name heuristics for when the model emits <function=> with empty name
const PARAM_TO_TOOL_HEURISTICS: Array<{ keys: string[]; tool: string }> = [
  { keys: ['command'],              tool: 'run_skill_script' },
  { keys: ['key', 'value'],         tool: 'remember' },
  { keys: ['key'],                  tool: 'recall' },
  { keys: ['path', 'content'],      tool: 'write_file' },
  { keys: ['path'],                 tool: 'read_file' },
  { keys: ['query'],                tool: 'search_memory' },
  { keys: ['name'],                 tool: 'get_skill' },
]

function inferToolName(args: Record<string, unknown>): string {
  const paramKeys = Object.keys(args)
  for (const { keys, tool } of PARAM_TO_TOOL_HEURISTICS) {
    if (keys.every((k) => paramKeys.includes(k))) return tool
  }
  // No params → list_skills
  if (paramKeys.length === 0) return 'list_skills'
  return ''
}

function parseXmlToolCalls(content: string): ParsedToolCall[] {
  const results: ParsedToolCall[] = []
  const blockRe = /<tool_call>([\s\S]*?)<\/tool_call>/g
  let blockMatch: RegExpExecArray | null

  while ((blockMatch = blockRe.exec(content)) !== null) {
    const block = blockMatch[1]

    // ① Try JSON format: {"name":"...","arguments":{...}}
    try {
      const json = JSON.parse(block.trim()) as { name?: string; arguments?: Record<string, unknown> }
      if (json.name) {
        results.push({
          id: `call_${Date.now()}_${results.length}`,
          name: json.name,
          args: json.arguments ?? {},
        })
        continue
      }
    } catch { /* not JSON */ }

    // ② XML format: <function=toolName> or <function=> (empty name)
    const fnMatch = /<function=([^>]*)>([\s\S]*?)<\/function>/.exec(block)
    if (fnMatch) {
      const rawName = fnMatch[1].trim()
      const body = fnMatch[2]
      const args: Record<string, unknown> = {}

      const paramRe = /<parameter=([^>]+)>([\s\S]*?)<\/parameter>/g
      let paramMatch: RegExpExecArray | null
      while ((paramMatch = paramRe.exec(body)) !== null) {
        const key = paramMatch[1].trim()
        const val = paramMatch[2].trim()
        try { args[key] = JSON.parse(val) } catch { args[key] = val }
      }

      // Use explicit name, or infer from parameters when name is empty
      const name = rawName || inferToolName(args)
      if (name) {
        results.push({ id: `call_${Date.now()}_${results.length}`, name, args })
      }
    }
  }

  return results
}

/** Strip <tool_call>...</tool_call> blocks from content */
function stripToolCallBlocks(content: string): string {
  return content.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '').trim()
}

export class OpenAIAdapter implements LLMAdapter {
  readonly provider = 'openai'
  private client: OpenAI

  constructor(readonly model: string = 'gpt-4o-mini') {
    this.client = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      baseURL: process.env.OPENAI_BASE_URL, // supports custom OpenAI-compatible endpoints
    })
  }

  async complete(messages: Message[], options?: LLMAdapterOptions): Promise<LLMResponse> {
    const oaiMessages = messagesToOpenAI(messages)
    if (options?.systemPrompt) {
      oaiMessages.unshift({ role: 'system', content: options.systemPrompt })
    }

    const params: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming = {
      model: options?.model ?? this.model,
      messages: oaiMessages,
      max_tokens: options?.maxTokens,
      temperature: options?.temperature,
    }

    if (options?.tools && options.tools.length > 0) {
      params.tools = options.tools.map(toolToOpenAI)
      params.tool_choice = 'auto'
    }

    const response = await this.client.chat.completions.create(params)
    const choice = response.choices[0]
    const message = choice.message

    // Primary: structured tool_calls from API
    let toolCalls = message.tool_calls?.map((tc) => ({
      id: tc.id,
      name: tc.function.name,
      args: JSON.parse(tc.function.arguments) as Record<string, unknown>,
    }))

    // Fallback: Qwen/vLLM may embed tool calls as <tool_call> XML in content
    const rawContent = message.content ?? ''
    if ((!toolCalls || toolCalls.length === 0) && rawContent.includes('<tool_call>')) {
      const xmlCalls = parseXmlToolCalls(rawContent)
      if (xmlCalls.length > 0) {
        toolCalls = xmlCalls
      }
    }

    // Strip <tool_call> blocks from visible content
    const cleanContent = toolCalls && toolCalls.length > 0
      ? stripToolCallBlocks(rawContent)
      : rawContent

    return {
      content: cleanContent,
      toolCalls,
      promptTokens: response.usage?.prompt_tokens ?? 0,
      completionTokens: response.usage?.completion_tokens ?? 0,
      finishReason: (choice.finish_reason === 'tool_calls' || (toolCalls && toolCalls.length > 0)
        ? 'tool_calls'
        : choice.finish_reason === 'length' ? 'length' : 'stop'),
    }
  }

  async *stream(messages: Message[], options?: LLMAdapterOptions): AsyncIterable<LLMStreamChunk> {
    const oaiMessages = messagesToOpenAI(messages)
    if (options?.systemPrompt) {
      oaiMessages.unshift({ role: 'system', content: options.systemPrompt })
    }

    const params: OpenAI.Chat.ChatCompletionCreateParamsStreaming = {
      model: options?.model ?? this.model,
      messages: oaiMessages,
      stream: true,
      max_tokens: options?.maxTokens,
      temperature: options?.temperature,
    }

    if (options?.tools && options.tools.length > 0) {
      params.tools = options.tools.map(toolToOpenAI)
    }

    // beta.chat.completions.stream provides the streaming helper with finalMessage()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const betaClient = this.client.beta as any
    const stream = betaClient.chat.completions.stream(params)

    for await (const chunk of stream) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const delta = (chunk as any).choices?.[0]?.delta
      if (!delta) continue

      if (delta.content) {
        yield { content: delta.content as string, done: false }
      }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const finalMessage = await (stream as any).finalMessage()
    yield {
      done: true,
      promptTokens: finalMessage?.usage?.prompt_tokens ?? 0,
      completionTokens: finalMessage?.usage?.completion_tokens ?? 0,
    }
  }

  countTokens(text: string): number {
    return Math.ceil(text.length / 4)
  }
}
