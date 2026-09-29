import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readBuildManifest } from './build-identity.js'

const build = readBuildManifest(path.dirname(fileURLToPath(import.meta.url)))
const instanceId = randomUUID()

/** Stable for this process; a new process gets a new instance even when its build is unchanged. */
export function getRuntimeIdentity() {
  return { ...build, toolProfiles: [...build.toolProfiles], instanceId }
}
