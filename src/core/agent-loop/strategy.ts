import type { AgentContext } from '../agent-context/index.js'

export interface LoopStrategy {
  run(input: string, ctx: AgentContext): AsyncIterable<string>
}
