import pino, { type Logger } from 'pino'

const isDev = process.env.NODE_ENV !== 'production'

// pino's default export is callable both as a named export and default export
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const pinoFactory = (pino as any).default ?? pino

export const logger: Logger = pinoFactory({
  level: process.env.LOG_LEVEL ?? 'info',
  transport: isDev
    ? { target: 'pino-pretty', options: { colorize: true } }
    : undefined,
})

export function createRequestLogger(requestId: string, tenantId?: string, sessionId?: string) {
  return logger.child({ requestId, tenantId, sessionId })
}
