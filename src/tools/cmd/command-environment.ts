import type { SecurityMode } from '../../security/policy-engine.js'

const BASE_KEYS = ['PATH', 'PATHEXT', 'SystemRoot', 'COMSPEC']
const WINDOWS_DIRECTORY_KEYS = ['WINDIR', 'LOCALAPPDATA', 'APPDATA', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'TEMP', 'TMP']
const PYTHON_MANAGER_AUTOMATIC_INSTALL = 'PYTHON_MANAGER_AUTOMATIC_INSTALL'

export function createCommandEnvironment(mode: SecurityMode, cwd: string, source: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  const windows = platform === 'win32'
  const env: NodeJS.ProcessEnv = mode === 'full-access' ? { ...source } : { HOME: cwd }
  if (mode !== 'full-access') {
    const sourceKeys = Object.keys(source).sort()
    for (const name of [...BASE_KEYS, ...(windows ? WINDOWS_DIRECTORY_KEYS : [])]) {
      const key = windows ? sourceKeys.find(key => key.toUpperCase() === name.toUpperCase()) : name
      if (key && source[key] !== undefined) env[name] = source[key]
    }
  }
  if (windows) {
    // Python Manager 26.4 resolves missing %LocalAppData% to cwd/Python.
    // Keep directory discovery above, but opt out of its implicit installer:
    // a read-only `python -c` probe must not install a missing runtime.
    // The manager's explicit `py install` path does not use this flag.
    // Source: python/pymanager tag 26.4, manage/config.py and install_command.py.
    for (const key of Object.keys(env)) if (key.toUpperCase() === PYTHON_MANAGER_AUTOMATIC_INSTALL) delete env[key]
    env[PYTHON_MANAGER_AUTOMATIC_INSTALL] = 'false'
  }
  return env
}
