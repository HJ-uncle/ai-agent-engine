import { statSync } from 'node:fs'
import path from 'node:path'

const file = (name: string): boolean => statSync(name, { throwIfNoEntry: false })?.isFile() === true

/** Windows npm/npx ship as .cmd launchers. Run their matching JS entry with its own Node; stdio arguments must never become a shell program. */
export function stdioCommand(command: string, args: string[], overrides?: Record<string, string>) {
  const env = { ...process.env }
  if (process.platform === 'win32') {
    // Node sorts duplicate Windows environment keys; an explicit MCP Path must win even if its casing differs.
    for (const [key, value] of Object.entries(overrides ?? {})) {
      const inherited = Object.keys(env).find(name => name.toUpperCase() === key.toUpperCase())
      env[inherited ?? key] = value
    }
  } else Object.assign(env, overrides)
  const original = { command, args, env }
  if (process.platform !== 'win32') return original
  const name = path.basename(command).toLowerCase()
  if (!/^(npm|npx)(?:\.cmd)?$/.test(name)) return original
  const bin = name.split('.')[0], explicitCmd = name.endsWith('.cmd')
  const pathKey = Object.keys(env).find(key => key.toUpperCase() === 'PATH')
  const dirs = path.basename(command) !== command ? [path.dirname(path.resolve(command))]
    : (env[pathKey ?? 'PATH'] ?? '').split(path.delimiter).map(dir => dir.trim().replace(/^"(.*)"$/, '$1')).filter(dir => path.isAbsolute(dir))
  for (const dir of dirs) {
    const exe = path.join(dir, bin + '.exe')
    if (!explicitCmd && file(exe)) return { command: exe, args, env }
    if (!file(path.join(dir, bin + '.cmd'))) continue
    const node = path.join(dir, 'node.exe'), cli = path.join(dir, 'node_modules', 'npm', 'bin', bin + '-cli.js')
    if (file(node) && file(cli)) return { command: node, args: [cli, ...args], env }
    // A custom wrapper selected by the user has different semantics. Never silently bypass it for a later copy.
    throw new Error('Cannot directly launch ' + path.join(dir, bin + '.cmd') + '; configure the executable and its arguments for this MCP server.')
  }
  return original
}
