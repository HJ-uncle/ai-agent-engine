export type CommandCategory = 'common' | 'dangerous'

export interface WhitelistItem {
  command: string
  category: CommandCategory
  description?: string
  frequency?: number
}

// Default allowed commands (safe, read-only or benign)
export const DEFAULT_CMD_WHITELIST: WhitelistItem[] = [
  { command: 'ls', category: 'common', description: 'List directory contents' },
  { command: 'dir', category: 'common', description: 'List directory contents (Windows)' },
  { command: 'echo', category: 'common', description: 'Write arguments to standard output' },
  { command: 'cat', category: 'common', description: 'Concatenate and print files' },
  { command: 'type', category: 'common', description: 'Display file contents' },
  { command: 'pwd', category: 'common', description: 'Print working directory' },
  { command: 'cd', category: 'common', description: 'Change directory' },
  { command: 'find', category: 'common', description: 'Search for files' },
  { command: 'grep', category: 'common', description: 'Print lines matching a pattern' },
  { command: 'where', category: 'common', description: 'Locate a program' },
  { command: 'date', category: 'common', description: 'Print or set system date and time' },
  { command: 'time', category: 'common', description: 'Run programs and summarize system resource usage' },
  { command: 'whoami', category: 'common', description: 'Print effective userid' },
  { command: 'hostname', category: 'common', description: 'Show or set system\'s host name' },
  { command: 'node', category: 'common', description: 'Node.js runtime' },
  { command: 'npm', category: 'common', description: 'Node package manager' },
  { command: 'npx', category: 'common', description: 'Execute npm package binaries' },
  { command: 'wc', category: 'common', description: 'Print newline, word, and byte counts' },
]

let whitelistMap = new Map<string, WhitelistItem>()

function initWhitelist() {
  whitelistMap.clear()
  for (const item of DEFAULT_CMD_WHITELIST) {
    whitelistMap.set(item.command, { ...item, frequency: 0 })
  }
}

initWhitelist()

export function getCmdWhitelist(): Set<string> {
  return new Set(whitelistMap.keys())
}

export function getWhitelistItems(): WhitelistItem[] {
  return Array.from(whitelistMap.values())
}

export function addWhitelistItem(item: WhitelistItem): void {
  if (!whitelistMap.has(item.command)) {
    whitelistMap.set(item.command, { ...item, frequency: 0 })
  }
}

export function updateWhitelistItem(command: string, updates: Partial<WhitelistItem>): void {
  const existing = whitelistMap.get(command)
  if (existing) {
    whitelistMap.set(command, { ...existing, ...updates })
  }
}

export function deleteWhitelistItem(command: string): void {
  whitelistMap.delete(command)
}

export function addToWhitelist(...commands: string[]): void {
  for (const cmd of commands) {
    if (!whitelistMap.has(cmd)) {
      whitelistMap.set(cmd, { command: cmd, category: 'common', frequency: 0 })
    }
  }
}

export function isCommandAllowed(command: string): boolean {
  // Extract base command name (strip path)
  const baseName = command.split(/[/\\]/).pop() ?? command
  const item = whitelistMap.get(baseName)
  if (item) {
    item.frequency = (item.frequency || 0) + 1
    return true
  }
  return false
}

export function resetWhitelist(): void {
  initWhitelist()
}
