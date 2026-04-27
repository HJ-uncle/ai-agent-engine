import fs from 'fs'
import path from 'path'

export interface WebFetchConfig {
  enabled: boolean
  allowList: string[]
  blockList: string[]
  allowListEnabled: boolean
  blockListEnabled: boolean
  allowedProtocols: string[]
  maxContentLength: number
}

export interface SecurityConfig {
  webFetch: WebFetchConfig
}

export const DEFAULT_CONFIG: SecurityConfig = {
  webFetch: {
    enabled: true,
    allowList: [],
    blockList: [
      'localhost',
      '127.0.0.1',
      '10.',
      '172.16.',
      '192.168.',
      '0.0.0.0',
      '::1'
    ],
    allowListEnabled: false,
    blockListEnabled: true,
    allowedProtocols: ['https:', 'http:'],
    maxContentLength: 50000
  }
}

const CONFIG_PATH = path.join(process.cwd(), 'config', 'security.json')

export function loadSecurityConfig(): SecurityConfig {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const content = fs.readFileSync(CONFIG_PATH, 'utf-8')
      const loadedConfig = JSON.parse(content)
      // 深层合并 webFetch 配置，确保默认值不会丢失
      return {
        ...DEFAULT_CONFIG,
        ...loadedConfig,
        webFetch: {
          ...DEFAULT_CONFIG.webFetch,
          ...loadedConfig.webFetch
        }
      }
    }
  } catch (e) {
    console.warn('[SecurityConfig] Failed to load config, using defaults:', e)
  }
  return { ...DEFAULT_CONFIG }
}

export function saveSecurityConfig(config: SecurityConfig): void {
  try {
    const dir = path.dirname(CONFIG_PATH)
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2))
  } catch (e) {
    console.error('[SecurityConfig] Failed to save config:', e)
    throw e
  }
}

export function checkDomainAllowed(url: string, config: WebFetchConfig): { allowed: boolean; reason?: string } {
  try {
    const parsedUrl = new URL(url)
    const hostname = parsedUrl.hostname.toLowerCase()

    // 检查协议
    if (!config.allowedProtocols.includes(parsedUrl.protocol)) {
      return { allowed: false, reason: `协议 ${parsedUrl.protocol} 不允许` }
    }

    // 检查黑名单
    if (config.blockListEnabled && config.blockList.length > 0) {
      for (const blocked of config.blockList) {
        const blockedLower = blocked.toLowerCase()
        if (hostname === blockedLower || hostname.endsWith('.' + blockedLower)) {
          return { allowed: false, reason: `域名 ${hostname} 在黑名单中` }
        }
      }
    }

    // 检查白名单
    if (config.allowListEnabled && config.allowList.length > 0) {
      const allowed = config.allowList.some(allowedHost => {
        const allowedLower = allowedHost.toLowerCase()
        return hostname === allowedLower || hostname.endsWith('.' + allowedLower)
      })
      if (!allowed) {
        return { allowed: false, reason: `域名 ${hostname} 不在白名单中` }
      }
    }

    return { allowed: true }
  } catch {
    return { allowed: false, reason: '无效的 URL 格式' }
  }
}
