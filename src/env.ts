import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { restoreEmbeddedProjectEnvironment } from './server-listen.js'

// This is main.ts's first import: restore before later imports and .env defaults.
restoreEmbeddedProjectEnvironment()

/**
 * 手动加载 .env 文件到 process.env
 * 必须在所有业务模块导入之前调用，以确保环境变量对所有模块可见
 */
export function loadEnv() {
  const envPath = join(process.cwd(), '.env')
  if (!existsSync(envPath)) return

  try {
    const env = readFileSync(envPath, 'utf8')
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
    // 忽略读取错误
  }
}

// 立即执行加载
loadEnv()
