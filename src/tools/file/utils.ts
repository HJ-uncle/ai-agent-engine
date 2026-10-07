import fs from 'node:fs'
import path from 'node:path'
import type { AgentContext } from '../../core/agent-context/index.js'
import { IMAGE_MAGIC_BYTES } from './constants.js'

export function cellValueToString(val: unknown): string {
  if (val === null || val === undefined) return ''
  if (typeof val === 'string') return val
  if (typeof val === 'number') return String(val)
  if (typeof val === 'boolean') return String(val)
  if (val instanceof Date) {
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${val.getFullYear()}-${pad(val.getMonth() + 1)}-${pad(val.getDate())}`
  }
  if (typeof val === 'object') {
    const obj = val as Record<string, unknown>
    if ('formula' in obj || 'result' in obj || 'sharedFormula' in obj) {
      return cellValueToString(obj.result)
    }
    if ('richText' in obj && Array.isArray(obj.richText)) {
      return (obj.richText as Array<{ text?: string }>).map(r => r.text ?? '').join('')
    }
    if ('error' in obj) return `#${obj.error}`
    if ('text' in obj && 'hyperlink' in obj) return String(obj.text)
    return JSON.stringify(val)
  }
  return String(val)
}

export function extractCodeSummary(content: string, ext: string): string {
  const lines = content.split('\n')
  const summary: string[] = []
  let inClassOrFunc = false
  
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    
    if (ext === '.ts' || ext === '.js' || ext === '.tsx' || ext === '.jsx') {
      if (/^(export\s+)?(class|interface|type|function|const\s+\w+\s*=\s*(async\s*)?\([^)]*\)\s*=>)/.test(trimmed)) {
        summary.push(line)
        inClassOrFunc = true
      } else if (inClassOrFunc && /^}/.test(trimmed)) {
        summary.push(line)
        inClassOrFunc = false
      } else if (trimmed.startsWith('//') || trimmed.startsWith('/*')) {
        summary.push(line)
      }
    } else if (ext === '.py') {
      if (/^(def|class)\s+\w+/.test(trimmed)) {
        summary.push(line)
      } else if (trimmed.startsWith('#')) {
        summary.push(line)
      }
    } else if (ext === '.go') {
      if (/^(func|type)\s+\w+/.test(trimmed)) {
        summary.push(line)
      } else if (trimmed.startsWith('//')) {
        summary.push(line)
      }
    }
  }
  
  if (summary.length < 5 && lines.length > 20) {
    return lines.slice(0, 100).join('\n') + '\n... (内容过长，仅显示前100行)'
  }
  
  return summary.join('\n') + '\n... (仅显示代码签名和注释，完整内容需具体分析)'
}

export function listRecursive(baseDir: string, currentDir: string): string[] {
  const entries: string[] = []
  for (const name of fs.readdirSync(currentDir)) {
    const fullPath = path.join(currentDir, name)
    const rel = path.relative(baseDir, fullPath)
    // Treat symlinks as leaf entries so a workspace link cannot create a
    // recursive cycle or make list_files escape the requested tree.
    const stat = fs.lstatSync(fullPath)
    if (stat.isDirectory()) {
      entries.push(`${rel}/`)
      entries.push(...listRecursive(baseDir, fullPath))
    } else {
      entries.push(rel)
    }
  }
  return entries
}

export function isVisionModelAvailable(ctx: AgentContext): boolean {
  if (ctx.modelCaps?.vision === true) return true
  if (ctx.modelCaps?.vision === false) return false

  const modelName = ctx.modelName || (ctx as any).modelName || process.env.MODEL_NAME || ''
  const lowerModel = modelName.toLowerCase()

  const textOnlyPatterns = [/qwen-long/, /qwen-math/, /qwen-audio/, /qwen-code/]
  if (textOnlyPatterns.some((re) => re.test(lowerModel))) return false

  if (lowerModel.includes('qwen') || lowerModel.includes('qwq')) return true

  const visionModels = [
    'gpt-4v', 'gpt-4-vision', 'gpt-4-turbo', 'gpt-4o',
    'claude-3-opus', 'claude-3-sonnet', 'claude-3-haiku', 'claude-3-5', 'claude-3-7',
    'gemini-pro-vision', 'gemini-1.5-pro', 'gemini-1.5-flash', 'gemini-2',
    'llava', 'bakllava',
  ]
  return visionModels.some(vm => lowerModel.includes(vm.toLowerCase()))
}

export function isValidImageFile(filePath: string): boolean {
  try {
    const fd = fs.openSync(filePath, 'r')
    const buf = Buffer.alloc(12)
    fs.readSync(fd, buf, 0, 12, 0)
    fs.closeSync(fd)

    return IMAGE_MAGIC_BYTES.some(({ signature }) =>
      signature.every((byte, i) => buf[i] === byte)
    )
  } catch {
    return false
  }
}
