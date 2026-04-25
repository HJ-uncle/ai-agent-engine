import path from 'node:path'
import fs from 'node:fs'
import type { AgentContext, CreateAgentContextOptions } from './types.js'

export function createAgentContext(options: CreateAgentContextOptions): AgentContext {
  const tenantId = options.tenantId ?? 'default'
  const workspaceRoot = process.env.WORKSPACE_ROOT ?? './workspace'
  const workspaceDir = path.resolve(workspaceRoot, tenantId, options.sessionId)

  // Auto-create workspace directory
  if (!fs.existsSync(workspaceDir)) {
    fs.mkdirSync(workspaceDir, { recursive: true })
  }

  return {
    tenantId,
    sessionId: options.sessionId,
    workspaceDir,
    tools: options.tools,
    memory: options.memory,
    history: options.history,
    logger: options.logger.child({ tenantId, sessionId: options.sessionId }),
    tokenBudget: options.tokenBudget ?? parseInt(process.env.TOKEN_BUDGET ?? '60000', 10),
    requestId: options.requestId,
    signal: options.signal,
  }
}
