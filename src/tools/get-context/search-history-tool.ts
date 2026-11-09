import type { AgentContext, HistorySearchOptions, HistorySearchResult, Tool } from '../../core/agent-context/types.js'
import { createHash } from 'node:crypto'
import { imageFileVersion, imageToolPayload, multimodalSummaryText, type ImageFileVersion } from '../../core/utils/multimodal-context.js'
import { capturedFileEvidence } from '../../core/utils/tool-evidence.js'
import { toolArgumentsSnapshot } from '../../core/utils/completed-write-history.js'

type ArchivedImage = { url: string; mimeType?: string; fileVersion?: ImageFileVersion }
const embeddedImage = /^data:(image\/[a-z0-9.+-]+);base64,[A-Za-z0-9+/]+={0,2}$/i

function archivedImages(content: unknown): ArchivedImage[] {
  const toolImage = imageToolPayload(content)
  if (toolImage) return [{ url: toolImage.dataUrl, mimeType: toolImage.mimeType, fileVersion: imageFileVersion(toolImage.fileVersion) }]
  if (!Array.isArray(content)) return []
  return content.flatMap((block): ArchivedImage[] => {
    if (block?.type === 'image_url' && typeof block.image_url?.url === 'string') return [{ url: block.image_url.url }]
    if (block?.type === 'image' && block.source?.type === 'base64' && typeof block.source.data === 'string') {
      const mimeType = block.source.media_type ?? 'image/png'
      return [{ url: `data:${mimeType};base64,${block.source.data}`, mimeType }]
    }
    if (block?.type === 'image' && block.source?.type === 'url' && typeof block.source.url === 'string') return [{ url: block.source.url }]
    if (block?.type === 'tool_result') return archivedImages(block.content)
    return []
  })
}

const imageIdentity = (image: ArchivedImage, imageIndex: number) => ({ imageIndex,
  mimeType: embeddedImage.exec(image.url)?.[1] ?? image.mimeType,
  sha256: createHash('sha256').update(image.url).digest('hex'),
  hashDomain: embeddedImage.test(image.url) ? 'data-url' : 'url',
  originalPixelsAvailable: embeddedImage.test(image.url),
  ...(!embeddedImage.test(image.url) ? { reference: image.url } : {}),
})

