import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { PluginService } from '../../../plugins/service.js'
import { PluginImporter, type PluginImportInput } from '../../../plugins/importer.js'
import { assertPluginManagementAccess } from '../../../plugins/access.js'
import { pluginSummary } from '../../../plugins/catalogue.js'
import { runPlugin } from '../../../plugins/runtime.js'
import { getPluginTemplate, listPluginTemplates, PLUGIN_TEMPLATE_PROTOCOL } from '../../../plugins/templates.js'
import { exportPluginArchive } from '../../../plugins/project.js'
import { getPluginApplication, invokePluginApplication } from '../../../plugins/application.js'
import { PluginError } from '../../../plugins/types.js'
import type { CreatePluginInput, UpdatePluginInput } from '../../../plugins/types.js'
import type { AuthContext } from '../../../auth/types.js'
import { fail, success } from '../response.js'

function tenant(request: FastifyRequest): string {
  const principal = (request as FastifyRequest & { authContext?: AuthContext }).authContext
  const id = principal?.tenantId ?? 'default'
  assertPluginManagementAccess(id, principal)
  return id
}
export async function pluginRoutes(app: FastifyInstance) {
  const service = new PluginService(), importer = new PluginImporter(service)
  const idParams = z.object({ id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,47}$/) })
  const pluginId = (request: FastifyRequest) => idParams.parse(request.params).id
  const jobId = (request: FastifyRequest) => z.object({ jobId: z.string().min(1).max(100) }).parse(request.params).jobId
  app.get('/plugins', async request => success({ plugins: (await service.list(tenant(request))).map(pluginSummary) }))
  // Three segments preserve every valid plugin ID (including "templates" and
  // "project") at /plugins/:id without reserving or migrating existing IDs.
  app.get('/plugins/project/templates', async request => { tenant(request); return success({ templates: listPluginTemplates(), protocol: PLUGIN_TEMPLATE_PROTOCOL }) })
  app.get('/plugins/project/templates/:id', async request => { tenant(request); return success({ template: getPluginTemplate(pluginId(request)) }) })
  app.get('/plugins/runtime/apps/:id', async request => {
    const tid = tenant(request), id = pluginId(request)
    const query = z.object({ revision: z.coerce.number().int().positive().optional() }).strict().safeParse(request.query)
    if (!query.success) throw new PluginError('PLUGIN_ARGUMENTS', 'revision 必须为正整数，且不能包含其他查询参数')
    return success({ application: await getPluginApplication(service, tid, id, query.data.revision) })
  })
  app.post('/plugins/runtime/apps/:id/invoke', { bodyLimit: 1024 * 1024 }, async (request, reply) => {
    const tid = tenant(request), id = pluginId(request)
    const input = z.object({ revision: z.number().int().positive(), tool: z.string().min(1).max(32), args: z.record(z.unknown()) }).strict().safeParse(request.body)
    if (!input.success) throw new PluginError('PLUGIN_ARGUMENTS', '运行参数需要 revision（正整数）、tool（本地工具名）和 args（对象），不能指定安全模式或工作目录')
    const abort = new AbortController()
    const onAbort = () => abort.abort()
    const onClose = () => { if (!reply.raw.writableEnded) abort.abort() }
    request.raw.once('aborted', onAbort); reply.raw.once('close', onClose)
    try { return success(await invokePluginApplication(service, tid, id, input.data.revision, input.data.tool, input.data.args, abort.signal)) }
    finally { request.raw.off('aborted', onAbort); reply.raw.off('close', onClose) }
  })
  app.get('/plugins/:id', async request => success({ plugin: await service.get(tenant(request), pluginId(request)) }))
  app.get('/plugins/project/exports/:id', async request => {
    const tid = tenant(request), id = pluginId(request)
    const query = z.object({ revision: z.coerce.number().int().positive().optional() }).strict().parse(request.query)
    const record = await service.get(tid, id)
    return success({ archive: exportPluginArchive(await service.snapshot(tid, id, query.revision ?? record.revision, { allowDraft: true })) })
  })
  app.post('/plugins', { bodyLimit: 5 * 1024 * 1024 }, async request => success({ plugin: await service.create(tenant(request), request.body as CreatePluginInput) }))
  app.put('/plugins/:id', { bodyLimit: 5 * 1024 * 1024 }, async request => success({ plugin: await service.update(tenant(request), pluginId(request), request.body as UpdatePluginInput) }))
  app.post('/plugins/:id/publish', async request => {
    const tid = tenant(request), input = z.object({ expectedRevision: z.number().int().positive() }).strict().parse(request.body)
    return success({ plugin: await service.publish(tid, pluginId(request), input.expectedRevision) })
  })
  app.patch('/plugins/:id', async request => {
    const tid = tenant(request), input = z.object({ enabled: z.boolean() }).strict().parse(request.body)
    return success({ plugin: await service.setEnabled(tid, pluginId(request), input.enabled) })
  })
  app.delete('/plugins/:id', async request => { await service.remove(tenant(request), pluginId(request)); return success({ deleted: true }) })
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
  app.post('/plugins/imports/preview', { bodyLimit: 32 * 1024 * 1024 }, async request => {
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
  app.get('/plugins/imports/:jobId', async request => {
    const { files: _files, ...job } = await importer.getImport(tenant(request), jobId(request))
    return success({ import: job })
  })
  app.post('/plugins/imports/:jobId/install', async request => success({ plugin: await importer.installImport(tenant(request), jobId(request)) }))
  app.delete('/plugins/imports/:jobId', async request => { await importer.cancelImport(tenant(request), jobId(request)); return success({ cancelled: true }) })
}
