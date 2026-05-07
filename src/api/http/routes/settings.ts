import { FastifyInstance } from 'fastify'
import { success } from '../response.js'
import { loadSecurityConfig, saveSecurityConfig, WebFetchConfig } from '../../../tools/web-fetch/security-config.js'
import { systemConfigStore, SECRET_KEYS } from '../../../storage/sqlite/system-config.js'
import { setGlobalToolPoolLimit } from '../../../core/utils/concurrency-pool.js'

/** 所有通过 PUT /settings 保存的字段都写数据库 */
export async function settingsRoutes(fastify: FastifyInstance) {
  fastify.get('/settings', async (request, reply) => {
    const securityConfig = loadSecurityConfig()

    // 从数据库读取全部配置，fallback 到 process.env，再 fallback 到默认值
    const dbConfig = await systemConfigStore.getAll()

    const getStr = (key: string, def: string) =>
      dbConfig[key] ?? process.env[key] ?? def

    const settings = {
      // ── LLM ──────────────────────────────────────────────────────────────
      LLM_PROVIDER:      getStr('LLM_PROVIDER',      'openai'),
      LLM_PRIMARY_MODEL: getStr('LLM_PRIMARY_MODEL',  'deepseek-chat'),
      OPENAI_API_KEY:    getStr('OPENAI_API_KEY',     ''),
      OPENAI_BASE_URL:   getStr('OPENAI_BASE_URL',    'https://api.deepseek.com'),
      ANTHROPIC_API_KEY: getStr('ANTHROPIC_API_KEY',  ''),
      OLLAMA_BASE_URL:   getStr('OLLAMA_BASE_URL',    'http://localhost:11434'),
      // ── DeepSeek 专有通道 ────────────────────────────────────────────────
      DEEPSEEK_API_KEY:               getStr('DEEPSEEK_API_KEY',     ''),
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
      SKILLS_ROOT:   getStr('SKILLS_ROOT',   './skills'),
      BASH_PATH:     getStr('BASH_PATH',     ''),
      // ── Tools ────────────────────────────────────────────────────────────
      CMD_TIMEOUT_MS:      parseInt(getStr('CMD_TIMEOUT_MS',      '5000'),    10),
      MAX_FILE_SIZE_BYTES: parseInt(getStr('MAX_FILE_SIZE_BYTES', '10485760'), 10),
      WEB_SEARCH_SERVER:   getStr('WEB_SEARCH_SERVER', 'http://127.0.0.1:8923'),
      // ── Workspace ────────────────────────────────────────────────────────
      WORKSPACE_ROOT: getStr('WORKSPACE_ROOT', './workspace'),
      MCP_CONFIG_PATH: getStr('MCP_CONFIG_PATH', './mcp.config.json'),
      // ── Observability ────────────────────────────────────────────────────
      QA_LOG_ENABLED: getStr('QA_LOG_ENABLED', 'false') === 'true',
      QA_LOG_DIR:     getStr('QA_LOG_DIR',     './logs/qa'),
      // ── Performance ──────────────────────────────────────────────────────
      TOOL_CONCURRENCY_LIMIT: parseInt(getStr('TOOL_CONCURRENCY_LIMIT', '8'),      10),
      SQLITE_CACHE_KB:        parseInt(getStr('SQLITE_CACHE_KB',        '20000'),  10),
      SQLITE_MMAP_BYTES:      parseInt(getStr('SQLITE_MMAP_BYTES',      '268435456'), 10),
      SQLITE_BUSY_TIMEOUT_MS: parseInt(getStr('SQLITE_BUSY_TIMEOUT_MS', '5000'),   10),
      // ── WebFetch Security ────────────────────────────────────────────────
      webFetch: securityConfig.webFetch,
    }

    return reply.code(200).send(success(settings))
  })

  fastify.put<{ Body: Record<string, string | number | boolean | WebFetchConfig> }>('/settings', async (request, reply) => {
    const updates = request.body

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