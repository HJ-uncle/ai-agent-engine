import type { Tool } from '../../core/agent-context/index.js'

export const askUserTool: Tool = {
  name: 'ask_user',
  displayName: '向用户提问',
  description: '当你需要向用户提问、澄清模糊意图、确认关键节点或提供操作建议时调用此工具。调用后系统会暂停并展示选择卡片，等待用户回复。',
  parameters: {
    type: 'object',
    properties: {
      question: {
        type: 'string',
        description: '你要向用户提出的问题或确认的话语',
      },
      options: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            label: { type: 'string', description: '选项的简短标题' },
            description: { type: 'string', description: '选项的详细说明或建议' },
          },
          required: ['label'],
        },
        description: '建议列表。尽量包含标准操作流程选项和个性化选项。',
      },
      multiSelect: {
        type: 'boolean',
        description: '是否允许多选',
      },
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
