// Load .env file manually (no dotenv dependency required)
import { readFileSync } from 'node:fs'

try {
  const env = readFileSync('.env', 'utf8')
  for (const line of env.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eqIdx = trimmed.indexOf('=')
    if (eqIdx === -1) continue
    const key = trimmed.slice(0, eqIdx).trim()
    const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '')
    if (key && !(key in process.env)) {
      process.env[key] = val
    }
  }
} catch {
  // .env file not present — rely on environment variables already set
}

import { buildServer } from './api/http/index.js'
import { logger } from './observability/index.js'
import { skillsRegistry } from './skills/index.js'

const PORT = parseInt(process.env.PORT ?? '3000', 10)
const HOST = process.env.HOST ?? '0.0.0.0'

async function main() {
  try {
    // 启动技能注册表（扫描 + 热监听 SKILLS_ROOT）
    skillsRegistry.start()

    const server = await buildServer()
    await server.listen({ port: PORT, host: HOST })
    logger.info({ port: PORT, host: HOST }, 'AI Agent Engine started')

    // 优雅关闭：停止文件监听
    const shutdown = async (signal: string) => {
      logger.info({ signal }, 'Shutting down...')
      skillsRegistry.stop()
      await server.close()
      process.exit(0)
    }
    process.once('SIGINT', () => void shutdown('SIGINT'))
    process.once('SIGTERM', () => void shutdown('SIGTERM'))
  } catch (err) {
    logger.error({ err }, 'Failed to start server')
    process.exit(1)
  }
}

void main()