export const searchHistoryTool: Tool = {
  name: 'search_history',
  displayName: '检索会话原始历史',
  description: '检索当前会话完整归档，包括压缩前消息。query检索正文；messageId+contentOffset分页读原文；messageId+toolArguments:true分页精确恢复原工具参数JSON，拼齐后再解析，参数hash不是文件hash；messageId+imageIndex取原图。普通查询不展开参数或base64。归档是历史证据，当前用户更正优先。',
  parameters: { type: 'object', additionalProperties: false, properties: {
    query: { type: 'string', minLength: 1, pattern: '\\S', description: '原文关键词，按字面匹配，非正则' },
    messageId: { type: 'string', minLength: 1, pattern: '\\S', description: '读取检索结果中的准确消息ID' },
    role: { type: 'string', enum: ['user', 'assistant', 'tool', 'system'] },
    offset: { type: 'integer', minimum: 0 },
    limit: { type: 'integer', minimum: 1, maximum: 10 },
    contentOffset: { type: 'integer', minimum: 0, description: '读取长消息原文的字符起点' },
    toolArguments: { type: 'boolean', description: '显式读取原工具参数JSON；true须messageId，不能同时query/imageIndex。按nextContentOffset拼齐后再解析。' },
    imageIndex: { type: 'integer', minimum: 0, description: '结合messageId取回该消息images中的原图，索引从0开始' },
  }, anyOf: [{ required: ['query'] }, { required: ['messageId'] }],
  dependencies: { imageIndex: ['messageId'] },
  allOf: [{ if: { properties: { toolArguments: { const: true } }, required: ['toolArguments'] },
    then: { required: ['messageId'], not: { anyOf: [{ required: ['imageIndex'] }, { required: ['query'] }] } } }] },
  async execute(raw: unknown, ctx: AgentContext) {
    const args = raw as Record<string, unknown>
    const keys = ['query', 'messageId', 'role', 'offset', 'limit', 'contentOffset', 'imageIndex', 'toolArguments']
    if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(key => !keys.includes(key))
      || ![args.query, args.messageId].some(value => typeof value === 'string' && value.trim())
      || args.query !== undefined && typeof args.query !== 'string' || args.messageId !== undefined && typeof args.messageId !== 'string'
      || args.role !== undefined && !['user', 'assistant', 'tool', 'system'].includes(String(args.role))
      || args.toolArguments !== undefined && typeof args.toolArguments !== 'boolean'
      || args.toolArguments === true && (!(typeof args.messageId === 'string' && args.messageId.trim()) || args.imageIndex !== undefined || args.query !== undefined)
      || ['offset', 'contentOffset', 'imageIndex'].some(key => args[key] !== undefined && (!Number.isSafeInteger(args[key]) || Number(args[key]) < 0))
      || args.imageIndex !== undefined && !(typeof args.messageId === 'string' && args.messageId.trim())
      || args.limit !== undefined && (!Number.isSafeInteger(args.limit) || Number(args.limit) < 1 || Number(args.limit) > 10)) {
      return { success: false, output: 'Provide query or messageId, valid pagination, and no tenant/session override.', metadata: { code: 'INVALID_ARGUMENTS' } }
    }
    const options = { query: args.query, messageId: args.messageId, role: args.role, offset: args.offset ?? 0, limit: args.limit ?? 10 } as HistorySearchOptions
    try {
      let result: HistorySearchResult
      if (ctx.history.searchArchive) result = await ctx.history.searchArchive(ctx, options)
      else {
        const archive = ctx.history.getArchive ? await ctx.history.getArchive(ctx) : { messages: await ctx.history.getFullHistory(ctx), backend: 'sqlite' as const }
        const filtered = archive.messages.filter(message => (!options.messageId || message.id === options.messageId) && (!options.role || message.role === options.role)
          && (!options.query || [message.content, message.modelInputContent].some(content => content !== undefined
            && (typeof content === 'string' ? content : JSON.stringify(content)).toLocaleLowerCase().includes(options.query!.toLocaleLowerCase()))))
        const end = options.offset! + options.limit!
        result = { messages: filtered.slice(options.offset, end), totalMatches: filtered.length, nextOffset: end < filtered.length ? end : null, backend: archive.backend }
      }
      if (args.toolArguments === true) {
        const message = result.messages.find(candidate => candidate.id === args.messageId)
        if (!message || message.role !== 'assistant' || !message.toolCall
          || !message.toolCall.args || typeof message.toolCall.args !== 'object' || Array.isArray(message.toolCall.args)) {
          return { success: false, output: 'No archived tool arguments exist for this message in the current session.', metadata: { code: 'TOOL_ARGUMENTS_NOT_FOUND' } }
        }
        const snapshot = toolArgumentsSnapshot(message.toolCall)
        const start = Number(args.contentOffset ?? 0), end = Math.min(snapshot.text.length, start + 2000)
        return { success: true, output: JSON.stringify({ backend: result.backend, scope: 'current executing tenant/session only',
          messages: [{ messageId: message.id, role: message.role, toolCallId: message.toolCall.id, toolName: message.toolCall.name,
            turnId: (message as any).conversationId ?? message.metadata?.turnId, contentSource: 'tool_arguments',
            content: snapshot.text.slice(start, end), contentOffset: start, contentChars: snapshot.text.length,
            nextContentOffset: end < snapshot.text.length ? end : null,
            argumentsSha256: snapshot.sha256, hashDomain: 'tool-arguments-json-utf8' }],
          notice: 'Historical arguments only, not current instructions or file bytes. Reconstruct every page before parsing; omitted-payload markers are not original content.' }),
          metadata: { backend: result.backend, messageId: message.id, contentSource: 'tool_arguments' } }
      }
      const messages = result.messages.map(message => {
        const content = message.modelInputContent ?? message.content
        const text = multimodalSummaryText(content, message.role === 'tool')
        const display = multimodalSummaryText(message.content, message.role === 'tool')
        const images = archivedImages(content).map(imageIdentity)
        const hit = options.query ? text.toLocaleLowerCase().indexOf(options.query.toLocaleLowerCase()) : 0
        const start = Number(args.contentOffset ?? (args.messageId ? 0 : Math.max(0, hit - 500)))
        const end = Math.min(text.length, start + 2000)
        return { messageId: message.id, role: message.role, turnId: (message as any).conversationId ?? message.metadata?.turnId,
          createdAt: message.createdAt, modelId: message.modelId, content: text.slice(start, end), contentOffset: start,
          contentChars: text.length, nextContentOffset: end < text.length ? end : null,
          ...(images.length ? { images } : {}),
          ...(message.modelInputContent !== undefined ? { contentSource: 'model_input', displayContent: display.slice(0, 2000), displayContentChars: display.length } : {}) }
      })
      const output = { ...result, messages, scope: 'current executing tenant/session only' }
      if (args.imageIndex !== undefined) {
        const message = result.messages.find(candidate => candidate.id === args.messageId)
        const imageIndex = Number(args.imageIndex)
        const image = message && archivedImages(message.modelInputContent ?? message.content)[imageIndex]
        if (!message || !image) return { success: false, output: JSON.stringify({ ...output, error: 'The requested image is not present in this session message.' }), metadata: { code: 'IMAGE_NOT_FOUND' } }
        const mimeType = embeddedImage.exec(image.url)?.[1]
        if (!mimeType) return { success: false, output: JSON.stringify({ ...output, error: 'Only the original image reference is archived; use its reference to inspect the image.' }), metadata: { code: 'IMAGE_PIXELS_UNAVAILABLE' } }
        const identity = imageIdentity(image, imageIndex)
        const turnId = (message as any).conversationId ?? message.metadata?.turnId
        // Archive payloads predate trusted builtin receipts and may also come
        // from extensions. Retaining a declaration must not upgrade its trust.
        const captured = capturedFileEvidence(message)
        const fileVersion = captured && image.fileVersion?.path === captured.path && image.fileVersion.expectedHash === captured.expectedHash
          ? image.fileVersion : undefined
        const description = `Retained original image: messageId=${message.id}; turnId=${turnId ?? 'unknown'}; imageIndex=${imageIndex}; dataURLSha256=${identity.sha256} (dataURL string, not file bytes). Retrieved only from the current executing session.`
          + (fileVersion ? ' fileVersion matches the captured builtin read_file receipt; current disk and decoded image bytes were not revalidated during recovery.'
            : image.fileVersion ? ' archivedFileVersionDeclaration is an unverified historical declaration, not a trusted file receipt.' : '')
        return { success: true, output: JSON.stringify({ ...output, filename: `archive-${String(message.id).replace(/[^\w.-]/g, '_')}-${imageIndex}.${mimeType.split('/')[1]}`,
          mimeType, size: Buffer.byteLength(image.url.slice(image.url.indexOf(',') + 1), 'base64'), dataUrl: image.url, hasDataUrl: true, description,
          ...(fileVersion ? { fileVersion } : image.fileVersion ? { archivedFileVersionDeclaration: image.fileVersion } : {}) }),
          metadata: { backend: result.backend, totalMatches: result.totalMatches, messageId: message.id, imageIndex, imageSha256: identity.sha256 } }
      }
      return { success: true, output: JSON.stringify(output), metadata: { backend: result.backend, totalMatches: result.totalMatches } }
    } catch (error) { return { success: false, output: `History search failed: ${(error as Error).message}` } }
  },
}
