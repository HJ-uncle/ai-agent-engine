// 1. 必须最先加载环境变量，确保后续导入的模块（如加密、数据库）能正确读取配置
import './env.js'

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

import { buildServer } from './api/http/index.js'
import { logger } from './observability/index.js'
import { skillsRegistry } from './skills/index.js'
import { initDb } from './storage/sqlite/db.js'
import { initMemoryDb, closeMemoryDb, MEMORY_SCHEMA, MemoryConsolidator } from './storage/memory/index.js'
import { systemConfigStore } from './storage/sqlite/system-config.js'
import { loadAetherConfig, applyAetherConfigToEnv } from './core/aether-config.js'
import { networkInterfaces } from 'node:os'

const PORT = parseInt(process.env.PORT ?? '12323', 10)
const HOST = process.env.HOST ?? '0.0.0.0'

async function main() {
  try {
    // 0. 加载 .aether/ 统一配置目录（用户级 ~/.aether + 项目级 .aether/）
    //    显式字段覆盖 .env；后续 DB system_config 同步会再覆盖（DB 优先级最高）
    applyAetherConfigToEnv(loadAetherConfig())

    // 1. 并行初始化核心组件：主数据库、记忆数据库
    // 这些操作互不依赖，可以并发执行以缩短总启动时间
    await Promise.all([
      initDb().then(() => {
        logger.info('Main database initialized')
      }),
      initMemoryDb(MEMORY_SCHEMA).then(() => {
        logger.info('Memory database initialized')
      }),
    ])

    // 2. 数据库就绪后，继续执行后续步骤
    // 启动记忆整理守护进程（它会自动处理延迟执行，不阻塞）
    const consolidator = new MemoryConsolidator()
    consolidator.startDaemon('default')

    // 3. 串行获取系统配置和构建服务器（确保构建前 process.env 已注入最新配置）
    const dbConfig = await systemConfigStore.getAll()

    // 将数据库中的 system_config 同步到 process.env
    for (const [key, value] of Object.entries(dbConfig)) {
      if (value !== null && value !== '') {
        process.env[key] = value
      }
    }
    logger.info({ keys: Object.keys(dbConfig).length }, 'Synced system_config from DB to process.env')

    // 4. SkillsRegistry 必须在 DB→env 同步之后启动：
    //    SKILLS_ROOT / AETHER_GLOBAL_DIR 等路径配置此时才最终定型，
    //    否则 registry 的双层状态（项目层/全局层）会与导入管线的目录解析分裂
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
    }, 'Aether Engine started')

    console.log(`\n🚀 Aether Engine (AE) 已启动`)
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
