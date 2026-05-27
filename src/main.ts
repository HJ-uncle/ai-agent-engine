// Fix Windows console UTF-8 encoding (prevent garbled Chinese/emoji output)
if (process.platform === 'win32') {
  process.stdout.setEncoding('utf8')
  process.stderr.setEncoding('utf8')
  // Attempt to set console code page to UTF-8 via env hint (works with newer Node)
  process.env.PYTHONIOENCODING = 'utf-8'
}

// --- Polyfills for pdfjs-dist in Node 20 ---
if (typeof globalThis.DOMMatrix === 'undefined') {
  globalThis.DOMMatrix = class DOMMatrix {} as any
}
if (typeof globalThis.ImageData === 'undefined') {
  globalThis.ImageData = class ImageData {} as any
}
if (typeof (globalThis as any).Path2D === 'undefined') {
  (globalThis as any).Path2D = class Path2D {} as any
}
if (typeof (Promise as any).withResolvers === 'undefined') {
  (Promise as any).withResolvers = function () {
    let resolve, reject
    const promise = new Promise((res, rej) => {
      resolve = res
      reject = rej
    })
    return { promise, resolve, reject }
  }
}
// -------------------------------------------

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
import { initMemoryDb, closeMemoryDb, MEMORY_SCHEMA, MemoryConsolidator } from './storage/memory/index.js'
import { systemConfigStore } from './storage/sqlite/system-config.js'
import { networkInterfaces } from 'node:os'

const PORT = parseInt(process.env.PORT ?? '12323', 10)
const HOST = process.env.HOST ?? '0.0.0.0'

async function main() {
  try {
    // 初始化数据库（建表、补列，幂等）
    await initDb()

    // 初始化独立记忆数据库（幂等）
    await initMemoryDb(MEMORY_SCHEMA)
    logger.info('Memory database initialized')
    
    // 启动记忆反思整理 (Consolidation) 定时任务
    const consolidator = new MemoryConsolidator()
    consolidator.startDaemon('default')

    // 将数据库中的 system_config 同步到 process.env（DB 优先）
    // 这样所有直接读取 process.env 的模块（react.ts、history.ts 等）
    // 在运行时都能自动获取用户在 UI 配置的值
    const dbConfig = await systemConfigStore.getAll()
    for (const [key, value] of Object.entries(dbConfig)) {
      if (value !== null) {
        process.env[key] = value
      }
    }
    logger.info({ keys: Object.keys(dbConfig).length }, 'Synced system_config from DB to process.env')

    // 启动技能注册表（扫描 + 热监听 SKILLS_ROOT）
    skillsRegistry.start()

    const server = await buildServer()
    await server.listen({ port: PORT, host: HOST })
    
    // 获取局域网IP地址
    const lanIps: string[] = []
    const nets = networkInterfaces()
    for (const name of Object.keys(nets)) {
      for (const net of nets[name]!) {
        if (net.family === 'IPv4' && !net.internal) {
          lanIps.push(net.address)
        }
      }
    }
    
    const localUrl = `http://localhost:${PORT}`
    const lanUrls = lanIps.map(ip => `http://${ip}:${PORT}`).join(', ')
    
    logger.info({ 
      port: PORT, 
      host: HOST,
      localUrl,
      lanUrls 
    }, 'AI Agent Engine started')
    
    console.log(`\n🚀 AI Agent Engine 已启动`)
    console.log(`   本地访问: ${localUrl}`)
    if (lanUrls) {
      console.log(`   局域网访问: ${lanUrls}`)
    }
    console.log()

    // 优雅关闭：停止文件监听
    const shutdown = async (signal: string) => {
      logger.info({ signal }, 'Shutting down...')
      consolidator.stopDaemon()
      skillsRegistry.stop()
      closeMemoryDb()
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
