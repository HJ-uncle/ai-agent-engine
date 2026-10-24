import { describe, expect, it } from 'vitest'
import type { Message } from '../../agent-context/types.js'
import { modelMessageContent } from '../model-context.js'
import { captureFileEvidence, clearedToolEvidence, clearedToolModelContent, CLEARED_TOOL_EVIDENCE_KEY,
  CLEARED_TOOL_RESULT, MAX_CLEARED_TOOL_CONTENT_CHARS, TOOL_FILE_EVIDENCE_KEY } from '../tool-evidence.js'

const file = { path: 'D:/workspace/report.png', expectedHash: 'sha256:' + 'a'.repeat(64), encoding: 'binary-or-non-utf8', lineEnding: 'none', utf8Bom: false }
const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII='
function cleared(original: Message): Message {
  return { ...original, content: CLEARED_TOOL_RESULT, metadata: { ...original.metadata, [CLEARED_TOOL_EVIDENCE_KEY]: clearedToolEvidence(original) } }
}

describe('bounded cleared-tool evidence', () => {
  it('keeps exact file-byte identity without reviving archived pixels or arbitrary metadata', () => {
    const original: Message = { id: 'image-1', role: 'tool', toolCallId: 'read-1', toolName: 'read_file',
      content: JSON.stringify({ dataUrl: image, fileVersion: file }), modelInputContent: JSON.stringify({ dataUrl: image, fileVersion: file }),
      metadata: { [TOOL_FILE_EVIDENCE_KEY]: captureFileEvidence(file), arbitrary: 'INJECTED_METADATA', outputPreview: 'PRIVATE_PREVIEW',
        __aetherMicroCompactArchive: { content: 'PRIVATE_ARCHIVE' } } }
    const message = cleared(original), text = clearedToolModelContent(message, true)
    expect(text).toContain(file.path); expect(text).toContain(file.expectedHash)
    expect(text).toContain('file-bytes'); expect(text).toContain('"hadNativeImage":true')
    expect(text).toContain('"args":{"messageId":"image-1","limit":1}')
    expect(text).toContain('"imageArgs":{"messageId":"image-1","imageIndex":0}')
    for (const secret of [image, 'INJECTED_METADATA', 'PRIVATE_PREVIEW', 'PRIVATE_ARCHIVE']) expect(text).not.toContain(secret)
    expect(modelMessageContent(message)).not.toContain('search_history')
    expect(original.modelInputContent).toContain(image)
  })

  it('does not infer a trusted file version from arbitrary tool metadata or output', () => {
    const message = cleared({ id: 'untrusted', role: 'tool', toolCallId: 'call', toolName: 'read_file',
      content: JSON.stringify({ fileVersion: file }), metadata: { ...file, fileVersion: file } })
    const text = clearedToolModelContent(message, true)
    expect(text).not.toContain(file.path); expect(text).not.toContain(file.expectedHash)
    expect(text).toContain('untrusted')
    expect(captureFileEvidence({ ...file, expectedHash: 'data-url:' + 'b'.repeat(64) })).toBeUndefined()
    expect(captureFileEvidence({ ...file, path: 'report.png' })).toBeUndefined()
  })

  it('keeps a legacy marker without fabricating recovery indexes from old snapshots', () => {
    const legacy: Message = { id: 'legacy-result', role: 'tool', toolCallId: 'legacy-call', toolName: 'read_file',
      content: CLEARED_TOOL_RESULT, modelInputContent: JSON.stringify({ dataUrl: image, fileVersion: file }),
      metadata: { ...file, __aetherMicroCompactArchive: { content: image } } }
    expect(clearedToolModelContent(legacy, true)).toBe(CLEARED_TOOL_RESULT)
    expect(modelMessageContent(legacy)).toBe(CLEARED_TOOL_RESULT)
  })

  it('rejects copied indexes and never truncates an identity into a different valid path', () => {
    const message = cleared({ id: 'owned-message', role: 'tool', toolCallId: 'owned-call', toolName: 'read_file', content: 'output',
      metadata: { [TOOL_FILE_EVIDENCE_KEY]: { ...file, path: 'D:/' + '\\folder'.repeat(150) } } })
    expect(clearedToolModelContent({ ...message, id: 'foreign-message' }, true)).toBe(CLEARED_TOOL_RESULT)
    const long = clearedToolModelContent(message, true)
    expect(long.length).toBeLessThanOrEqual(MAX_CLEARED_TOOL_CONTENT_CHARS)
    expect(long).not.toContain('folder')
    const malformed = cleared({ ...message, id: 'x'.repeat(10000), toolCallId: 'bad\nINJECT', toolName: 'bad\nINJECT' })
    expect(clearedToolModelContent(malformed, true).length).toBeLessThanOrEqual(MAX_CLEARED_TOOL_CONTENT_CHARS)
    expect(clearedToolModelContent(malformed, true)).not.toContain('search_history')
    expect(clearedToolModelContent(malformed, true)).not.toContain('INJECT')
  })
})
