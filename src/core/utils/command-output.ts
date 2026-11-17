const COMMAND_TOOLS = new Set(['execute_cmd', 'command_output', 'cancel_command', 'wait_command', 'wait_commands'])

/** Command logs are opaque text inside a versioned envelope. In particular,
 * a program may print markers used by unrelated tool presentation protocols. */
export function commandOutputPresentation(toolName: string, output: string, maxChars: number): string | undefined {
  if (!COMMAND_TOOLS.has(toolName)) return undefined
  let value: unknown
  try { value = JSON.parse(output) } catch { return undefined }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (record.version !== 1 || (record.type !== 'command_result' && record.type !== 'command_results')) return undefined
  if (output.length <= maxChars) return output
  // Builtins budget the serialized envelope before reading logs. If a future
  // caller violates that contract, never retain a cursor for hidden log text.
  const retry = JSON.stringify({ error: 'COMMAND_OUTPUT_BUDGET_TOO_SMALL',
    message: 'Receipt exceeded the output budget. Retry command_output with the same jobId, cursor and cursorOffset; no output was consumed.' })
  if (retry.length <= maxChars) return retry
  const minimal = JSON.stringify({ error: 'COMMAND_OUTPUT_BUDGET_TOO_SMALL' })
  return minimal.length <= maxChars ? minimal : 'Output budget too small; retry.'.slice(0, maxChars)
}
