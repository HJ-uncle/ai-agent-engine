import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { projectDataPath, projectDataReadPaths } from '../core/project-storage.js'
import { loadExternalSkills, type ExternalSkill } from './external-loader.js'
import { logger } from '../observability/index.js'

/** Highest priority first; old skill roots are read in place, never relocated. */
export function projectSkillRoots(projectRoot: string): string[] {
  return [...projectDataReadPaths(projectRoot, 'skills'), path.resolve(projectRoot, 'SKILLs')]
}

function readConfig(configPath: string): Record<string, unknown> {
  if (!fs.existsSync(configPath)) return {}
  const config: unknown = JSON.parse(fs.readFileSync(configPath, 'utf8'))
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('skills.config.json must be an object')
  return config as Record<string, unknown>
}

function deletedLegacySkills(config: Record<string, unknown>): Set<string> {
  return new Set(Array.isArray(config.deletedLegacySkills)
    ? config.deletedLegacySkills.filter((value): value is string => typeof value === 'string').map((value) => value.toLowerCase()) : [])
}

function writeConfig(configPath: string, content: string): void {
  fs.mkdirSync(path.dirname(configPath), { recursive: true })
  const temporary = configPath + '.' + randomUUID() + '.tmp'
  try {
    fs.writeFileSync(temporary, content, 'utf8')
    fs.renameSync(temporary, configPath)
  } finally { fs.rmSync(temporary, { force: true }) }
}

/** Deleting the visible copy must not silently resurrect an older project copy. */
export function withProjectSkillDeletion(projectRoot: string, skillName: string, remove: () => void): void {
  const configPath = projectDataPath(projectRoot, 'skills', 'skills.config.json')
  const previous = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : null
  const config = readConfig(configPath)
  const deleted = deletedLegacySkills(config)
  deleted.add(skillName.toLowerCase())
  config.deletedLegacySkills = [...deleted]
  writeConfig(configPath, JSON.stringify(config, null, 2))
  try { remove() }
  catch (error) {
    // Failed deletion must remain visible and retryable, including a selected
    // legacy copy. Preserve the exact prior configuration on rollback.
    if (previous === null) fs.rmSync(configPath, { force: true })
    else writeConfig(configPath, previous)
    throw error
  }
}

export function loadProjectSkills(projectRoot: string): ExternalSkill[] {
  const modernRoot = projectDataPath(projectRoot, 'skills')
  const configPath = path.join(modernRoot, 'skills.config.json')
  let config: Record<string, unknown> = {}
  try { config = readConfig(configPath) }
  catch (error) { logger.warn({ configPath, error }, 'Failed to read project skill overrides') }
  const deleted = deletedLegacySkills(config)
  const merged = new Map<string, ExternalSkill>()
  for (const root of projectSkillRoots(projectRoot).reverse()) {
    if (!fs.existsSync(root)) continue
    for (const skill of loadExternalSkills(root, { includeDisabled: true })) {
      // A newly imported canonical copy is an explicit restoration. The
      // marker only suppresses retained legacy copies, never current files.
      if (root !== modernRoot && deleted.has(skill.name.toLowerCase())) continue
      merged.set(skill.name.toLowerCase(), { ...skill, scope: 'project' })
    }
  }
  // New settings for a legacy skill also belong in .ae; preserve the legacy
  // skill's content and configuration until the user explicitly changes it.
  if (config.defaults && typeof config.defaults === 'object') {
    const defaults = config.defaults as Record<string, { enabled?: unknown; order?: unknown }>
    for (const skill of merged.values()) {
      if (path.dirname(path.dirname(skill.skillMdPath)) === modernRoot) continue
      const override = defaults[path.basename(path.dirname(skill.skillMdPath))]
      if (typeof override?.enabled === 'boolean') skill.enabled = override.enabled
      if (typeof override?.order === 'number') skill.order = override.order
    }
  }
  return [...merged.values()]
}
