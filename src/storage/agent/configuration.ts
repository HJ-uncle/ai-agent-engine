import { createHash } from 'node:crypto'
import type { Agent } from './index.js'

/** Version the full persisted configuration, including bindings changed within one SQL second. */
export function agentConfigurationRevision(agent: Agent): string {
  const bindings = (values: string[]) => [...values].sort()
  return createHash('sha256').update(JSON.stringify([
    agent.id, agent.tenantId, agent.createdAt, agent.updatedAt,
    agent.name, agent.description ?? '', agent.systemPrompt ?? '', agent.model ?? '', agent.temperature ?? null,
    bindings(agent.skills), bindings(agent.mcpServers), bindings(agent.knowledgeBases), bindings(agent.allowedTools),
  ])).digest('hex')
}

export class AgentConfigurationConflict extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AgentConfigurationConflict'
  }
}
