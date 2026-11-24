import { realpathSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { activationProof, issueActivationCode } from '../account-activation.js'
import { beginAccountTransaction } from '../account-database.js'
import { getDb } from '../../storage/sqlite/db.js'

/** Only the isolated Vitest business database may receive a synthetic management grant. */
export async function issuedFixtureActivation(): Promise<string> {
  const database = (await getDb().execute('PRAGMA database_list')).rows.find(r => r.name === 'main')?.file
  const root=realpathSync(resolve('.e2e-tmp')), rel=typeof database==='string' ? relative(root,realpathSync(database)) : ''
  if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith('..'+sep)) throw new Error('Expected an isolated test database')
  const tx = await beginAccountTransaction()
  try { const issued=await issueActivationCode(tx,'fixture-admin'); await tx.commit(); return issued.code } finally { tx.close() }
}
export async function fixtureActivationProof() { return activationProof(await issuedFixtureActivation())! }
