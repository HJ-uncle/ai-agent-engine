import type { Tool } from '../../core/agent-context/index.js'

export const askUserTool: Tool = {
  name: 'ask_user',
  displayName: '向用户提问',
  description: `向用户提问或确认操作，暂停等待回复。
IMPORTANT RULES for options:
1. You MUST provide at least 2 meaningful, specific options.
2. NEVER call this tool with only one option (e.g. only "其他" / "Other") — that is not a real choice and is forbidden.
3. Each option label must be a concrete, actionable choice. Generic options like "其他" or "继续" alone are not acceptable.
4. If you cannot think of at least 2 meaningful options, do NOT call this tool — instead ask the question as a follow-up in plain assistant text after completing the current task.`,
  parameters: {
    type: 'object',
    properties: {
      question: { type: 'string' },
      options: {
        type: 'array',
        description: 'Must contain at least 2 meaningful, specific options. Do NOT use only a single "其他/Other" option.',
        minItems: 2,
        items: {
          type: 'object',
          properties: {
            label: { type: 'string' },
            description: { type: 'string' },
          },
          required: ['label'],
        },
      },
      multiSelect: { type: 'boolean' },
    },
    required: ['question', 'options'],
  },
  execute: async (args) => {
    return {
      success: true,
      output: `提问请求已发出，等待用户选择。`,
    }
  },
}