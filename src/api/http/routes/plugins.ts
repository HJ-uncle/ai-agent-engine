import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { PluginService } from '../../../plugins/service.js'
import { PluginImporter, type PluginImportInput } from '../../../plugins/importer.js'
import { previewPluginImportBatch, type PluginBatchImportInput } from '../../../plugins/batch-import.js'
import { assertPluginManagementAccess } from '../../../plugins/access.js'
import { pluginSummary } from '../../../plugins/catalogue.js'
import { runPlugin } from '../../../plugins/runtime.js'
import { getPluginTemplate, listPluginTemplates, PLUGIN_TEMPLATE_PROTOCOL } from '../../../plugins/templates.js'
import { exportPluginArchive } from '../../../plugins/project.js'
import { getPluginApplication, invokePluginApplication } from '../../../plugins/application.js'
import { PLUGIN_CONTRIBUTION_CATALOGUE } from '../../../plugins/contributions.js'
import { PluginError } from '../../../plugins/types.js'
import { PLUGIN_CAPABILITY_CATALOGUE, pluginCapabilityIdSchema } from '../../../plugins/capabilities.js'
import { assertCapability, capabilityCallSchema, invokePluginCapability, publishedCapabilityAccess, streamPluginCapability, type CapabilityAccess, type PluginExecutionContext } from '../../../plugins/capability-runtime.js'
import { closeDevPlugin, closeAllDevPlugins, devCapabilityAccess, getDevPlugin, invokeDevPlugin, invokeDevPluginCapability, streamDevPluginCapability, openDevPlugin, refreshDevPlugin, setDevPluginPermissionGrants } from '../../../plugins/dev-session.js'
import type { CreatePluginInput, UpdatePluginInput } from '../../../plugins/types.js'
import type { AuthContext } from '../../../auth/types.js'
import { fail, success } from '../response.js'
import { browserAuthorityFromRequest, canUseDesktopSessionFullAccess, controllerSubjectFromRequest } from '../middleware.js'
import { browserPrincipalFromAuth } from '../../../core/browser-execution.js'
import { closePluginAgents, discoverPluginAgentTools, respondPluginAgent } from '../../../plugins/agent-capability.js'
import { setDevPluginAgentDisabledTools } from '../../../plugins/dev-session.js'
import { pluginHostContextSchema } from '../../../plugins/host-context.js'
import { PluginLifecycleRuntime, pluginHostEventSchema } from '../../../plugins/lifecycle-runtime.js'
import { PluginBackgroundScheduler } from '../../../plugins/background-runtime.js'
import { PluginCatalogueStream } from '../../../plugins/catalogue-stream.js'
import { PluginCapabilityHttpStreams } from '../plugin-capability-stream.js'

