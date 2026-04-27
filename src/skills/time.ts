import type { Tool, AgentContext, ToolResult } from '../core/agent-context/index.js'

export const timeSkill: Tool = {
  name: 'get_time',
  displayName: '获取时间',
  description: '获取当前时间，可指定时区和输出格式',
  parameters: {
    type: 'object',
    properties: {
      timezone: {
        type: 'string',
        description: 'IANA 时区名称，例如 "America/New_York"、"Asia/Shanghai"、"UTC"。默认值为 UTC',
        default: 'UTC',
      },
      format: {
        type: 'string',
        enum: ['iso', 'locale', 'unix'],
        description: '输出格式：iso（ISO 8601 格式）、locale（人类读取）、unix（时间戳）。默认值为 iso',
        default: 'iso',
      },
    },
    required: [],
  },
  async execute(rawArgs: unknown, _ctx: AgentContext): Promise<ToolResult> {
    const { timezone = 'UTC', format = 'iso' } = (rawArgs ?? {}) as { timezone?: string; format?: string }
    
    try {
      const now = new Date()
      let output: string

      switch (format) {
        case 'unix':
          output = String(Math.floor(now.getTime() / 1000))
          break
        case 'locale':
          output = now.toLocaleString('en-US', { timeZone: timezone })
          break
        case 'iso':
        default:
          output = now.toLocaleString('sv-SE', { 
            timeZone: timezone,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
          }).replace(' ', 'T') + ` (${timezone})`
      }

      return { success: true, output }
    } catch (err) {
      return {
        success: false,
        output: `Time error: ${err instanceof Error ? err.message : 'invalid timezone?'}`,
      }
    }
  },
}
