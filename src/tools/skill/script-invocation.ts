import { statSync } from 'node:fs'
import path from 'node:path'

/** The bound tool accepts literal arguments. For an ordinary command, defer to Bash whenever expansion or escaping would change the result. */
export function invocationTokens(command: string, preserveShellSyntax = false): string[] | undefined {
  if (/[\0\r\n]/.test(command)) return undefined
  const tokens: string[] = []
  let token = '', quote: '"' | "'" | undefined, started = false
  for (let i = 0; i < command.length; i++) {
    const c = command[i]
    if (quote && c === quote) { quote = undefined; continue }
    if (!quote && (c === '"' || c === "'")) { quote = c; started = true; continue }
    if (!quote && /\s/.test(c)) {
      if (started) { tokens.push(token); token = ''; started = false }
      continue
    }
    if (!quote && /[;&|<>\x60]/.test(c)) return undefined
    if (preserveShellSyntax && quote !== "'") {
      if (c === '$' && !/^\$SKILLS_ROOT\b/.test(command.slice(i))) return undefined
      if (c === '\x60' || (!quote && /[\\*?\[\]{}()~#!]/.test(c))) return undefined
      if (quote && c === '\\' && /["$\\\x60]/.test(command[i + 1] ?? '')) return undefined
    }
    token += c; started = true
  }
  if (quote) return undefined
  if (started) tokens.push(token)
  return tokens
}

const nativeInterpreters = new Set(['node', 'python', 'python3'])
export function directWindowsScript(argv: string[] | undefined): { command: string; args: string[] } | undefined {
  if (!argv || !nativeInterpreters.has(argv[0]) || !argv[1] || argv[1].startsWith('-')) return undefined
  // Resolve against the child PATH, without implicitly searching the skills directory as Windows spawn normally would.
  for (const entry of (process.env.PATH ?? '').split(path.delimiter)) {
    const dir = entry.trim().replace(/^"(.*)"$/, '$1')
    if (!path.isAbsolute(dir)) continue
    const exe = path.join(dir, argv[0] + '.exe')
    if (statSync(exe, { throwIfNoEntry: false })?.isFile()) return { command: exe, args: argv.slice(1) }
    if (statSync(path.join(dir, argv[0] + '.cmd'), { throwIfNoEntry: false })?.isFile()) break
  }
  return undefined
}
