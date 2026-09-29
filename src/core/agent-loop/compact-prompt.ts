/**
 * 上下文压缩 prompt（照抄 Claude Code auto-compact 的 6 段式结构）
 *
 * 来源：claude code CLI 2.1.266 二进制逆向。核心要点：
 * - 结构化分节：请求意图 / 技术概念 / 文件与代码段（含完整片段）/ 错误与修复 /
 *   问题解决 / 全部用户消息原文（安全相关逐字保留）
 * - 输出包在 <summary>...</summary> 里，解析时按标签提取
 * - temperature 0.3：摘要是事实性任务，不需要发散
 */
import type { Message } from '../agent-context/types.js'
import type { LLMAdapterOptions } from '../llm-adapter/types.js'

interface CompactLLM {
  complete?(messages: Message[], options?: any): Promise<unknown>
  chat?(messages: Message[], options?: any): Promise<unknown>
  model?: string
}

/** Claude Code 原版压缩 prompt（英文 6 段结构，照抄） */
export const COMPACT_PROMPT_TEMPLATE = `Your task is to create a detailed summary of the conversation so far, paying close attention to the user's explicit requests and your previous actions.
This summary should be thorough in capturing technical details, code patterns, and architectural decisions that would be essential for continuing development work without losing context.

Before providing your final summary, wrap your analysis in <analysis> tags to organize your thoughts and ensure you've covered all necessary points. In your analysis:
1. Chronologically analyze each message and section of the conversation. For each section thoroughly identify the user's explicit requests and intents, your approach to addressing them, key decisions, technical concepts and code patterns, file names and full code snippets, function signatures, file edits, errors encountered and how they were fixed, and user feedback.
2. Double-check for technical accuracy and completeness.

Your summary should include the following sections:
1. Primary Request and Intent: Capture all of the user's explicit requests and intents in detail.
2. Key Technical Concepts: List all important technical concepts, technologies, and frameworks discussed.
3. Files and Code Sections: Enumerate specific files and code sections examined, modified, or created. Include full code snippets where applicable.
4. Errors and fixes: List all errors encountered, and how they were resolved.
5. Problem Solving: Document problems solved and any ongoing troubleshooting efforts.
6. All user messages: List ALL user messages that are not tool results. Preserve security-relevant instructions verbatim.

Wrap your final summary in <summary> tags.

Here is the conversation to summarize:
`

/** 单条消息内容序列化上限（防超长输入把摘要调用自己打爆窗口） */
const PER_MESSAGE_CAP = 2000
/** 压缩输入总长度上限（字符）；超出时从头部继续截断 */
const TOTAL_INPUT_CAP = 120_000

function serializeMessage(m: Message): string {
  const text =
    typeof m.content === 'string'
      ? m.content
      : m.content
          .filter(
            (p): p is { type: string; text?: string } =>
              !!p && typeof p === 'object' && (p as { type?: string }).type === 'text',
          )
          .map((p) => p.text ?? '')
          .join('\n')
  const capped = text.length > PER_MESSAGE_CAP ? `${text.slice(0, PER_MESSAGE_CAP)}…[truncated]` : text
  return `[${m.role}]: ${capped}`
}

/** 从模型输出提取 <summary> 内容；无标签则取全文 */
export function extractSummary(output: string): string {
  const match = output.match(/<summary>([\s\S]*?)<\/summary>/)
  return (match?.[1] ?? output).trim()
}

/**
 * 构造压缩用的 summarizeFn：序列化消息 → 填 6 段模板 → 调 LLM → 提取 <summary>。
 * 供 react.ts 自动压缩与手动压缩端点共用，保证两条路径摘要质量一致。
 */
export function buildCompactSummarizeFn(llm: CompactLLM, options: Pick<LLMAdapterOptions, 'signal' | 'onRequestAttempt'> = {}): (messages: Message[]) => Promise<string> {
  return async (messages: Message[]): Promise<string> => {
    let serialized = messages.map(serializeMessage).join('\n\n')
    if (serialized.length > TOTAL_INPUT_CAP) {
      serialized = `...[earlier messages truncated]\n\n${serialized.slice(-TOTAL_INPUT_CAP)}`
    }
    const prompt: Message = { role: 'user', content: COMPACT_PROMPT_TEMPLATE + serialized }
    const invoke = llm.complete ?? llm.chat
    if (!invoke) throw new Error('LLM adapter has no complete/chat method')
    const raw = await invoke.call(llm, [prompt], { temperature: 0.3, ...options })
    const text =
      typeof raw === 'string'
        ? raw
        : typeof (raw as { content?: unknown })?.content === 'string'
          ? ((raw as { content: string }).content)
          : JSON.stringify(raw)
    return extractSummary(text)
  }
}
