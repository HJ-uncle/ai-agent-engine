import { FastifyInstance, FastifyRequest } from 'fastify'
import { success, fail } from '../response.js'
import { loadSecurityConfig, saveSecurityConfig, WebFetchConfig } from '../../../tools/web-fetch/security-config.js'
import { systemConfigStore, SECRET_KEYS, BOOT_PATH_KEYS } from '../../../storage/sqlite/system-config.js'
import { setGlobalToolPoolLimit } from '../../../core/utils/concurrency-pool.js'
import { resolveOSMMode, isValidMode, OSM_MODES } from '../../../core/osm.js'
import { logger as engineLogger } from '../../../observability/index.js'

// ── Helpers ──────────────────────────────────────────────────────────────────
const getTenantId = (req: FastifyRequest) => (req as any).authContext?.tenantId ?? 'default'


let __legacyWriteWarned = false

/** 所有通过 PUT /settings 保存的字段都写数据库 */
export async function settingsRoutes(fastify: FastifyInstance) {
  fastify.get('/settings', async (request, reply) => {
    const securityConfig = loadSecurityConfig()

    // 从数据库读取全部配置，fallback 到 process.env，再 fallback 到默认值
    const dbConfig = await systemConfigStore.getAll()

    const getStr = (key: string, def: string) =>
      dbConfig[key] ?? process.env[key] ?? def

    const mask = (val: string) => {
      if (!val || val.length < 8) return val
      return `${val.slice(0, 3)}...${val.slice(-4)}`
    }

    const settings = {
      // ── LLM ──────────────────────────────────────────────────────────────
      LLM_PROVIDER:      getStr('LLM_PROVIDER',      'openai'),
      LLM_PRIMARY_MODEL: getStr('LLM_PRIMARY_MODEL',  'deepseek-chat'),
      OPENAI_API_KEY:    mask(getStr('OPENAI_API_KEY',     '')),
      OPENAI_BASE_URL:   getStr('OPENAI_BASE_URL',    'https://api.deepseek.com'),
      ANTHROPIC_API_KEY: mask(getStr('ANTHROPIC_API_KEY',  '')),
      OLLAMA_BASE_URL:   getStr('OLLAMA_BASE_URL',    'http://localhost:11434'),
      // ── DeepSeek 专有通道 ────────────────────────────────────────────────
      DEEPSEEK_API_KEY:               mask(getStr('DEEPSEEK_API_KEY',     '')),
      DEEPSEEK_BASE_URL:              getStr('DEEPSEEK_BASE_URL',    'https://api.deepseek.com'),
      DEEPSEEK_AUTO_THINKING:         getStr('DEEPSEEK_AUTO_THINKING', 'true') !== 'false',
      DEEPSEEK_THINKING_EFFORT:       getStr('DEEPSEEK_THINKING_EFFORT', 'medium'),
      DEEPSEEK_DEFAULT_JSON_MODE:     getStr('DEEPSEEK_DEFAULT_JSON_MODE', 'false') === 'true',
      DEEPSEEK_INCLUDE_STREAM_USAGE:  getStr('DEEPSEEK_INCLUDE_STREAM_USAGE', 'true') !== 'false',
      DEEPSEEK_LOG_CACHE_HITS:        getStr('DEEPSEEK_LOG_CACHE_HITS', 'true') !== 'false',
      // ── Agent ────────────────────────────────────────────────────────────
      MAX_ITERATIONS:          parseInt(getStr('MAX_ITERATIONS',          '50'),      10),
      TOKEN_BUDGET:            parseInt(getStr('TOKEN_BUDGET',            '80000'),   10),
      HISTORY_MAX_TOKENS:      parseInt(getStr('HISTORY_MAX_TOKENS',      '20000'),   10),
      TOOL_OUTPUT_MAX_CHARS:   parseInt(getStr('TOOL_OUTPUT_MAX_CHARS',   '4000'),    10),
      COMPRESS_THRESHOLD_RATIO: parseFloat(getStr('COMPRESS_THRESHOLD_RATIO', '0.5')),
      // ── Skills ───────────────────────────────────────────────────────────
      // 路径类配置默认空 = 自动探测 .aether/ 约定目录（不要回填旧默认 './skills'）
      SKILLS_ROOT:   getStr('SKILLS_ROOT',   ''),
      BASH_PATH:     getStr('BASH_PATH',     ''),
      // ── Tools ────────────────────────────────────────────────────────────
      CMD_TIMEOUT_MS:      parseInt(getStr('CMD_TIMEOUT_MS',      '5000'),    10),
      MAX_FILE_SIZE_BYTES: parseInt(getStr('MAX_FILE_SIZE_BYTES', '10485760'), 10),
      WEB_SEARCH_SERVER:   getStr('WEB_SEARCH_SERVER', 'http://127.0.0.1:8923'),
      // ── Workspace ────────────────────────────────────────────────────────
      WORKSPACE_ROOT: getStr('WORKSPACE_ROOT', './workspace'),
      // 空默认 = 自动探测 .aether/mcp.json（双层合并：项目级覆盖全局级）
      MCP_CONFIG_PATH: getStr('MCP_CONFIG_PATH', ''),
      // ── Observability ────────────────────────────────────────────────────
      QA_LOG_ENABLED: getStr('QA_LOG_ENABLED', 'false') === 'true',
      QA_LOG_DIR:     getStr('QA_LOG_DIR',     './logs/qa'),
      // ── Memory ───────────────────────────────────────────────────────────
      MEMORY_CONSOLIDATION_INTERVAL_HOURS: parseInt(getStr('MEMORY_CONSOLIDATION_INTERVAL_HOURS', '24'), 10),
      MEMORY_DECAY_THRESHOLD: parseFloat(getStr('MEMORY_DECAY_THRESHOLD', '0.05')),
      // ── Performance ──────────────────────────────────────────────────────
      TOOL_CONCURRENCY_LIMIT: parseInt(getStr('TOOL_CONCURRENCY_LIMIT', '8'),      10),
      SQLITE_CACHE_KB:        parseInt(getStr('SQLITE_CACHE_KB',        '20000'),  10),
      SQLITE_MMAP_BYTES:      parseInt(getStr('SQLITE_MMAP_BYTES',      '268435456'), 10),
      SQLITE_BUSY_TIMEOUT_MS: parseInt(getStr('SQLITE_BUSY_TIMEOUT_MS', '5000'),   10),
// ── OSM 增强模式 ──────────────────────────────────────────────
      // 新字段（推荐）：OSM_MODE。值由 resolveOSMMode() 统一决议，
      // 即使只存了 legacy SUPERPOWER_ENABLED 也能翻译过来返回。
      OSM_MODE: resolveOSMMode(engineLogger),
      // 兼容字段，便于旧前端切换
      SUPERPOWER_MODE: resolveOSMMode(engineLogger),
      // 保留 legacy 只读字段一个 minor 周期，便于旧前端兼容；不再是 source of truth。
      // TODO(remove-in-next-minor): 下个 minor 版本移除。
      SUPERPOWER_ENABLED: getStr('SUPERPOWER_ENABLED', 'false') === 'true',
      // ── WebFetch Security ────────────────────────────────────────────────
      webFetch: securityConfig.webFetch,
    }

    return reply.code(200).send(success(settings))
  })

  fastify.put<{ Body: Record<string, string | number | boolean | WebFetchConfig> }>('/settings', async (request, reply) => {
    const updates = request.body

    // ── OSM 校验 ────────────────────────────────────────────────────
    // 同时传入 OSM_MODE 和 SUPERPOWER_ENABLED 视为冲突，防止语义歧义。
    const hasMode = Object.prototype.hasOwnProperty.call(updates, 'OSM_MODE') || Object.prototype.hasOwnProperty.call(updates, 'SUPERPOWER_MODE')
    const hasLegacy = Object.prototype.hasOwnProperty.call(updates, 'SUPERPOWER_ENABLED')
    if (hasMode && hasLegacy) {
      return reply.code(400).send(fail(
        400,
        'OSM_MODE 与 SUPERPOWER_ENABLED 不能同时写入；请只使用 OSM_MODE（legacy 字段已 deprecated）',
      ))
    }
    const modeValue = updates['OSM_MODE'] || updates['SUPERPOWER_MODE']
    if (hasMode && !isValidMode(modeValue)) {
      return reply.code(400).send(fail(
        400,
        `OSM_MODE 非法值；可选: ${OSM_MODES.join(' | ')}`,
      ))
    }
    if (hasLegacy && !__legacyWriteWarned) {
      __legacyWriteWarned = true
      engineLogger.warn(
        {},
        'DEPRECATION: PUT /settings with SUPERPOWER_ENABLED is deprecated; use SUPERPOWER_MODE. Will be removed in the next minor release.',
      )
    }

    // webFetch 仍保存在 security config JSON 文件（结构复杂，不适合 kv 存储）
    if (updates.webFetch) {
      const securityConfig = loadSecurityConfig()
      securityConfig.webFetch = updates.webFetch as WebFetchConfig
      saveSecurityConfig(securityConfig)
      delete updates.webFetch
    }

    // 其余所有字段写入数据库
    for (const [k, v] of Object.entries(updates)) {
      const strVal = String(v)
      // 敏感字段安全校验：如果是脱敏后的占位符（包含 ...），则忽略不更新，防止覆盖真实密钥
      if (SECRET_KEYS.has(k) && strVal.includes('...')) {
        continue
      }
      // 路径类配置：空值 = 恢复自动探测（删除 DB 行）；非空持久化但只在下次启动生效。
      // 禁止热写入 process.env —— SkillsRegistry/MCP 双层状态在启动时已定型，
      // 运行时改写会让「全局导入」等操作落盘到与界面显示不一致的目录。
      if (BOOT_PATH_KEYS.has(k)) {
        if (strVal === '') {
          await systemConfigStore.delete(k)
        } else {
          await systemConfigStore.set(k, strVal, false)
        }
        continue
      }
      await systemConfigStore.set(k, strVal, SECRET_KEYS.has(k))
      // 同步更新 process.env，保证当前进程内立即生效
      process.env[k] = strVal
    }

    // 立即应用：工具并发池大小可热更
    if (updates['TOOL_CONCURRENCY_LIMIT'] !== undefined) {
      const n = parseInt(String(updates['TOOL_CONCURRENCY_LIMIT']), 10)
      if (!isNaN(n)) setGlobalToolPoolLimit(n)
    }

    return reply.code(200).send(success({ updated: true }))
  })
}