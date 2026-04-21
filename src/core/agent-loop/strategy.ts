import type { AgentContext } from '../agent-context/index.js'

export interface LoopStrategy {
  /**
   * Run the agent loop to process the user's input.
   * If input is null, the strategy will proceed without adding a new user message.
   */
  run(input: string | null, ctx: AgentContext): AsyncIterable<string>
}
