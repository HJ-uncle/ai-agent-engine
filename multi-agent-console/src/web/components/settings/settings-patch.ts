/** GET includes runtime/default display values; only an explicit edit belongs in PUT. */
export function buildSettingsPatch(
  keys: readonly string[],
  settings: Record<string, unknown>,
  baseline: Record<string, unknown>,
  overrides?: Record<string, unknown>
): Record<string, unknown> {
  const payload: Record<string, unknown> = {}
  for (const key of keys) {
    if (key === 'runtimeLimits' || key === 'managedKeys') continue
    const forced = overrides !== undefined && Object.prototype.hasOwnProperty.call(overrides, key)
    const value = forced ? overrides[key] : settings[key]
    if (value === undefined || (!forced && Object.is(value, baseline[key]))) continue
    payload[key] = value
  }
  return payload
}
