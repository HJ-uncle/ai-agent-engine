import { fileURLToPath } from 'node:url'
import { loadExternalSkills, type ExternalSkill } from './external-loader.js'

// Source and dist keep the same relative layout. Discovery does not depend on
// the project's cwd, user's home or an untracked .aether directory.
const root = fileURLToPath(new URL('./builtin/', import.meta.url))
let loaded: ExternalSkill[] | undefined
export function loadBuiltinOfficeSkills(): ExternalSkill[] {
  loaded ??= loadExternalSkills(root, { includeDisabled: true }).map(skill => ({ ...skill, builtin: true }))
  return loaded.map(skill => ({ ...skill }))
}
