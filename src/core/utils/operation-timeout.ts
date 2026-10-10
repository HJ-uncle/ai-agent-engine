/** Node timers overflow above this value; zero explicitly disables a deadline. */
export const MAX_OPERATION_TIMEOUT_MS = 2_147_483_647

export function validateOperationTimeout(value: unknown, label = 'timeoutMs'): asserts value is number | undefined {
  if (value !== undefined && (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > MAX_OPERATION_TIMEOUT_MS)) {
    throw new Error(`${label} must be an integer from 0 to ${MAX_OPERATION_TIMEOUT_MS} (0 means no deadline)`)
  }
}
