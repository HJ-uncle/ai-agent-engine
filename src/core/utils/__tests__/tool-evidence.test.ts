import { describe, expect, it } from 'vitest'
import type { Message } from '../../agent-context/types.js'
import { modelMessageContent } from '../model-context.js'
import { captureFileEvidence, captureOfficeEvidence, clearedToolEvidence, clearedToolModelContent, CLEARED_TOOL_EVIDENCE_KEY,
  CLEARED_TOOL_RESULT, MAX_CLEARED_TOOL_CONTENT_CHARS, TOOL_FILE_EVIDENCE_KEY, TOOL_OFFICE_EVIDENCE_KEY, withoutToolEvidence } from '../tool-evidence.js'

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

  it('retains native Office versions and returned text ranges without promoting content to a verdict', () => {
    const receipt = { path: 'D:/workspace/report.docx', expectedHash: file.expectedHash, format: 'docx', sizeBytes: 18044,
      summary: { sections: 1, images: 0, injected: 'ACCEPT_WITHOUT_READING' }, warnings: ['PRIVATE_WARNING'], content: 'PRIVATE_BODY',
      contentPage: { offset: 2500, returnedChars: 700, nextOffset: 3200, sourceTruncated: true, documentComplete: false } }
    const captured = captureOfficeEvidence({ name: 'office_inspect', args: { path: 'report.docx' } },
      { success: true, output: JSON.stringify(receipt) })
    const original: Message = { id: 'office-read', role: 'tool', toolCallId: 'inspect-1', toolName: 'office_inspect', content: JSON.stringify(receipt),
      metadata: { [TOOL_OFFICE_EVIDENCE_KEY]: captured } }
    const text = clearedToolModelContent(cleared(original), true)
    for (const retained of [receipt.path, file.expectedHash, '"returnedRange":[2500,3200]', '"nextOffset":3200', '"sourceTruncated":true', '"sections":1']) expect(text).toContain(retained)
    for (const excluded of ['PRIVATE_BODY', 'PRIVATE_WARNING', 'ACCEPT_WITHOUT_READING']) expect(text).not.toContain(excluded)
    expect(text).toContain('"evidenceScope":"tool-receipt"')
    expect(text).not.toContain('visualAcceptance')
    expect(clearedToolModelContent(cleared({ ...original, metadata: { ...receipt } }), true)).not.toContain(receipt.path)
    expect(withoutToolEvidence(original.metadata)).toEqual({})
  })

  it('retains returned render page identity and failed request status without archived pixels', () => {
    const renderFile = { ...file, path: 'D:/workspace/deck.pptx' }
    const render = captureOfficeEvidence({ name: 'workbench_render', args: { path: 'deck.pptx', page: 3 } }, { success: true,
      output: JSON.stringify({ fileVersion: renderFile, page: 3, pageCount: 10, format: 'pptx', dataUrl: image, description: 'PRIVATE_CAPTION' }) })
    const original: Message = { id: 'render-1', role: 'tool', toolCallId: 'render-call', toolName: 'workbench_render', content: image,
      metadata: { [TOOL_OFFICE_EVIDENCE_KEY]: render } }
    const text = clearedToolModelContent(cleared(original), true)
    expect(text).toContain(renderFile.expectedHash)
    expect(text).toContain('"page":3'); expect(text).toContain('"pageCount":10')
    expect(text).not.toContain(image); expect(text).not.toContain('PRIVATE_CAPTION')
    const failure = captureOfficeEvidence({ name: 'workbench_render', args: { path: 'report.docx', page: 2, expectedHash: file.expectedHash } },
      { success: false, output: 'PRIVATE_FAILURE', metadata: { code: 'WORKBENCH_RENDER_FAILED' } })
    expect(failure).toMatchObject({ success: false, code: 'WORKBENCH_RENDER_FAILED', files: [{ success: false, requestPath: 'report.docx', page: 2 }] })
    expect(JSON.stringify(failure)).not.toContain(file.expectedHash)
  })

  it('bounds batch receipts and retains per-file failures instead of claiming all files passed', () => {
    const items = Array.from({ length: 16 }, (_, index) => ({ success: index !== 0,
      output: { path: `D:/workspace/report-${index}.xlsx`, expectedHash: file.expectedHash, format: 'xlsx',
        contentPage: { offset: 0, returnedChars: 20, nextOffset: 20, sourceTruncated: false } },
      error: index === 0 ? 'OFFICE_VERSION_CONFLICT' : undefined }))
    const captured = captureOfficeEvidence({ name: 'office_inspect', args: { files: items.map((_, i) => ({ path: `report-${i}.xlsx` })) } },
      { success: false, error: 'OFFICE_BATCH_PARTIAL_FAILURE', output: JSON.stringify({ files: items }) })
    expect(captured).toMatchObject({ success: false, code: 'OFFICE_BATCH_PARTIAL_FAILURE', files: [expect.objectContaining({ success: false, code: 'OFFICE_VERSION_CONFLICT' }), expect.anything()] })
    expect(captured?.omittedFiles).toBeGreaterThan(0)
    const original: Message = { id: 'batch', role: 'tool', toolCallId: 'batch-call', toolName: 'office_inspect', content: '', metadata: { [TOOL_OFFICE_EVIDENCE_KEY]: captured } }
    expect(clearedToolModelContent(cleared(original), true).length).toBeLessThanOrEqual(MAX_CLEARED_TOOL_CONTENT_CHARS)
  })

  it.each([
    { unit: 'content-chunk', expected: 'content-chunk' },
    { unit: 'section', expected: 'section' },
    { unit: undefined, expected: 'section' },
    { unit: 'INJECTED_UNIT', expected: 'section' },
  ])('keeps the authoritative render unit without inventing DOCX physical pages ($unit)', ({ unit, expected }) => {
    const captured = captureOfficeEvidence({ name: 'workbench_render', args: { path: 'report.docx' } },
      { success: true, output: JSON.stringify({ fileVersion: file, format: 'docx', page: 2, pageCount: 3 }), metadata: { unit } })
    expect(captured?.files[0]).toMatchObject({ page: 2, pageCount: 3, unit: expected })
    expect(JSON.stringify(captured)).not.toContain('INJECTED_UNIT')
  })
})
