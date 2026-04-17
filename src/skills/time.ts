import type { Tool, AgentContext, ToolResult } from '../core/agent-context/index.js'

export const timeSkill: Tool = {
  name: 'get_time',
  description: 'Get the current date and time, optionally in a specific timezone',
  parameters: {
    type: 'object',
    properties: {
      timezone: {
        type: 'string',
        description: 'IANA timezone name (e.g., "America/New_York", "Asia/Shanghai", "UTC"). Defaults to UTC.',
        default: 'UTC',
      },
      format: {
        type: 'string',
        enum: ['iso', 'locale', 'unix'],
        description: 'Output format: iso (ISO 8601), locale (human-readable), unix (timestamp). Defaults to iso.',
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
