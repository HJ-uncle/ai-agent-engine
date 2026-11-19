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
import { logger, observeShutdownStage } from './observability/index.js'
import { skillsRegistry } from './skills/index.js'
import { initDb, closeDb, getDb } from './storage/sqlite/db.js'
import { initMemoryDb, closeMemoryDb, MEMORY_SCHEMA, MemoryConsolidator } from './storage/memory/index.js'
import { systemConfigStore, TRUSTED_STARTUP_KEYS } from './storage/sqlite/system-config.js'
import { loadAetherConfig, applyAetherConfigToEnv, loadManagedConfig } from './core/aether-config.js'
import { networkInterfaces } from 'node:os'
import { isAbsolute, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getStartupInstanceTokenState } from './auth/instance-token.js'
import { commandJobs } from './core/command-jobs/index.js'
import { readEngineListenAddress } from './server-listen.js'
import { startAuditMaintenance } from './security/audit-maintenance.js'
import { startHistoryMaintenance } from './core/collaboration/history-maintenance-lifecycle.js'

const { port: PORT, host: HOST } = readEngineListenAddress()
// Only the process launcher can opt into desktop ownership; project/DB settings
// loaded below must not manufacture this capability or change the actual host.
const DESKTOP_OWNED = process.env.AETHER_DESKTOP_OWNED === '1'

/** Preserve the launch cwd so the command reads the same .env, even in an SDK install. */
function tokenShowCommand(): string {
  const dev = import.meta.url.endsWith('.ts')
  const absolute = fileURLToPath(new URL(dev ? './admin-cli.ts' : './admin-cli.js', import.meta.url))
  const local = relative(process.cwd(), absolute)
  const script = (isAbsolute(local) || local.split(sep)[0] === '..' ? absolute : local).split(sep).join('/')
  const arg = /^[a-z0-9_./:-]+$/i.test(script) ? script : "'" +
    script.replaceAll("'", process.platform === 'win32' ? "''" : "'\\''") + "'"
  return (dev ? 'npx tsx ' : 'node ') + arg + ' token show'
}

async function main() {
  try {
    // 0. 加载 .aether/ 统一配置目录（用户级 ~/.aether + 项目级 .aether/）
    //    显式字段覆盖 .env；后续 DB system_config 同步会再覆盖（DB 优先级最高）
    applyAetherConfigToEnv(loadAetherConfig())
    // Resolve managed deployment settings before mutable DB keys can redirect their location.
    // Apply them last, preserving their precedence and matching the operator CLI.
    const managedConfig = loadManagedConfig()

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
      // Authentication and instance identity are deployment trust settings.
      // A mutable UI/database value must not silently replace the process
      // startup contract (or turn a running server into an anonymous one).
      if (TRUSTED_STARTUP_KEYS.has(key)) continue
      if (value !== null && value !== '') {
        process.env[key] = value
      }
    }
    // logger.info({ keys: Object.keys(dbConfig).length }, 'Synced system_config from DB to process.env')

    // 3.5 加载受管配置 (Managed Settings) 并应用（最高优先级，覆盖 DB 和本地配置）
    applyAetherConfigToEnv(managedConfig, true)

    // 4. SkillsRegistry 必须在 DB→env 同步之后启动：
    //    SKILLS_ROOT / AETHER_GLOBAL_DIR 等路径配置此时才最终定型，
    //    否则 registry 的双层状态（项目层/全局层）会与导入管线的目录解析分裂
    skillsRegistry.start()

    const server = await buildServer({ listenHost: HOST, desktopOwned: DESKTOP_OWNED })
    const endpoint = new URL(await server.listen({ port: PORT, host: HOST }))
    const bound = server.server.address()
    const wildcard = !!bound && typeof bound === 'object' && (bound.address === '0.0.0.0' || bound.address === '::')
    if (wildcard) endpoint.hostname = bound.address === '::' ? '[::1]' : '127.0.0.1'
    const auditMaintenance = startAuditMaintenance()
    const historyMaintenance = startHistoryMaintenance(getDb())
    
    const localUrl = endpoint.origin
    const lanUrls = wildcard ? Object.values(networkInterfaces()).flatMap(interfaces =>
      (interfaces ?? []).filter(net => net.family === 'IPv4' && !net.internal)
        .map(net => `http://${net.address}:${endpoint.port || '80'}`)).join(', ') : ''
    const adminUrl = new URL('/admin/', endpoint).href
    const tokenState = getStartupInstanceTokenState()
    
    logger.info({ 
      port: Number(endpoint.port || 80),
      host: HOST,
      localUrl,
      lanUrls, adminUrl, instanceToken: tokenState
    }, 'Aether Engine started')

    console.log(`\n🚀 Aether Engine (AE) 已启动`)
    console.log(`   服务地址: ${localUrl}`)
    console.log(`   管理后台: ${adminUrl}`)
    const tokenLabel = { configured: '已配置', 'not-set': '未设置（实例门禁未启用）', empty: '配置为空（受保护的请求将被拒绝）' }[tokenState]
    console.log(`   实例令牌: ${tokenLabel}`)
    if (DESKTOP_OWNED) {
      console.log('   此实例的连接令牌由 Aether 桌面管理。')
    } else {
      console.log(`   在服务的启动目录及相同环境查看令牌: ${tokenShowCommand()}`)
    }
    if (lanUrls) {
      console.log(`   局域网访问: ${lanUrls}`)
    }
    console.log()

    // 优雅关闭：停止文件监听
    let shutdownPromise: Promise<void> | undefined
    const shutdown = (): Promise<void> => shutdownPromise ??= observeShutdownStage(logger, 'engine.shutdown', async () => {
      await observeShutdownStage(logger, 'engine.consolidator.stop', () => consolidator.stopDaemon())
      await observeShutdownStage(logger, 'engine.skills.stop', () => skillsRegistry.stop())
      await observeShutdownStage(logger, 'http.server.close', () => server.close())
      await observeShutdownStage(logger, 'maintenance.audit.stop', () => auditMaintenance.stop())
      await observeShutdownStage(logger, 'maintenance.history.stop', () => historyMaintenance.stop())
      const receipts = await Promise.all([
        observeShutdownStage(logger, 'sqlite.memory.close', () => closeMemoryDb()),
        observeShutdownStage(logger, 'sqlite.main.close', () => closeDb()),
      ])
      const unhealthy = receipts.filter(receipt => receipt && !receipt.healthy)
      if (unhealthy.length) throw new Error('Database cleanup unknown: ' + JSON.stringify(unhealthy))
    }).then(() => {
      process.exit(0)
    })
    const requestShutdown = (signal: string) => void shutdown().catch(() => {
      // Stage outcomes identify the failed join without logging exception data.
      logger.error({ signal }, 'Shutdown failed; preserving nonzero exit and unknown cleanup evidence')
      process.exitCode = 1
    })
    process.once('SIGINT', () => requestShutdown('SIGINT'))
    process.once('SIGTERM', () => requestShutdown('SIGTERM'))
  } catch (err) {
    logger.error({ err }, 'Failed to start server')
    process.exit(1)
  }
}

void main()
