/**
 * Launchers also send legacy listener keys so previously released runtimes can
 * start. Restore the project's original keys before any imported module or
 * .env loader can observe those temporary aliases; consume the marker once.
 */
export function restoreEmbeddedProjectEnvironment(env: NodeJS.ProcessEnv = process.env): void {
  const encoded = env.AETHER_ENGINE_PROJECT_ENV
  if (encoded === undefined) return

  const invalid = (): never => { throw new Error('Invalid embedded engine project environment snapshot') }
  let value: unknown
  try { value = JSON.parse(encoded) } catch { invalid() }
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid()
  const snapshot = value as Record<string, unknown>
  if (snapshot.version !== 1 ||
      (snapshot.PORT !== null && typeof snapshot.PORT !== 'string') ||
      (snapshot.HOST !== null && typeof snapshot.HOST !== 'string') ||
      env.AETHER_ENGINE_PORT === undefined || env.AETHER_ENGINE_HOST === undefined) invalid()

  for (const key of ['PORT', 'HOST'] as const) {
    if (snapshot[key] === null) delete env[key]
    else env[key] = snapshot[key] as string
  }
  delete env.AETHER_ENGINE_PROJECT_ENV
}

/** Embedded launchers reserve their own names so child project servers keep PORT/HOST. */
export function readEngineListenAddress(env: NodeJS.ProcessEnv = process.env): { port: number; host: string } {
  return {
    // Standalone deployments keep their existing PORT/HOST contract.
    port: parseInt(env.AETHER_ENGINE_PORT ?? env.PORT ?? '12323', 10),
    host: env.AETHER_ENGINE_HOST ?? env.HOST ?? '0.0.0.0',
  }
}
