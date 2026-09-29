import type { Tool, AgentContext, ToolResult } from '../../core/agent-context/index.js'
import { guardedHttp } from '../../security/guarded-http.js'
import { getSecurityMode } from '../../security/policy-engine.js'

export interface AuthConfig {
  type: 'basic' | 'bearer' | 'apikey' | 'digest' | 'oauth2' | 'custom'
  username?: string
  password?: string
  token?: string
  apiKey?: string
  apiKeyHeader?: string
  apiKeyPrefix?: string
  oauth2TokenUrl?: string
  oauth2ClientId?: string
  oauth2ClientSecret?: string
  oauth2Scope?: string
  customHeaders?: Record<string, string>
}

/**
 * HTTP Request 工具
 *
 * 发起 HTTP 请求，支持多种认证方式
 */
export const httpRequestTool: Tool = {
  name: 'http_request',
  displayName: 'HTTP 请求',
  description: 'HTTP 请求，支持 GET/POST/PUT/DELETE，支持 basic/bearer/apikey 认证',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string' },
      method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'] },
      headers: { type: 'object' },
      body: { type: 'string', description: '请求体' },
      timeout: { type: 'integer', description: '超时ms，默认30000' },
      auth: {
        type: 'object',
        description: '认证: {type:"bearer",token:"xxx"} 或 {type:"basic",username,password} 或 {type:"apikey",apiKey,apiKeyHeader,apiKeyPrefix}',
      },
      followRedirects: { type: 'boolean' },
      responseType: { type: 'string', enum: ['auto', 'json', 'text'] }
    },
    required: ['url']
  },
  async execute(rawArgs: unknown, ctx: AgentContext): Promise<ToolResult> {
    const { 
      url, 
      method = 'GET', 
      headers = {}, 
      body, 
      timeout = 30000,
      auth,
      followRedirects = true,
      responseType = 'auto'
    } = rawArgs as any

    try {
      let parsedUrl: URL
      try {
        parsedUrl = new URL(url)
      } catch {
        return { success: false, output: `❌ 无效的 URL 格式: ${url}` }
      }

      if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
        return { success: false, output: `❌ 只支持 http 和 https 协议的 URL` }
      }


      ctx.logger.info(`[http_request] ${method} ${url}`)

      // 构建请求头（包含认证）
      const requestHeaders = await buildHeaders(headers, auth, ctx)

      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), timeout)

      try {
        const response = await guardedHttp(url, ctx, 'http_request', {
          method,
          headers: requestHeaders,
          body: body && ['POST', 'PUT', 'PATCH'].includes(method) ? body : undefined,
          signal: ctx.signal ? AbortSignal.any([controller.signal, ctx.signal]) : controller.signal,
          timeoutMs: timeout,
          followRedirects
        })

        clearTimeout(timeoutId)

        const statusText = response.statusText || ''
        const responseHeaders: Record<string, string> = {}
        response.headers.forEach((value, key) => {
          responseHeaders[key.toLowerCase()] = value
        })

        const contentType = response.headers.get('content-type') || ''
        let responseBody = ''

        if (responseType === 'binary') {
          const buffer = await response.arrayBuffer()
          responseBody = `[Binary data: ${buffer.byteLength} bytes]`
        } else {
          responseBody = await response.text()
        }

        let parsedBody: any = null
        if ((responseType === 'auto' || responseType === 'json') && contentType.includes('application/json')) {
          try {
            parsedBody = JSON.parse(responseBody)
            responseBody = JSON.stringify(parsedBody, null, 2)
          } catch {
            // JSON 解析失败，保持原始文本
          }
        }

        // full-access 模式下不截断，其他模式限制 50000 字符
        const mode = getSecurityMode(ctx.tenantId, ctx.sessionId)
        const maxLength = mode === 'full-access' ? Infinity : 50000
        if (responseBody.length > maxLength) {
          responseBody = responseBody.slice(0, maxLength) + `\n\n... [响应已截断，原长度: ${responseBody.length} 字符]`
        }

        const result = [
          `✅ HTTP 请求成功`,
          ``,
          `**请求信息**`,
          `- URL: ${url}`,
          `- 方法: ${method}`,
          `- 认证方式: ${auth?.type || '无'}`,
          `- 请求头: ${JSON.stringify(headers, null, 2)}`,
          body ? `- 请求体: ${body.slice(0, 2000)}${body.length > 2000 ? '...' : ''}` : '',
          ``,
          `**响应信息**`,
          `- 状态码: ${response.status} ${statusText}`,
          `- Content-Type: ${contentType}`,
          ``,
          `**响应头**`,
          `\`\`\`json`,
          JSON.stringify(responseHeaders, null, 2),
          `\`\`\``,
          ``,
          `**响应体**`,
          contentType.includes('application/json') ? '```json' : '```',
          responseBody,
          '```',
        ].filter(Boolean).join('\n')

        ctx.logger.info(`[http_request] ${method} ${url} -> ${response.status}`)

        return { success: true, output: result }
      } catch (fetchErr: any) {
        clearTimeout(timeoutId)
        throw fetchErr
      }
    } catch (err: any) {
      ctx.logger.error(`[http_request] ${method} ${url} failed: ${err.message}`)

      if (err.name === 'AbortError') {
        return {
          success: false,
          output: `❌ HTTP 请求超时（${timeout}ms）\nURL: ${url}\n方法: ${method}`
        }
      }

      return {
        success: false,
        output: `❌ HTTP 请求失败: ${err.message}\nURL: ${url}\n方法: ${method}`
      }
    }
  }
}

async function buildHeaders(headers: Record<string, string>, auth: AuthConfig | undefined, ctx: AgentContext): Promise<Record<string, string>> {
  const result: Record<string, string> = {
    'User-Agent': 'AI-Agent-Engine/1.0',
    ...headers
  }

  if (!auth) {
    return result
  }

  switch (auth.type) {
    case 'basic': {
      if (auth.username !== undefined && auth.password !== undefined) {
        const credentials = btoa(`${auth.username}:${auth.password}`)
        result['Authorization'] = `Basic ${credentials}`
        ctx.logger.info('[http_request] Using Basic authentication')
      }
      break
    }

    case 'bearer': {
      if (auth.token) {
        result['Authorization'] = `Bearer ${auth.token}`
        ctx.logger.info('[http_request] Using Bearer authentication')
      }
      break
    }

    case 'apikey': {
      if (auth.apiKey) {
        const headerName = auth.apiKeyHeader || 'Authorization'
        const prefix = auth.apiKeyPrefix ? `${auth.apiKeyPrefix} ` : ''
        result[headerName] = `${prefix}${auth.apiKey}`
        ctx.logger.info(`[http_request] Using API Key authentication (header: ${headerName})`)
      }
      break
    }

    case 'custom': {
      if (auth.customHeaders) {
        Object.assign(result, auth.customHeaders)
        ctx.logger.info('[http_request] Using custom authentication headers')
      }
      break
    }

    default:
      ctx.logger.warn(`[http_request] Unknown auth type: ${auth.type}`)
  }

  return result
}
