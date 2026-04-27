// Fix Windows console UTF-8 encoding (prevent garbled Chinese/emoji output)
if (process.platform === 'win32') {
  process.stdout.setEncoding('utf8')
  process.stderr.setEncoding('utf8')
  // Attempt to set console code page to UTF-8 via env hint (works with newer Node)
  process.env.PYTHONIOENCODING = 'utf-8'
}

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
import { initDb } from './storage/sqlite/db.js'

const PORT = parseInt(process.env.PORT ?? '12323', 10)
const HOST = process.env.HOST ?? '0.0.0.0'

async function main() {
  try {
    // 初始化数据库（建表、补列，幂等）
    await initDb()

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
