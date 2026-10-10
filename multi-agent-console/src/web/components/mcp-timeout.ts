/** Match the engine timer range and preserve the meaning of zero. */
export function parseMcpTimeout(value: unknown): number | undefined {
  if (value === undefined || value === null || String(value).trim() === '') return undefined
  const raw = String(value).trim()
  if (!/^\d+$/.test(raw)) throw new Error('请求超时必须是非负整数毫秒；留空使用默认，0 表示不限')
  const timeout = Number(raw)
  if (!Number.isInteger(timeout) || timeout > 2147483647) throw new Error('请求超时必须在 0 到 2147483647 毫秒之间')
  return timeout
}
