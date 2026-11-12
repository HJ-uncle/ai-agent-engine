import { z } from 'zod'
import type { AgentContext, JSONSchema, Tool, ToolResult } from '../../core/agent-context/index.js'
import { workspaceManager } from '../../workspace/index.js'
import { createApprovedMutationTool } from '../management/approved-mutation.js'
import { McpManagementService, mcpScopeSchema, publicMcpError, type McpManagementAction, type McpManagementContext } from '../../storage/mcp/management-service.js'

function context(ctx: AgentContext): McpManagementContext {
  if (ctx.parentSessionId) throw new Error('MCP 管理仅供主代理使用')
  return { tenantId: ctx.tenantId, sessionId: ctx.sessionId, principal: ctx.managementPrincipal,
    projectRoot: workspaceManager.getWorkingDirectory(ctx), signal: ctx.signal }
}
const scope: JSONSchema = { type: 'string', enum: ['project', 'global'], description: '精确配置层；同名 project/global 分开管理。' }
const id: JSONSchema = { type: 'string', pattern: '^[a-z0-9][a-z0-9_-]{0,119}$', description: 'mcp_server_list 返回的完整服务器 ID。' }
const expectedRevision: JSONSchema = { type: 'string', pattern: '^sha256:[a-f0-9]{64}$', description: '最近 mcp_server_get/list 返回的配置版本。' }
const connection: Record<string, JSONSchema> = {
  name: { type: 'string', maxLength: 200 }, description: { type: 'string', maxLength: 2000 },
  transportType: { type: 'string', enum: ['stdio', 'sse', 'http', 'streamableHttp'] },
  command: { type: 'string', maxLength: 4096, description: 'stdio 可执行程序。' },
  args: { type: 'array', items: { type: 'string', maxLength: 4096 }, maxItems: 100, description: '新的启动参数；读取时仅返回参数数量，不能拿脱敏占位符覆盖原值。' },
  url: { type: 'string', maxLength: 8192, description: 'HTTP/SSE 连接地址。现有地址读取时脱敏；不要猜测或复制脱敏占位符。' },
  timeoutMs: { type: ['integer', 'null'], minimum: 0, maximum: 2147483647, description: '单次调用超时；0 无期限，null 恢复默认。连接测试仍有 15 秒上限。' },
  disabledTools: { type: 'array', items: { type: 'string', maxLength: 200 }, maxItems: 500 },
}
const parameters = (properties: Record<string, JSONSchema>, required: string[] = []): JSONSchema => ({ type: 'object', additionalProperties: false, properties, required })
const key = { id, scope, expectedRevision }
const specs: Array<{ action: McpManagementAction; name: string; description: string; schema: JSONSchema }> = [
  { action: 'create', name: '创建 MCP 服务器', description: '创建默认停用的持久 MCP 配置，不自动连接。env/headers 凭据请在设置页输入。配置管理独立于 Agent 的执行绑定。',
    schema: parameters({ id, scope, ...connection }, ['id', 'transportType']) },
  { action: 'update', name: '编辑 MCP 服务器', description: '局部修改精确作用域的配置；未提供的 env/headers/args/url 保留。切换传输类型时移除旧传输的连接字段。敏感配置不回显。',
    schema: parameters({ ...key, changes: parameters(connection) }, ['id', 'scope', 'expectedRevision', 'changes']) },
  { action: 'set_enabled', name: '启停 MCP 服务器', description: '启用或停用持久配置。启用后，后续允许该服务器的会话可能连接它；此操作不运行连接测试。',
    schema: parameters({ ...key, enabled: { type: 'boolean' } }, ['id', 'scope', 'expectedRevision', 'enabled']) },
  { action: 'delete', name: '删除 MCP 服务器', description: '删除精确作用域的服务器；保留其他配置。同名全局定义可能在项目覆盖删除后重新生效。',
    schema: parameters(key, ['id', 'scope', 'expectedRevision']) },
  { action: 'test', name: '测试 MCP 连接', description: '审批后连接并读取工具目录，可能启动 stdio 进程或发送网络请求。仅返回最多 50 个工具名，不调用业务工具，最后关闭连接。安全模式禁止测试。',
    schema: parameters(key, ['id', 'scope', 'expectedRevision']) },
]

export function createMcpManagementTools(service = new McpManagementService()): Tool[] {
  const read = (name: string, displayName: string, description: string, schema: JSONSchema,
    run: (raw: unknown, ctx: AgentContext) => unknown): Tool => ({ name, displayName, description, source: 'builtin', parameters: schema, executionMode: 'readonly',
      async execute(raw, ctx): Promise<ToolResult> {
        try { return { success: true, output: JSON.stringify(run(raw, ctx)) } }
        catch (error) { const safe = publicMcpError(error, ctx.signal); return { success: false, status: ctx.signal?.aborted ? 'cancelled' : 'failed', output: safe.message, error: safe.message } }
      } })
  return [
    read('mcp_server_list', 'MCP 管理目录', '列出项目和全局的独立配置，含停用项和精确版本；敏感连接数据脱敏。仅管理配置，Agent 的执行绑定不因此扩大。',
      parameters({ scope, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 100 } }), (raw, ctx) => {
        const input = z.object({ scope: mcpScopeSchema.optional(), offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(100).default(50) }).strict().parse(raw)
        const servers = service.list(context(ctx), input.scope)
        return { servers: servers.slice(input.offset, input.offset + input.limit), total: servers.length, offset: input.offset, hasMore: servers.length > input.offset + input.limit }
      }),
    read('mcp_server_get', 'MCP 管理详情', '读取精确作用域的脱敏配置和版本；env/headers 只显示键，args 只显示数量，URL 隐藏路径与凭据。', parameters({ id, scope }, ['id', 'scope']), (raw, ctx) => {
      const input = z.object({ id: z.string().min(1).max(120), scope: mcpScopeSchema }).strict().parse(raw)
      return service.get(context(ctx), input.id, input.scope)
    }),
    ...specs.map(spec => ({ ...createApprovedMutationTool({ name: `mcp_server_${spec.action}`, displayName: spec.name, description: spec.description, parameters: spec.schema,
      prepare: async (raw, ctx) => {
        try { return service.prepare(context(ctx), spec.action, raw) } catch (error) { throw publicMcpError(error, ctx.signal) }
      },
      preview: operation => ({ action: operation.action, id: operation.id, scope: operation.scope, configFile: operation.target,
        before: operation.before, after: operation.after, ...(operation.action === 'test' ? { notice: '将启动扩展或发送网络请求，只发现工具目录，不调用业务工具；15 秒内结束。' } : {}) }),
      apply: async (operation, ctx) => {
        try {
          if (operation.action !== spec.action) throw new Error('MCP approval action mismatch')
          const result = await service.apply(context(ctx), operation, ctx.resumeToolCall!.toolCall.args)
          return { success: true, status: 'succeeded', output: JSON.stringify(result), ...(result.resourceChange ? { metadata: { resourceChange: result.resourceChange } } : {}) }
        } catch (error) { throw publicMcpError(error, ctx.signal) }
      },
    }), source: 'builtin' as const })),
  ]
}
