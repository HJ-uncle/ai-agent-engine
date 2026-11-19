import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { success } from '../response.js'
import { ADMIN_PERMISSIONS } from '../admin/rbac-contract.js'
import { adminRead, adminWrite, adminIdentity, registerAdminRbacLifecycle, requireAdminPermission } from '../admin/rbac-access.js'
import { deleteMember, deleteRole, getAdminMember, getAdminRole, issueCredential, listAudit, listCredentials, listMembers, listRoles, revokeCredential, saveMember, saveRole } from '../admin/rbac-directory.js'

type Id = {Params: {id: string}}
type Key = {Params: {id: string; keyId: string}}
const options = { bodyLimit: 16 * 1024 }
export async function adminRbacRoutes(app: FastifyInstance): Promise<void> {
  registerAdminRbacLifecycle(app)
  app.get('/admin/me', adminIdentity)
  app.get('/admin/permissions', async (req,reply) => {
    if (!await requireAdminPermission(req,reply)) return reply
    return reply.send(success({items:Object.entries(ADMIN_PERMISSIONS).map(([id,label]) => ({id,label}))}))
  })
  app.get('/admin/members', (req,reply) => adminRead(req,reply,'members.read',tx => listMembers(tx,req.query)))
  app.get<Id>('/admin/members/:id', (req,reply) => adminRead(req,reply,'members.read',tx => getAdminMember(tx,req.params.id)))
  app.post('/admin/members', options, (req,reply) => {const id=randomUUID(); return adminWrite(req,reply,'members.write','member.create',id,(tx,a,record) => saveMember(tx,a,id,true,req.body,record))})
  app.patch<Id>('/admin/members/:id', options, (req,reply) => adminWrite(req,reply,'members.write','member.update',req.params.id,(tx,a,record) => saveMember(tx,a,req.params.id,false,req.body,record)))
  app.delete<Id>('/admin/members/:id', (req,reply) => adminWrite(req,reply,'members.write','member.delete',req.params.id,(tx,a,record) => deleteMember(tx,a,req.params.id,record)))
  app.get<Id>('/admin/members/:id/credentials', (req,reply) => adminRead(req,reply,'members.read',tx => listCredentials(tx,req.params.id)))
  app.post<Id>('/admin/members/:id/credentials', options, (req,reply) => {const keyId=randomUUID(); return adminWrite(req,reply,'credentials.write','credential.issue',keyId,(tx,a,record) => issueCredential(tx,a,req.params.id,keyId,req.body,record))})
  app.delete<Key>('/admin/members/:id/credentials/:keyId', (req,reply) => adminWrite(req,reply,'credentials.write','credential.revoke',req.params.keyId,(tx,a,record) => revokeCredential(tx,a,req.params.id,req.params.keyId,record)))
  app.get('/admin/roles', (req,reply) => adminRead(req,reply,'roles.read',tx => listRoles(tx,req.query)))
  app.get<Id>('/admin/roles/:id', (req,reply) => adminRead(req,reply,'roles.read',tx => getAdminRole(tx,req.params.id)))
  app.post('/admin/roles', options, (req,reply) => {const id=randomUUID(); return adminWrite(req,reply,'roles.write','role.create',id,(tx,a,record) => saveRole(tx,a,id,true,req.body,record))})
  app.patch<Id>('/admin/roles/:id', options, (req,reply) => adminWrite(req,reply,'roles.write','role.update',req.params.id,(tx,a,record) => saveRole(tx,a,req.params.id,false,req.body,record)))
  app.delete<Id>('/admin/roles/:id', (req,reply) => adminWrite(req,reply,'roles.write','role.delete',req.params.id,(tx,a,record) => deleteRole(tx,a,req.params.id,record)))
  app.get('/admin/audit', (req,reply) => adminRead(req,reply,'audit.read',tx => listAudit(tx,req.query)))
}