function tenant(request: FastifyRequest): string {
  const principal = (request as FastifyRequest & { authContext?: AuthContext }).authContext
  const id = principal?.tenantId ?? 'default'
  assertPluginManagementAccess(id, principal)
  return id
}
function assertDevPluginApi(request: FastifyRequest): string {
  const tid = tenant(request)
  if (!canUseDesktopSessionFullAccess(request)) throw new PluginError('PLUGIN_DEV_DISABLED', '本地插件开发需要当前桌面实例的已登录本地管理员', 403)
  return tid
}
function trustedPluginExecution(request: FastifyRequest): PluginExecutionContext {
  const principal = (request as FastifyRequest & { authContext?: AuthContext }).authContext
  return { browserAuthority: browserAuthorityFromRequest(request), browserPrincipal: browserPrincipalFromAuth(principal),
    controllerSubject: controllerSubjectFromRequest(request) }
}
function assertPluginAgentHost(request: FastifyRequest): { tenantId: string; execution: PluginExecutionContext } {
  const tenantId = tenant(request), execution = trustedPluginExecution(request)
  // The ordinary authenticated host or a verified owned local instance controls
  // approvals. iframe/Node SDK calls never carry this server-created identity.
  if (!execution.controllerSubject || !execution.browserAuthority)
    throw new PluginError('PLUGIN_AGENT_HOST_REQUIRED', '请在当前宿主窗口回答插件 Agent 的请求', 403)
  return { tenantId, execution }
}
const agentResponseBody = z.object({ requestId: z.string().min(1), toolCallId: z.string().min(1), output: z.string(), sessionId: z.string().min(1).max(256) })
export async function pluginRoutes(app: FastifyInstance) {
  const service = new PluginService(), importer = new PluginImporter(service)
  const capabilityStreams = new PluginCapabilityHttpStreams()
  app.addHook('preClose', async () => { await capabilityStreams.close() })
  const catalogueStream = new PluginCatalogueStream(service.rootDir)
  app.addHook('preClose', async () => { catalogueStream.close() })
  const lifecycle = new PluginLifecycleRuntime(service), background = new PluginBackgroundScheduler(service)
  app.addHook('onReady', async () => { await lifecycle.start(); await background.start() })
  app.addHook('preClose', async () => { await background.stop(); await lifecycle.stop() })
  app.addHook('preClose', closeAllDevPlugins)
  app.addHook('preClose', closePluginAgents)
  const idParams = z.object({ id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,47}$/) })
  const pluginId = (request: FastifyRequest) => idParams.parse(request.params).id
  const jobId = (request: FastifyRequest) => z.object({ jobId: z.string().min(1).max(100) }).parse(request.params).jobId
  app.get('/plugins', async request => success({ plugins: (await service.list(tenant(request))).map(pluginSummary) }))
  app.get('/plugins/runtime/changes', async (request, reply) => { catalogueStream.open(request, reply, tenant(request)) })
  // Three segments preserve every valid plugin ID (including "templates" and
  // "project") at /plugins/:id without reserving or migrating existing IDs.
  app.get('/plugins/project/templates', async request => { tenant(request); return success({ templates: listPluginTemplates(), protocol: PLUGIN_TEMPLATE_PROTOCOL, contributions: PLUGIN_CONTRIBUTION_CATALOGUE }) })
  app.get('/plugins/project/capabilities', async request => { tenant(request); return success({ catalogue: PLUGIN_CAPABILITY_CATALOGUE }) })
  app.get('/plugins/runtime/background', async request => success(await background.status(tenant(request))))
  app.post('/plugins/runtime/events', async request => {
    const tid = assertDevPluginApi(request)
    return success(await lifecycle.dispatch(tid, pluginHostEventSchema.parse(request.body)))
  })
  app.post('/plugins/:id/capabilities/invoke', async (request, reply) => {
    const tid = tenant(request), id = pluginId(request), input = capabilityCallSchema.parse(request.body)
    const abort = new AbortController(), onAbort = () => abort.abort(), onClose = () => { if (!reply.raw.writableEnded) abort.abort() }
    request.raw.once('aborted', onAbort); reply.raw.once('close', onClose)
    try { return success({ result: await invokePluginCapability(await publishedCapabilityAccess(service, tid, id, input.expectedRevision), tid, input, abort.signal, trustedPluginExecution(request)) }) }
    finally { request.raw.off('aborted', onAbort); reply.raw.off('close', onClose) }
  })
  app.post('/plugins/:id/capabilities/stream', async (request, reply) => {
    const tid = tenant(request), id = pluginId(request), input = capabilityCallSchema.parse(request.body)
    const access = await publishedCapabilityAccess(service, tid, id, input.expectedRevision)
    assertCapability(access, input.capability, input.expectedRevision)
    return capabilityStreams.open(request, reply, (onEvent, signal) => streamPluginCapability(access, tid, input, onEvent, signal, trustedPluginExecution(request)))
  })
  app.get('/plugins/project/templates/:id', async request => { tenant(request); return success({ template: getPluginTemplate(pluginId(request)) }) })
  app.post('/plugins/dev/open', async request => {
    const tid = assertDevPluginApi(request)
    const input = z.object({ path: z.string().min(1).max(4096), watch: z.boolean().optional() }).strict().parse(request.body)
    return success(openDevPlugin(tid, input.path, input.watch))
  })
  app.get('/plugins/dev/:id', async request => {
    const tid = assertDevPluginApi(request)
    const id = z.object({ id: z.string().uuid() }).parse(request.params).id
    return success(getDevPlugin(tid, id))
  })
  app.post('/plugins/dev/:id/refresh', async request => {
    const tid = assertDevPluginApi(request)
    const id = z.object({ id: z.string().uuid() }).parse(request.params).id
    return success(refreshDevPlugin(tid, id))
  })
  app.put('/plugins/dev/:id/permissions', async request => {
    const tid = assertDevPluginApi(request), id = z.object({ id: z.string().uuid() }).parse(request.params).id
    const input = z.object({ grants: z.array(pluginCapabilityIdSchema).max(32), revision: z.number().int().positive(), hash: z.string().min(1).max(100) }).strict().parse(request.body)
    return success({ session: setDevPluginPermissionGrants(tid, id, input.grants, input) })
  })
  app.get('/plugins/dev/:id/agent-tools', async request => {
    const tid = assertDevPluginApi(request), id = z.object({ id: z.string().uuid() }).parse(request.params).id
    const session = getDevPlugin(tid, id)
    return success(await discoverPluginAgentTools(devCapabilityAccess(tid, id, session), tid, {}, undefined, true))
  })
  app.put('/plugins/dev/:id/agent-tools', async request => {
    const tid = assertDevPluginApi(request), id = z.object({ id: z.string().uuid() }).parse(request.params).id
    const input = z.object({ disabledTools: z.array(z.string().min(1)), revision: z.number().int().positive(), hash: z.string().min(1) }).strict().parse(request.body)
    return success({ session: setDevPluginAgentDisabledTools(tid, id, input.disabledTools, input) })
  })
  app.post('/plugins/dev/:id/agents/:runId/respond', async (request, reply) => {
    assertDevPluginApi(request)
    const { tenantId: tid, execution } = assertPluginAgentHost(request)
    const { id, runId } = z.object({ id: z.string().uuid(), runId: z.string().min(1) }).parse(request.params)
    const parsed = agentResponseBody.extend({ revision: z.number().int().positive(), hash: z.string().min(1) }).strict().safeParse(request.body)
    if (!parsed.success) throw new PluginError('PLUGIN_AGENT_RESPONSE', '回答只允许原请求标识、回答内容、会话和当前插件版本', 400)
    const input = parsed.data
    const access = devCapabilityAccess(tid, id, input)
    assertCapability(access, 'agents.manage', input.revision)
    return capabilityStreams.open(request, reply, async (onEvent, signal) => {
      const result = await respondPluginAgent(access, tid, { runId, requestId: input.requestId, toolCallId: input.toolCallId, output: input.output },
        { ...execution, workspaceContext: { tenantId: tid, sessionId: input.sessionId }, onEvent }, signal)
      await onEvent({ type: 'complete', result })
      return result
    })
  })
  app.post('/plugins/dev/:id/capabilities/invoke', async (request, reply) => {
    const tid = assertDevPluginApi(request), id = z.object({ id: z.string().uuid() }).parse(request.params).id
    const { hash, ...input } = capabilityCallSchema.extend({ hash: z.string().min(1).max(100) }).parse(request.body)
    const abort = new AbortController(), onAbort = () => abort.abort(), onClose = () => { if (!reply.raw.writableEnded) abort.abort() }
    request.raw.once('aborted', onAbort); reply.raw.once('close', onClose)
    try { return success({ result: await invokeDevPluginCapability(tid, id, { revision: input.expectedRevision, hash }, input, abort.signal, trustedPluginExecution(request)) }) }
    finally { request.raw.off('aborted', onAbort); reply.raw.off('close', onClose) }
  })
  app.post('/plugins/dev/:id/capabilities/stream', async (request, reply) => {
    const tid = assertDevPluginApi(request), id = z.object({ id: z.string().uuid() }).parse(request.params).id
    const { hash, ...input } = capabilityCallSchema.extend({ hash: z.string().min(1).max(100) }).parse(request.body)
    const expected = { revision: input.expectedRevision, hash }
    assertCapability(devCapabilityAccess(tid, id, expected), input.capability, input.expectedRevision)
    return capabilityStreams.open(request, reply, (onEvent, signal) => streamDevPluginCapability(tid, id, expected, input, onEvent, signal, trustedPluginExecution(request)))
  })
  app.post('/plugins/dev/:id/invoke', async (request, reply) => {
    const tid = assertDevPluginApi(request)
    const id = z.object({ id: z.string().uuid() }).parse(request.params).id
    const input = z.object({ tool: z.string().min(1).max(32), args: z.record(z.unknown()), revision: z.number().int().positive(), hash: z.string().min(1).max(100), sessionId: z.string().min(1).max(256).optional(), hostContext: pluginHostContextSchema.optional() }).strict().parse(request.body)
    const abort = new AbortController(), onAbort = () => abort.abort(), onClose = () => { if (!reply.raw.writableEnded) abort.abort() }
    request.raw.once('aborted', onAbort); reply.raw.once('close', onClose)
    try { return success(await invokeDevPlugin(tid, id, input.tool, input.args, input, abort.signal, input.sessionId, input.hostContext, trustedPluginExecution(request))) }
    finally { request.raw.off('aborted', onAbort); reply.raw.off('close', onClose) }
  })
  app.delete('/plugins/dev/:id', async request => {
    const tid = assertDevPluginApi(request)
    const id = z.object({ id: z.string().uuid() }).parse(request.params).id
    await closeDevPlugin(tid, id); return success({ closed: true, devSessionId: id })
  })
  app.post('/plugins/dev/:id/close', async request => {
    const tid = assertDevPluginApi(request)
    const id = z.object({ id: z.string().uuid() }).parse(request.params).id
    await closeDevPlugin(tid, id); return success({ closed: true, devSessionId: id })
  })
  app.get('/plugins/runtime/apps/:id', async request => {
    const tid = tenant(request), id = pluginId(request)
    const query = z.object({ revision: z.coerce.number().int().positive().optional() }).strict().safeParse(request.query)
    if (!query.success) throw new PluginError('PLUGIN_ARGUMENTS', 'revision 必须为正整数，且不能包含其他查询参数')
    return success({ application: await getPluginApplication(service, tid, id, query.data.revision) })
  })
  app.post('/plugins/runtime/apps/:id/invoke', async (request, reply) => {
    const tid = tenant(request), id = pluginId(request)
    const input = z.object({ revision: z.number().int().positive(), tool: z.string().min(1).max(32), args: z.record(z.unknown()), sessionId: z.string().min(1).max(256).optional(), hostContext: pluginHostContextSchema.optional() }).strict().safeParse(request.body)
    if (!input.success) throw new PluginError('PLUGIN_ARGUMENTS', '运行参数需要 revision（正整数）、tool（本地工具名）和 args（对象），不能指定安全模式或工作目录')
    const abort = new AbortController()
    const onAbort = () => abort.abort()
    const onClose = () => { if (!reply.raw.writableEnded) abort.abort() }
    request.raw.once('aborted', onAbort); reply.raw.once('close', onClose)
    try { return success(await invokePluginApplication(service, tid, id, input.data.revision, input.data.tool, input.data.args, abort.signal, input.data.sessionId, input.data.hostContext, trustedPluginExecution(request))) }
    finally { request.raw.off('aborted', onAbort); reply.raw.off('close', onClose) }
  })
  app.get('/plugins/:id', async request => success({ plugin: await service.get(tenant(request), pluginId(request)) }))
  app.get('/plugins/project/exports/:id', async request => {
    const tid = tenant(request), id = pluginId(request)
    const query = z.object({ revision: z.coerce.number().int().positive().optional() }).strict().parse(request.query)
    const record = await service.get(tid, id)
    return success({ archive: exportPluginArchive(await service.snapshot(tid, id, query.revision ?? record.revision, { allowDraft: true })) })
  })
  app.post('/plugins', async request => success({ plugin: await service.create(tenant(request), request.body as CreatePluginInput) }))
  app.put('/plugins/:id', async request => success({ plugin: await service.update(tenant(request), pluginId(request), request.body as UpdatePluginInput) }))
  app.post('/plugins/:id/publish', async request => {
    const tid = tenant(request), input = z.object({ expectedRevision: z.number().int().positive() }).strict().parse(request.body)
    return success({ plugin: await service.publish(tid, pluginId(request), input.expectedRevision) })
  })
  app.patch('/plugins/:id', async request => {
    const tid = tenant(request), input = z.object({ enabled: z.boolean() }).strict().parse(request.body)
    return success({ plugin: await service.setEnabled(tid, pluginId(request), input.enabled) })
  })
  app.put('/plugins/:id/permissions', async request => {
    const tid = tenant(request), id = pluginId(request)
    const input = z.object({ grants: z.array(pluginCapabilityIdSchema).max(32), expectedRevision: z.number().int().positive().optional() }).strict().parse(request.body)
    return success({ plugin: await service.setPermissionGrants(tid, id, input.grants, input.expectedRevision) })
  })
  app.get('/plugins/:id/agent-tools', async request => {
    const tid = tenant(request), id = pluginId(request)
    // Management discovery never starts a model or executes a tool. Do not
    // manufacture grants merely to let users inspect an unpublished plugin.
    const read = async (): Promise<CapabilityAccess> => {
      const record = await service.get(tid, id)
      return { id, revision: record.revision, manifest: record.manifest,
        grants: record.permissionRevision === record.revision ? record.permissionGrants ?? [] : [],
        agentDisabledTools: record.agentDisabledTools, refresh: read,
        getSettings: () => service.getSettings(tid, id),
        setSettings: async () => { throw new PluginError('PLUGIN_AUTHORITY', '工具目录不能修改插件设置', 403) } }
    }
    return success(await discoverPluginAgentTools(await read(), tid, {}, undefined, true))
  })
  app.put('/plugins/:id/agent-tools', async request => {
    const tid = tenant(request), id = pluginId(request)
    const input = z.object({ disabledTools: z.array(z.string().min(1)), expectedRevision: z.number().int().positive() }).strict().parse(request.body)
    return success({ plugin: await service.setAgentDisabledTools(tid, id, input.disabledTools, input.expectedRevision) })
  })
  app.post('/plugins/:id/agents/:runId/respond', async (request, reply) => {
    const { tenantId: tid, execution } = assertPluginAgentHost(request), id = pluginId(request)
    const { runId } = z.object({ runId: z.string().min(1) }).parse(request.params)
    const parsed = agentResponseBody.extend({ expectedRevision: z.number().int().positive() }).strict().safeParse(request.body)
    if (!parsed.success) throw new PluginError('PLUGIN_AGENT_RESPONSE', '回答只允许原请求标识、回答内容、会话和当前插件版本', 400)
    const input = parsed.data
    const access = await publishedCapabilityAccess(service, tid, id, input.expectedRevision)
    assertCapability(access, 'agents.manage', input.expectedRevision)
    return capabilityStreams.open(request, reply, async (onEvent, signal) => {
      const result = await respondPluginAgent(access, tid, { runId, requestId: input.requestId, toolCallId: input.toolCallId, output: input.output },
        { ...execution, workspaceContext: { tenantId: tid, sessionId: input.sessionId }, onEvent }, signal)
      await onEvent({ type: 'complete', result })
      return result
    })
  })
  app.delete('/plugins/:id', async request => {
    const tid = tenant(request), id = pluginId(request)
    const parsed = z.object({ expectedRevision: z.number().int().positive() }).strict().optional().safeParse(request.body)
    if (!parsed.success) throw new PluginError('PLUGIN_DELETE_INPUT', '删除插件的 expectedRevision 必须为正整数', 400)
    await service.remove(tid, id, parsed.data?.expectedRevision)
    return success({ deleted: true })
  })
  app.post('/plugins/:id/test', async request => {
    const tid = tenant(request), id = pluginId(request)
    const input = z.object({ revision: z.number().int().positive().optional(), tool: z.string().min(1), args: z.record(z.unknown()), workspace: z.string().optional() }).strict().parse(request.body)
    const record = await service.get(tid, id)
    const abort = new AbortController()
    const onClose = () => abort.abort()
    request.raw.once('aborted', onClose)
    try { return success(await runPlugin(await service.snapshot(tid, id, input.revision ?? record.revision, { allowDraft: true }), input.tool, input.args, { signal: abort.signal, tenantId: tid })) }
    finally { request.raw.off('aborted', onClose) }
  })
  app.post('/plugins/imports/preview', async request => {
    const tid = tenant(request), raw = z.record(z.unknown()).parse(request.body)
    // UI has friendly source labels; AI and service use the same canonical import protocol.
    const input = raw.source === 'directory' ? { type: 'local', path: raw.path, format: raw.format }
      : raw.source === 'archive' ? { type: 'zip', base64: raw.archiveBase64, subdirectory: raw.subdir, format: raw.format }
      : raw.source === 'github' ? { type: 'github', repository: raw.url, ref: raw.ref, subdirectory: raw.subdir, format: raw.format }
      : raw
    try {
      const { files: _files, ...job } = await importer.previewImport(tid, input as PluginImportInput)
      return success({ import: job })
    } catch (error) {
      const preparedError = error as Error & { jobId?: string; importStatus?: string; statusCode?: number }
      if (preparedError.jobId && ['failed', 'cancelled'].includes(preparedError.importStatus ?? '')) return fail(preparedError.statusCode ?? 50000, preparedError.message, { import: { jobId: preparedError.jobId, status: preparedError.importStatus, error: preparedError.message } })
      throw error
    }
  })
  app.post('/plugins/imports/preview-batch', async (request, reply) => {
    const tid = tenant(request), abort = new AbortController()
    const onAbort = () => abort.abort()
    const onClose = () => { if (!reply.raw.writableEnded) abort.abort() }
    request.raw.once('aborted', onAbort); reply.raw.once('close', onClose)
    try { return success(await previewPluginImportBatch(importer, tid, request.body as PluginBatchImportInput, abort.signal)) }
    finally { request.raw.off('aborted', onAbort); reply.raw.off('close', onClose) }
  })
  app.get('/plugins/imports/:jobId', async request => {
    const { files: _files, ...job } = await importer.getImport(tenant(request), jobId(request))
    return success({ import: job })
  })
  app.post('/plugins/imports/:jobId/install', async request => success({ plugin: await importer.installImport(tenant(request), jobId(request)) }))
  app.delete('/plugins/imports/:jobId', async request => { await importer.cancelImport(tenant(request), jobId(request)); return success({ cancelled: true }) })
}
