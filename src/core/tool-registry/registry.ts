import type { Tool, IToolRegistry, AgentContext, ToolResult, JSONSchema, Message } from '../agent-context/index.js'
import { DuplicateToolError, ToolNotFoundError } from '../agent-context/index.js'
import { getGlobalToolPool } from '../utils/concurrency-pool.js'
import { bypassesOrdinaryToolPool, preflightTool, toolExecutionMode, isTrustedBuiltinTool } from '../../security/tool-policy.js'
import { CORE_MODEL_TOOLS, loadModelTools, loadToolsTool, selectRequestTools } from '../../tools/model-tool-loading.js'

export class ToolRegistry implements IToolRegistry {
  private tools = new Map<string, Tool>()
  private modelDefinitions = new Map<string, Pick<Tool, 'description' | 'parameters'>>()
  private loadedModelTools = new Set<string>()
  private registrationVersions = new Map<string, number>()
  private nextRegistrationVersion = 0
  private invalidatedModelHistory = new Set<string>()

  constructor(private readonly canRegister?: (tool: Tool) => boolean) {}

  register(tool: Tool, modelDefinition?: Pick<Tool, 'description' | 'parameters'>): void {
    // Enforce capability selection at insertion, including dynamically loaded registrations.
    if (this.canRegister && !this.canRegister(tool)) return
    if (this.tools.has(tool.name)) {
      throw new DuplicateToolError(tool.name)
    }
    this.tools.set(tool.name, tool)
    this.registrationVersions.set(tool.name, ++this.nextRegistrationVersion)
    if (modelDefinition) this.modelDefinitions.set(tool.name, modelDefinition)
  }

  unregister(name: string): void {
    if (this.tools.has(name)) this.invalidatedModelHistory.add(name)
    this.tools.delete(name)
    this.modelDefinitions.delete(name)
    this.loadedModelTools.delete(name)
    this.registrationVersions.delete(name)
  }

  has(name: string): boolean {
    return this.tools.has(name)
  }

  list(): Array<{ name: string; displayName?: string; description: string; parameters: JSONSchema; source?: string; outputSchema?: JSONSchema }> {
    return Array.from(this.tools.values()).map((tool) => ({
      name: tool.name,
      displayName: tool.displayName,
      description: tool.description,
      parameters: tool.parameters,
      source: tool.source,
      ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
    }))
  }

  listForModel(): ReturnType<IToolRegistry['list']> {
    return this.list().map(tool => {
      const definition = this.modelDefinitions.get(tool.name)
      return definition ? { ...tool, ...definition } : tool
    })
  }

  modelToolLoadingCandidates(): string[] {
    return [...this.modelDefinitions.keys()].filter(name => this.tools.has(name) && !CORE_MODEL_TOOLS.has(name))
  }

  listForRequest(history: readonly Message[] = []): ReturnType<IToolRegistry['list']> {
    return selectRequestTools(this.listForModel(), new Set(this.modelToolLoadingCandidates()), this.loadedModelTools, history, this.hasModelToolLoader(), this.invalidatedModelHistory)
  }

  loadForModel(names: readonly string[]): string[] {
    if (!this.hasModelToolLoader()) throw new Error('This registry has no trusted model tool loader')
    return loadModelTools(this.listForModel(), this.loadedModelTools, names)
  }

  hasModelToolLoader(): boolean { return this.tools.get('load_tools') === loadToolsTool }

  supportsHistoryProjection(name: string): boolean {
    const tool = this.tools.get(name)
    return Boolean(tool && ['write_file', 'office_document', 'search_history'].includes(name) && isTrustedBuiltinTool(tool))
  }

  supportsOfficeEvidence(name: string): boolean {
    const tool = this.tools.get(name)
    return Boolean(tool && ['office_document', 'office_inspect', 'workbench_render'].includes(name) && isTrustedBuiltinTool(tool))
  }

  supportsScreenshotEvidence(name: string): boolean {
    const tool = this.tools.get(name)
    return Boolean(tool && name === 'browser_save_screenshot' && isTrustedBuiltinTool(tool))
  }

  modelToolRegistrationVersion(name: string): number | undefined { return this.registrationVersions.get(name) }

  async execute(name: string, args: unknown, ctx: AgentContext): Promise<ToolResult> {
    const tool = this.tools.get(name)
    if (!tool) {
      throw new ToolNotFoundError(name)
    }
    const blocked = await this.preflight(name, args, ctx)
    if (blocked) return blocked
    // subagent 是长时间运行的编排调用，而且它内部的工具执行还要再走这个池。
    // 若把子代理本身也放进池里，一轮并发派发 N 个子代理就会占满池槽位，
    // 它们的内层工具永远排不到队 —— 互相等待形成死锁。因此子代理自身不占池，
    // 内层工具照旧受限流保护。
    if (bypassesOrdinaryToolPool(tool)) {
      return tool.execute(args, ctx)
    }
    // 全局并发池：防止大量并发调用把服务器打爆
    const pool = getGlobalToolPool()
    return pool(async () => {
      const latest = await this.preflight(name, args, ctx)
      return latest ?? tool.execute(args, ctx)
    }, ctx.signal)
  }

  async preflight(name: string, args: unknown, ctx: AgentContext): Promise<ToolResult | undefined> {
    const tool = this.tools.get(name)
    if (!tool) throw new ToolNotFoundError(name)
    return preflightTool(tool, args, ctx)
  }

  executionMode(name: string, _args: unknown): 'readonly' | 'subagent' | 'serial' {
    const tool = this.tools.get(name)
    return tool ? toolExecutionMode(tool) : 'serial'
  }
}
