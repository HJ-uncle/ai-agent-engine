import type { Tool } from '../../core/agent-context/index.js'

export const askUserTool: Tool = {
  name: 'ask_user',
  displayName: '向用户提问',
  description: '向用户提问或确认操作，暂停等待回复',
  parameters: {
    type: 'object',
    properties: {
      question: { type: 'string' },
      options: {
        type: 'array',
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