import fs from 'node:fs'
import path from 'node:path'

export const PROJECT_DATA_DIRECTORY = '.ae'
export const LEGACY_PROJECT_DATA_DIRECTORY = '.aether'

export function projectDataPath(projectRoot: string, ...parts: string[]): string {
  return path.resolve(projectRoot, PROJECT_DATA_DIRECTORY, ...parts)
}

export function legacyProjectDataPath(projectRoot: string, ...parts: string[]): string {
  return path.resolve(projectRoot, LEGACY_PROJECT_DATA_DIRECTORY, ...parts)
}

/** Existing data remains readable without moving or replacing project files. */
export function projectDataReadPaths(projectRoot: string, ...parts: string[]): string[] {
  return [projectDataPath(projectRoot, ...parts), legacyProjectDataPath(projectRoot, ...parts)]
}

export function firstExistingProjectDataPath(projectRoot: string, ...parts: string[]): string {
  const candidates = projectDataReadPaths(projectRoot, ...parts)
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0]
}
