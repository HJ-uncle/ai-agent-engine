import type { Tool, AgentContext, ToolResult } from '../../core/agent-context/index.js'
import { loadSecurityConfig, checkDomainAllowed } from './security-config.js'

/**
 * Web Fetch 工具
 *
 * 获取网页内容，支持 HTML 和 Markdown 转换，带有安全控制
 */
export const webFetchTool: Tool = {
  name: 'web_fetch',
  displayName: '获取网页内容',
  description: '获取网页内容，自动转 Markdown',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string' },
      convertToMarkdown: { type: 'boolean' },
      bypassSecurityCheck: { type: 'boolean' }
    },
    required: ['url']
  },
  async execute(rawArgs: unknown, ctx: AgentContext): Promise<ToolResult> {
    const { url, convertToMarkdown = true, bypassSecurityCheck = false } = rawArgs as any

    try {
      // 验证 URL 格式
      let parsedUrl: URL
      try {
        parsedUrl = new URL(url)
      } catch {
        return { success: false, output: `❌ 无效的 URL 格式: ${url}` }
      }

      // 安全检查（除非绕过）
      if (!bypassSecurityCheck) {
        const config = loadSecurityConfig().webFetch
        
        // 检查工具是否启用
        if (!config.enabled) {
          return { success: false, output: `❌ Web Fetch 工具已被管理员禁用` }
        }

        // 检查域名白名单/黑名单
        const checkResult = checkDomainAllowed(url, config)
        if (!checkResult.allowed) {
          ctx.logger.warn(`[web_fetch] Access denied for ${url}: ${checkResult.reason}`)
          return { success: false, output: `❌ 访问被拒绝: ${checkResult.reason}` }
        }
      }

      ctx.logger.info(`[web_fetch] Fetching URL: ${url}`)

      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; AI-Agent-Engine/1.0)',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
        signal: ctx.signal
      })

      if (!response.ok) {
        return {
          success: false,
          output: `❌ HTTP 错误: ${response.status} ${response.statusText}\nURL: ${url}`
        }
      }

      const contentType = response.headers.get('content-type') || ''
      const isHtml = contentType.includes('text/html') || contentType.includes('application/xhtml+xml')

      let content = await response.text()

      // 获取配置用于内容长度限制
      const config = loadSecurityConfig().webFetch
      
      // 限制内容长度
      if (content.length > config.maxContentLength) {
        content = content.slice(0, config.maxContentLength) + `\n\n... [内容已截断，原长度: ${content.length} 字符]`
      }

      if (convertToMarkdown && isHtml) {
        content = htmlToMarkdown(content, url)
      } else if (isHtml) {
        content = extractTextFromHtml(content)
      }

      ctx.logger.info(`[web_fetch] Successfully fetched ${content.length} characters from ${url}`)

      return {
        success: true,
        output: `✅ 网页获取成功\n\n**URL**: ${url}\n**类型**: ${isHtml ? 'HTML (已转换)' : contentType}\n**长度**: ${content.length} 字符\n\n---\n\n${content}`
      }
    } catch (err: any) {
      ctx.logger.error(`[web_fetch] Failed to fetch ${url}: ${err.message}`)
      return {
        success: false,
        output: `❌ 获取网页失败: ${err.message}\nURL: ${url}`
      }
    }
  }
}

function htmlToMarkdown(html: string, baseUrl: string): string {
  let text = html

  text = text.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
  text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')

  text = text.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, '# $1\n\n')
  text = text.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, '## $1\n\n')
  text = text.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, '### $1\n\n')
  text = text.replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, '#### $1\n\n')
  text = text.replace(/<h5[^>]*>([\s\S]*?)<\/h5>/gi, '##### $1\n\n')
  text = text.replace(/<h6[^>]*>([\s\S]*?)<\/h6>/gi, '###### $1\n\n')

  text = text.replace(/<a[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)')

  text = text.replace(/<strong[^>]*>([\s\S]*?)<\/strong>/gi, '**$1**')
  text = text.replace(/<b[^>]*>([\s\S]*?)<\/b>/gi, '**$1**')
  text = text.replace(/<em[^>]*>([\s\S]*?)<\/em>/gi, '*$1*')
  text = text.replace(/<i[^>]*>([\s\S]*?)<\/i>/gi, '*$1*')

  text = text.replace(/<ul[^>]*>([\s\S]*?)<\/ul>/gi, (match, content) => {
    return content.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, '- $1\n') + '\n'
  })
  text = text.replace(/<ol[^>]*>([\s\S]*?)<\/ol>/gi, (match, content) => {
    let idx = 1
    return content.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, `${idx++}. $1\n`) + '\n'
  })

  text = text.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, '```\n$1\n```\n')
  text = text.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, '`$1`')

  text = text.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, '$1\n\n')
  text = text.replace(/<br[^>]*>/gi, '\n')

  text = text.replace(/<[^>]+>/g, '')

  text = decodeHtmlEntities(text)

  text = text.replace(/[ \t]+/g, ' ')
  text = text.replace(/\n{3,}/g, '\n\n')
  text = text.trim()

  return text
}

function extractTextFromHtml(html: string): string {
  return htmlToMarkdown(html, '')
}

function decodeHtmlEntities(text: string): string {
  const entities: Record<string, string> = {
    '&nbsp;': ' ',
    '&amp;': '&',
    '&lt;': '<',
    '&gt;': '>',
    '&quot;': '"',
    '&#39;': "'",
    '&apos;': "'",
    '&mdash;': '—',
    '&ndash;': '–',
    '&hellip;': '…',
    '&copy;': '©',
    '&reg;': '®',
    '&trade;': '™',
    '&lsquo;': '\u2018',
    '&rsquo;': '\u2019',
    '&ldquo;': '\u201C',
    '&rdquo;': '\u201D',
  }

  for (const [entity, char] of Object.entries(entities)) {
    text = text.replace(new RegExp(entity, 'gi'), char)
  }

  text = text.replace(/&#(\d+);/g, (_, num) => String.fromCharCode(parseInt(num, 10)))
  text = text.replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))

  return text
}
