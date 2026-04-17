import type { Tool, AgentContext, ToolResult } from '../core/agent-context/index.js'

// Safe math expression evaluator using Function constructor with restricted scope
function safeMath(expression: string): number {
  // Only allow safe characters: numbers, operators, parentheses, spaces, decimal points
  if (!/^[0-9+\-*/().\s%^]+$/.test(expression)) {
    throw new Error(`Invalid expression: contains disallowed characters`)
  }
  
  // Replace ^ with ** for exponentiation
  const normalized = expression.replace(/\^/g, '**')
  
  // Use Function with empty scope (no access to globals)
  const fn = new Function('return ' + normalized) as () => number
  const result = fn()
  
  if (!isFinite(result)) {
    throw new Error('Result is not finite (division by zero or overflow)')
  }
  
  return result
}

export const mathSkill: Tool = {
  name: 'calculate',
  description: 'Evaluate a mathematical expression. Supports +, -, *, /, (), %, ^ (power). Example: "2 + 3 * 4", "(10 / 2) ^ 2"',
  parameters: {
    type: 'object',
    properties: {
      expression: {
        type: 'string',
        description: 'The mathematical expression to evaluate',
      },
    },
    required: ['expression'],
  },
  async execute(rawArgs: unknown, _ctx: AgentContext): Promise<ToolResult> {
    const { expression } = rawArgs as { expression: string }
    try {
      const result = safeMath(expression)
      return {
        success: true,
        output: `${expression} = ${result}`,
      }
    } catch (err) {
      return {
        success: false,
        output: `Math error: ${err instanceof Error ? err.message : 'unknown error'}`,
      }
    }
  },
}
