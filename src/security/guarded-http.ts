import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import type { AgentContext } from '../core/agent-context/index.js'
import { checkNetworkAccess } from './network-policy.js'
import { throwIfAborted } from '../core/utils/abort.js'

export type NetworkContext = Pick<AgentContext, 'tenantId' | 'sessionId'>
export interface GuardedHttpOptions {
  method?: string
  headers?: Record<string, string>
  body?: string
  signal?: AbortSignal
  timeoutMs?: number
  followRedirects?: boolean
  /** Resolve on headers and expose a bounded, cancellable body for MCP SSE. */
  stream?: boolean
}

/** One transport for every code-reachable HTTP tool: validate each hop and pin checked DNS. */
export async function guardedHttp(url: string, ctx: NetworkContext, source: string, options: GuardedHttpOptions = {}): Promise<Response> {
  let target = new URL(url)
  let method = options.method ?? 'GET'
  let body = options.body
  const headers = { ...options.headers }
  for (let hop = 0; hop <= 5; hop++) {
    throwIfAborted(options.signal)
    if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) throw new Error('Only HTTP(S) URLs without embedded credentials are supported')
    const policy = await checkNetworkAccess({ url: target.href, ...ctx, source })
    if (!policy.allowed) throw new Error(`网络策略拒绝: ${policy.reason}`)
    const signal = AbortSignal.any([...(options.signal ? [options.signal] : []), AbortSignal.timeout(Math.min(options.timeoutMs ?? policy.timeoutMs, policy.timeoutMs))])
    const response = await new Promise<Response>((resolve, reject) => {
      const transport = target.protocol === 'https:' ? https : http
      const requestHeaders: Record<string, string> = {}
      for (const [key, value] of Object.entries(headers)) {
        if (!['host', 'connection', 'content-length', 'accept-encoding'].includes(key.toLowerCase())) requestHeaders[key] = value
      }
      requestHeaders.Host = target.host
      requestHeaders['Accept-Encoding'] = 'identity'
      const request = transport.request({ protocol: target.protocol,
        hostname: policy.resolvedIp ?? target.hostname.replace(/^\[|\]$/g, ''), port: target.port || undefined,
        path: target.pathname + target.search, method, headers: requestHeaders, signal,
        ...(target.protocol === 'https:' && !net.isIP(target.hostname) ? { servername: target.hostname } : {})
      }, incoming => {
        if (options.stream) {
          const responseHeaders = new Headers()
          for (const [key, value] of Object.entries(incoming.headers)) {
            if (Array.isArray(value)) value.forEach(entry => responseHeaders.append(key, entry))
            else if (value !== undefined) responseHeaders.set(key, value)
          }
          const status = incoming.statusCode ?? 500
          if ([204, 205, 304].includes(status) || method === 'HEAD') {
            incoming.resume()
            resolve(new Response(null, { status, headers: responseHeaders }))
            return
          }
          let bytes = 0
          let done = false
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              const fail = (error: Error) => {
                if (done) return
                done = true
                controller.error(error)
              }
              incoming.on('data', (chunk: Buffer) => {
                bytes += chunk.length
                if (policy.maxResponseBytes > 0 && bytes > policy.maxResponseBytes) {
                  const error = new Error(`HTTP response exceeds ${policy.maxResponseBytes} bytes`)
                  fail(error); incoming.destroy(error); request.destroy(error)
                  return
                }
                if (done) return
                controller.enqueue(chunk)
                if ((controller.desiredSize ?? 0) <= 0) incoming.pause()
              })
              incoming.once('error', fail)
              request.once('error', fail)
              incoming.once('end', () => { if (!done) { done = true; controller.close() } })
              incoming.once('close', () => { if (!done) fail(new Error('HTTP response closed before completion')) })
            },
            pull() { incoming.resume() },
            cancel() { done = true; incoming.destroy(); request.destroy() }
          })
          resolve(new Response(stream, { status, headers: responseHeaders, statusText: incoming.statusMessage }))
          return
        }
        const chunks: Buffer[] = []
        let bytes = 0
        incoming.on('data', (chunk: Buffer) => {
          bytes += chunk.length
          if (policy.maxResponseBytes > 0 && bytes > policy.maxResponseBytes) {
            const error = new Error(`HTTP response exceeds ${policy.maxResponseBytes} bytes`)
            incoming.destroy(error)
            request.destroy(error)
            return
          }
          chunks.push(chunk)
        })
        incoming.once('error', reject)
        incoming.once('end', () => {
          const responseHeaders = new Headers()
          for (const [key, value] of Object.entries(incoming.headers)) {
            if (Array.isArray(value)) value.forEach(entry => responseHeaders.append(key, entry))
            else if (value !== undefined) responseHeaders.set(key, value)
          }
          const status = incoming.statusCode ?? 500
          resolve(new Response([204, 205, 304].includes(status) || method === 'HEAD' ? null : Buffer.concat(chunks), { status, headers: responseHeaders, statusText: incoming.statusMessage }))
        })
      })
      request.once('error', reject)
      request.end(body)
    })
    const location = response.headers.get('location')
    if (options.followRedirects === false || !location || ![301, 302, 303, 307, 308].includes(response.status)) return response
    await response.body?.cancel()
    const next = new URL(location, target)
    if (next.origin !== target.origin) {
      // API keys may use arbitrary custom header names; do not forward them to a new origin.
      for (const key of Object.keys(headers)) if (!/^(accept|accept-language|content-type|user-agent)$/i.test(key)) delete headers[key]
    }
    if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === 'POST')) {
      method = 'GET'
      body = undefined
    }
    target = next
  }
  throw new Error('HTTP redirect limit exceeded')
}
