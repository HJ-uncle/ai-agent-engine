import fs from 'node:fs'
import path from 'node:path'

export interface CommandLaunchPlan {
  command: string
  args: string[]
  windowsVerbatimArguments?: boolean
}

const WINDOWS_BUILTINS = new Set(['dir', 'type', 'copy', 'move', 'del', 'rd', 'md', 'mkdir', 'rmdir', 'ren', 'rename',
  'cls', 'echo', 'set', 'cd', 'pushd', 'popd', 'title', 'ver', 'vol', 'path', 'assoc', 'ftype', 'mklink'])
const WINDOWS_EXECUTABLE = /\.(?:com|exe|cmd|bat)$/i

function environmentValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  // Windows passes the first case-insensitive key after sorting to its child.
  const key = Object.keys(env).sort().find(key => key.toLowerCase() === name.toLowerCase())
  return key === undefined ? undefined : env[key]
}

function isFile(file: string): boolean {
  try { return fs.statSync(file).isFile() } catch { return false }
}

/** Resolve exactly the Windows executable search space; do not infer a shell for unknown commands. */
export function resolveWindowsExecutable(command: string, cwd: string, env: NodeJS.ProcessEnv): string | undefined {
  const directories = /[\\/]/.test(command) || path.win32.isAbsolute(command)
    ? ['']
    : [cwd, ...(environmentValue(env, 'PATH') ?? '').split(';').map(value => value.replace(/^"|"$/g, ''))]
  const extensions = WINDOWS_EXECUTABLE.test(command) ? ['']
    : (environmentValue(env, 'PATHEXT') ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(ext => /^\.(?:com|exe|cmd|bat)$/i.test(ext))
  for (const directory of directories) {
    const base = path.win32.resolve(cwd, directory, command)
    for (const extension of extensions) {
      const candidate = base + extension
      if (isFile(candidate)) return candidate
    }
  }
  return undefined
}

/** Guard an argv API against a whole shell line without rejecting real paths containing spaces. */
export function commandLooksLikeShellLine(command: string, cwd: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!/\s/.test(command)) return false
  const directories = /[\\/]/.test(command) || path.isAbsolute(command) ? [''] : ['', ...(env.PATH ?? '').split(path.delimiter)]
  if (directories.some(directory => isFile(path.resolve(cwd, directory, command)))) return false
  if (process.platform === 'win32' && resolveWindowsExecutable(command, cwd, env)) return false
  // A missing explicit executable is still a valid argv request. Let spawn report ENOENT.
  if (/[\\/]/.test(command) && /\.(?:exe|com|cmd|bat)$/i.test(command) && !/["\r\n]/.test(command)) return false
  return true
}

const escapeCmdMeta = (value: string): string => value.replace(/([()\][%!^"`<>&|;, *?])/g, '^$1')

function quoteCmdArgument(value: string, doubleEscape: boolean): string {
  // Encode the C-runtime argv first, then protect it from cmd's metacharacter pass.
  let quoted = '"'
  let slashes = 0
  for (const character of value) {
    if (character === '\\') { slashes++; continue }
    quoted += '\\'.repeat(character === '"' ? slashes * 2 + 1 : slashes) + character
    slashes = 0
  }
  quoted += '\\'.repeat(slashes * 2) + '"'
  const escaped = escapeCmdMeta(quoted)
  // Batch entrypoints expand their argument vector through a second cmd parser pass.
  return doubleEscape ? escapeCmdMeta(escaped) : escaped
}

export function createCommandLaunchPlan(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform): CommandLaunchPlan {
  if (platform !== 'win32') return { command, args: [...args] }
  const resolved = resolveWindowsExecutable(command, cwd, env)
  // cmd parses a /c script itself, not with the native executable argv grammar.
  // Preserve that one script verbatim; quoting its inner quotes as \" corrupts JS and paths.
  const scriptIndex = args.findIndex(arg => /^\/c$/i.test(arg))
  if (/^(?:cmd|cmd\.exe)$/i.test(path.win32.basename(resolved ?? command)) && scriptIndex === args.length - 2 && scriptIndex >= 0 &&
    args.slice(0, scriptIndex).every(arg => /^\/(?:d|s|q|a|u|[evf]:(?:on|off))$/i.test(arg))) {
    return { command: resolved ?? command,
      args: ['/d', '/s', ...args.slice(0, scriptIndex).filter(arg => !/^\/[ds]$/i.test(arg)), '/c', '"' + args[scriptIndex + 1] + '"'],
      windowsVerbatimArguments: true }
  }
  const builtin = WINDOWS_BUILTINS.has(command.toLowerCase())
  const batch = /\.(?:cmd|bat)$/i.test(resolved ?? command)
  if (!builtin && !batch) return { command: resolved ?? command, args: [...args] }
  // cmd silently cuts an argument at CR/LF even when it is quoted. Never launch a
  // truncated command; multiline interpreter source can use direct node/python argv.
  if (args.some(arg => /[\r\n]/.test(arg))) {
    throw Object.assign(new Error('Windows .cmd/.bat 或内置命令不能可靠传递含换行的单个参数。请直接调用 node/python 并将源码作为 args 的一项，或保存脚本文件后运行；未执行此命令。'),
      { code: 'COMMAND_INVALID_ARGUMENTS' })
  }
  const executable = builtin ? command : resolved ?? command
  const doubleEscape = batch
  const shellLine = [escapeCmdMeta(path.win32.normalize(executable)), ...args.map(arg => quoteCmdArgument(arg, doubleEscape))].join(' ')
  return { command: environmentValue(env, 'COMSPEC') || 'cmd.exe',
    args: ['/d', '/s', '/c', '"' + shellLine + '"'], windowsVerbatimArguments: true }
}
