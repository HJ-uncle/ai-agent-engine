import type { FastifyInstance } from 'fastify'
import { success, fail } from '../response.js'
import { workspaceManager } from '../../../workspace/index.js'
import { getDb } from '../../../storage/sqlite/db.js'
import fs from 'node:fs'
import path from 'node:path'

export async function workspaceRoutes(fastify: FastifyInstance) {
  // GET /workspace/files
  // Returns a tree of files and directories in the current workspace
  fastify.get<{ Querystring: { sessionId?: string } }>('/workspace/files', async (request, reply) => {
    const tenantId = (request as any).authContext?.tenantId ?? 'default'
    const sessionId = request.query.sessionId || 'default'
    
    // Get the base path of the workspace
    const baseDir = workspaceManager.getPath({ tenantId, sessionId })
    if (!fs.existsSync(baseDir)) {
      return reply.code(200).send(success({ name: sessionId, type: 'dir', children: [] }))
    }

    function buildTree(dir: string, name: string): any {
      const stats = fs.statSync(dir)
      if (stats.isDirectory()) {
        const children = fs.readdirSync(dir)
          .filter(f => !f.startsWith('.'))
          .map(f => buildTree(path.join(dir, f), f))
        return { name, type: 'dir', children, path: path.relative(baseDir, dir) }
      }
      return { name, type: 'file', size: stats.size, path: path.relative(baseDir, dir) }
    }

    try {
      const tree = buildTree(baseDir, sessionId)
      return reply.code(200).send(success(tree))
    } catch (e: any) {
      return reply.code(200).send(fail(50000, `Failed to read workspace: ${e.message}`))
    }
  })

  // GET /workspace/recent
  fastify.get('/workspace/recent', async (request, reply) => {
    const tenantId = (request as any).authContext?.tenantId ?? 'default'
    const tenantDir = path.dirname(workspaceManager.getPath({ tenantId, sessionId: 'dummy' }))
    if (!fs.existsSync(tenantDir)) return reply.code(200).send(success([]))
    try {
      const db = getDb()
      const activeSessionsRes = await db.execute({
        sql: 'SELECT DISTINCT session_id FROM conversations WHERE tenant_id = ?',
        args: [tenantId]
      })
      const activeSessions = new Set(activeSessionsRes.rows.map(r => r.session_id as string))

      const list = fs.readdirSync(tenantDir, { withFileTypes: true })
        .filter(dirent => dirent.isDirectory() && !dirent.name.startsWith('.'))
        .map(dirent => {
          const fullPath = path.join(tenantDir, dirent.name)
          const stats = fs.statSync(fullPath)
          return { name: dirent.name, path: fullPath, mtimeMs: stats.mtimeMs, hasSession: activeSessions.has(dirent.name) }
        })
        .sort((a, b) => b.mtimeMs - a.mtimeMs)
        .slice(0, 10)
      return reply.code(200).send(success(list.map(d => ({ name: d.name, path: d.path, hasSession: d.hasSession }))))
    } catch (e: any) {
      return reply.code(200).send(fail(50000, `Failed: ${e.message}`))
    }
  })

  // GET /workspace/file/content
  fastify.get<{ Querystring: { sessionId?: string; path: string } }>('/workspace/file/content', async (request, reply) => {
    const tenantId = (request as any).authContext?.tenantId ?? 'default'
    const sessionId = request.query.sessionId || 'default'
    const reqPath = request.query.path
    if (!reqPath) return reply.code(200).send(fail(40001, 'path is required'))

    try {
      const safePath = workspaceManager.resolveSafePath({ tenantId, sessionId }, reqPath)
      if (!fs.existsSync(safePath)) return reply.code(200).send(fail(40400, 'File not found'))
      const content = fs.readFileSync(safePath, 'utf-8')
      return reply.code(200).send(success({ content }))
    } catch (e: any) {
      return reply.code(200).send(fail(50000, `Failed to read file: ${e.message}`))
    }
  })

  // DELETE /workspace/recent/:sessionId
  fastify.delete<{ Params: { sessionId: string } }>('/workspace/recent/:sessionId', async (request, reply) => {
    const tenantId = (request as any).authContext?.tenantId ?? 'default'
    const sessionId = request.params.sessionId
    try {
      const dir = workspaceManager.getPath({ tenantId, sessionId })
      if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true })
      }
      return reply.code(200).send(success(true))
    } catch (e: any) {
      return reply.code(200).send(fail(50000, `Failed to delete workspace: ${e.message}`))
    }
  })

  // POST /workspace/rename
  fastify.post<{ Body: { oldName: string, newName: string } }>('/workspace/rename', async (request, reply) => {
    const tenantId = (request as any).authContext?.tenantId ?? 'default'
    const { oldName, newName } = request.body
    if (!oldName || !newName) return reply.code(200).send(fail(40001, 'oldName and newName are required'))
    
    const oldPath = workspaceManager.getPath({ tenantId, sessionId: oldName })
    const newPath = workspaceManager.getPath({ tenantId, sessionId: newName })
    
    if (!fs.existsSync(oldPath)) return reply.code(200).send(fail(40400, 'Workspace not found'))
    if (fs.existsSync(newPath)) return reply.code(200).send(fail(40000, 'Target name already exists'))
    
    try {
      fs.renameSync(oldPath, newPath)
      
      const db = getDb()
      // Update all relevant tables where session_id is used
      await db.execute({ sql: 'UPDATE conversations SET session_id = ? WHERE tenant_id = ? AND session_id = ?', args: [newName, tenantId, oldName] })
      await db.execute({ sql: 'UPDATE memories SET session_id = ? WHERE tenant_id = ? AND session_id = ?', args: [newName, tenantId, oldName] })
      // await db.execute({ sql: 'UPDATE jobs SET tenant_id = ? WHERE tenant_id = ?', args: [newName, oldName] }) // Actually jobs table doesn't have session_id, only tenant_id, so let's skip jobs or handle it differently if needed. We'll just skip tasks/jobs update since it's not strictly tied to session_id in schema.

      return reply.code(200).send(success(true))
    } catch (e: any) {
      return reply.code(200).send(fail(50000, `Failed to rename workspace: ${e.message}`))
    }
  })
}