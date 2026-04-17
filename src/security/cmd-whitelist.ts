// Default allowed commands (safe, read-only or benign)
export const DEFAULT_CMD_WHITELIST = new Set([
  'ls', 'dir', 'echo', 'cat', 'type',
  'pwd', 'cd', 'find', 'grep', 'where',
  'date', 'time', 'whoami', 'hostname',
  'node', 'npm', 'npx',
])

let cmdWhitelist = new Set(DEFAULT_CMD_WHITELIST)

export function getCmdWhitelist(): Set<string> {
  return cmdWhitelist
}

export function addToWhitelist(...commands: string[]): void {
  for (const cmd of commands) {
    cmdWhitelist.add(cmd)
  }
}

export function isCommandAllowed(command: string): boolean {
  // Extract base command name (strip path)
  const baseName = command.split(/[/\\]/).pop() ?? command
  return cmdWhitelist.has(baseName)
}

export function resetWhitelist(): void {
  cmdWhitelist = new Set(DEFAULT_CMD_WHITELIST)
}
