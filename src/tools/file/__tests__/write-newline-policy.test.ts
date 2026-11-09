import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createClient, type Client } from '@libsql/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentContext, ToolResult } from '../../../core/agent-context/index.js'
import * as database from '../../../storage/sqlite/db.js'
import { ChangeStore } from '../../../storage/changes/index.js'
import { clearSecurityMode, setSecurityMode } from '../../../security/policy-engine.js'
import { hashFileContent } from '../../../shared/file-version.js'
import { normalizeWriteFileArgs } from '../../../shared/write-file-args.js'
import { parseXmlToolCalls } from '../../../core/llm-adapter/openai.js'
import { compactBuiltinToolDefinition } from '../../model-tool-definitions.js'
import { readFileTool, writeFileTool } from '../super-file-tool.js'

let root: string, db: Client, ctx: AgentContext, changes: ChangeStore
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'aether-newline-policy-'))
  vi.stubEnv('AUTH_ENABLED', 'false')
  vi.stubEnv('DATA_DIR', path.join(root, 'agent.db'))
  db = createClient({ url: 'file::memory:' })
  vi.spyOn(database, 'getDb').mockReturnValue(db)
  changes = new ChangeStore()
  ctx = { tenantId: 'newline-policy', sessionId: path.basename(root), rootSessionId: path.basename(root),
    rootRunId: 'newline-run', turnId: 'newline-turn', toolProfile: 'general', workspacePaths: [root], projectRoot: root,
    cwd: root, scratchDir: path.join(root, 'scratch'),
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } } as unknown as AgentContext
  setSecurityMode(ctx.tenantId, ctx.sessionId, 'safe')
})
afterEach(() => {
  clearSecurityMode(ctx.tenantId, ctx.sessionId)
  db.close()
  vi.restoreAllMocks()
  if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('aether-newline-policy-')) {
    throw new Error('Unsafe newline-policy fixture cleanup')
  }
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
  vi.unstubAllEnvs()
})

const modes = ['ordinary', 'conditional'] as const
const condition = (mode: typeof modes[number]) => mode === 'conditional' ? { expectedHash: 'missing' } : {}
function tree() {
  return fs.readdirSync(root, { recursive: true, withFileTypes: true }).map(entry => {
    const file = path.join(entry.parentPath, entry.name)
    return { path: path.relative(root, file), hash: entry.isFile() ? hashFileContent(fs.readFileSync(file)) : 'directory' }
  }).sort((a, b) => a.path.localeCompare(b.path))
}
function expectBytesAndReceipt(result: ToolResult, file: string, expected: string, ending: string) {
  expect(result.success, result.output).toBe(true)
  const bytes = fs.readFileSync(file)
  expect(bytes.equals(Buffer.from(expected, 'utf8'))).toBe(true)
  expect(result.metadata).toMatchObject({ expectedHash: hashFileContent(bytes), byteLength: bytes.length,
    trailingLineEnding: ending, fileMutationApplied: true })
  expect(result.output).toContain(`expectedHash: ${hashFileContent(bytes)}`)
  expect(result.output).toMatch(new RegExp(`byteLength["']?\\s*:\\s*${bytes.length}(?:\\D|$)`))
  expect(result.output).toMatch(new RegExp(`trailingLineEnding["']?\\s*:\\s*["']?${ending}(?:["']|\\s|,|}|$)`))
}

describe('write_file explicit trailing-newline policy', () => {
  it.each(modes)('keeps exact copies byte-identical when omitted or preserve (%s)', async mode => {
    const original = '\uFEFF第一行\r\n第二行 \t\r\n\r\n'
    const source = path.join(root, 'source.txt')
    fs.writeFileSync(source, original, 'utf8')
    const read = await readFileTool.execute({ path: source, mode: 'exact' }, ctx)
    expect(read.success).toBe(true)
    const exact = JSON.parse(read.output)
    expect(exact.contentIsComplete).toBe(true)
    for (const policy of [undefined, 'preserve']) {
      const destination = path.join(root, `${policy ?? 'default'}.txt`)
      const written = await writeFileTool.execute({ path: destination, data: exact.content, ...condition(mode),
        ...(policy === undefined ? {} : { trailingNewline: policy }) }, ctx)
      expectBytesAndReceipt(written, destination, original, 'CRLF')
      expect(written.metadata?.expectedHash).toBe(exact.expectedHash)
    }
    expect(fs.readFileSync(source, 'utf8')).toBe(original)
  })

  it.each(modes)('changes only the terminal CR/LF run and reports actual UTF-8 bytes (%s)', async mode => {
    const cases = [
      { policy: 'LF', input: '\uFEFF标题\r\n中间\n尾部 \t\r\n\r\n', expected: '\uFEFF标题\r\n中间\n尾部 \t\n', ending: 'LF' },
      { policy: 'CRLF', input: 'a\nb\r尾部 \t\n\r\n', expected: 'a\nb\r尾部 \t\r\n', ending: 'CRLF' },
      { policy: 'none', input: '\uFEFFa\r\nb \t\r\n\r\n', expected: '\uFEFFa\r\nb \t', ending: 'none' },
      // A space after a newline is content, so it must not be trimmed with the newline.
      { policy: 'LF', input: 'a\n \t', expected: 'a\n \t\n', ending: 'LF' },
      { policy: 'LF', input: '38', expected: '38\n', ending: 'LF' },
    ]
    for (const [index, sample] of cases.entries()) {
      const file = path.join(root, `result-${index}.txt`)
      const result = await writeFileTool.execute({ path: file, data: sample.input, trailingNewline: sample.policy, ...condition(mode) }, ctx)
      expectBytesAndReceipt(result, file, sample.expected, sample.ending)
      const recorded = (await changes.list(ctx.tenantId, ctx.sessionId)).find(change => change.id === result.change?.id)
      expect(recorded).toMatchObject({ oldHash: 'missing', newHash: hashFileContent(sample.expected), newContent: sample.expected })
    }
  })

  it.each(modes)('distinguishes empty files, blank lines and BOM-only content (%s)', async mode => {
    const cases = [
      { policy: undefined, input: '', expected: '', ending: 'none' },
      { policy: 'preserve', input: '\n\n', expected: '\n\n', ending: 'LF' },
      { policy: 'LF', input: '', expected: '\n', ending: 'LF' },
      { policy: 'CRLF', input: '', expected: '\r\n', ending: 'CRLF' },
      { policy: 'none', input: '\r\n\n\r', expected: '', ending: 'none' },
      { policy: 'LF', input: '\uFEFF', expected: '\uFEFF\n', ending: 'LF' },
      { policy: 'none', input: '\uFEFF\r\n\n', expected: '\uFEFF', ending: 'none' },
    ]
    for (const [index, sample] of cases.entries()) {
      const file = path.join(root, `empty-${index}.txt`)
      const result = await writeFileTool.execute({ path: file, data: sample.input, ...condition(mode),
        ...(sample.policy === undefined ? {} : { trailingNewline: sample.policy }) }, ctx)
      expectBytesAndReceipt(result, file, sample.expected, sample.ending)
    }
  })

  it('is idempotent when the saved bytes are resubmitted under the current version', async () => {
    for (const policy of ['LF', 'CRLF', 'none'] as const) {
      const file = path.join(root, `repeat-${policy}.txt`)
      const first = await writeFileTool.execute({ path: file, data: '内容 \t\r\n\n', trailingNewline: policy, createOnly: true }, ctx)
      expect(first.success).toBe(true)
      const originalBytes = fs.readFileSync(file)
      const repeated = await writeFileTool.execute({ path: file, data: originalBytes.toString('utf8'), trailingNewline: policy,
        expectedHash: first.metadata!.expectedHash }, ctx)
      expect(repeated.success).toBe(true)
      expect(fs.readFileSync(file).equals(originalBytes)).toBe(true)
      expect(repeated.metadata?.expectedHash).toBe(first.metadata?.expectedHash)
    }
  })

  it('rejects a stale expectedHash without publishing normalized bytes or creating staging directories', async () => {
    const file = path.join(root, 'protected.txt')
    fs.writeFileSync(file, 'external winner\r\n')
    const before = tree()
    const result = await writeFileTool.execute({ path: file, data: 'replacement', trailingNewline: 'LF',
      expectedHash: hashFileContent('old revision') }, ctx)
    expect(result).toMatchObject({ success: false, error: 'WRITE_VERSION_CONFLICT', metadata: { fileMutationApplied: false } })
    expect(tree()).toEqual(before)
    expect(await changes.list(ctx.tenantId, ctx.sessionId)).toHaveLength(0)
  })

  it.each(modes)('rejects invalid policy values and non-string opt-in payloads before changing any directory (%s)', async mode => {
    const before = tree()
    const invalid = [
      ...[null, true, 1, 'lf', 'auto', {}, []].map(trailingNewline => ({ data: 'body', trailingNewline })),
      ...[null, true, 1, { text: 'body' }, ['body']].map(data => ({ data, trailingNewline: 'LF' })),
      { data: 'body\u0000tail', trailingNewline: 'LF' },
      { data: 'unpaired \uD800', trailingNewline: 'LF' },
    ]
    for (const args of invalid) {
      const result = await writeFileTool.execute({ path: path.join(root, 'never-created/deep/file.txt'), ...args, ...condition(mode) }, ctx)
      expect(result).toMatchObject({ success: false, metadata: { fileMutationApplied: false } })
      expect(result.error).toBeTruthy()
      expect(tree()).toEqual(before)
    }
    expect(await changes.list(ctx.tenantId, ctx.sessionId)).toHaveLength(0)
  })

  it.each(modes)('rejects JSON, Office and binary targets without invoking a format writer (%s)', async mode => {
    const before = tree()
    for (const extension of ['json', 'csv', 'docx', 'xlsx', 'pptx', 'pdf', 'png', 'exe', 'zip']) {
      const result = await writeFileTool.execute({ path: path.join(root, `never-created/file.${extension}`), data: 'body',
        trailingNewline: 'LF', ...condition(mode) }, ctx)
      expect(result).toMatchObject({ success: false, metadata: { fileMutationApplied: false } })
      expect(result.error).toBeTruthy()
      expect(tree()).toEqual(before)
    }
    expect(await changes.list(ctx.tenantId, ctx.sessionId)).toHaveLength(0)
  })

  it('keeps legacy non-text payload behavior when the policy is omitted', async () => {
    const file = path.join(root, 'legacy.json')
    const result = await writeFileTool.execute({ path: file, data: { title: '保持兼容', value: 38 } }, ctx)
    expect(result.success).toBe(true)
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ title: '保持兼容', value: 38 })
    const emptyValue = await writeFileTool.execute({ path: path.join(root, 'null.txt'), data: null }, ctx)
    expect(emptyValue.success).toBe(true)
    expect(fs.readFileSync(path.join(root, 'null.txt'), 'utf8')).toBe('null')
  })

  it('keeps schema optional and carries the policy through normalization, XML and compact tool definitions', async () => {
    const definition = compactBuiltinToolDefinition(writeFileTool)
    expect(definition.parameters.properties?.trailingNewline).toMatchObject({ type: 'string', enum: ['preserve', 'LF', 'CRLF', 'none'] })
    expect(definition.parameters.required ?? []).not.toContain('trailingNewline')
    const singleShape = (definition.parameters.oneOf as Array<{ required?: string[] }>).find(shape => shape.required?.includes('path'))
    expect(singleShape?.required).toEqual(['path'])
    expect(definition.parameters.properties?.files.items?.required).not.toContain('trailingNewline')
    const normalization = normalizeWriteFileArgs({ path: 'example.txt', content: 'text\r\n\n', trailingNewline: 'none' })
    expect(normalization).toMatchObject({ ok: true, args: { data: 'text\r\n\n', trailingNewline: 'none' } })
    const json = parseXmlToolCalls('<tool_call>{"name":"write_file","arguments":{"path":"json-call.txt","data":"38","trailingNewline":"LF","createOnly":true}}</tool_call>')
    const xml = parseXmlToolCalls('<tool_call><function=write_file><parameter=path>xml-call.txt</parameter><parameter=data>38</parameter><parameter=trailingNewline>LF</parameter><parameter=expectedHash>missing</parameter></function></tool_call>')
    // XML raw numeric text is currently parsed as a number: quote the string as a
    // real model XML emitter can, so this test targets policy loss, not that old coercion.
    const quotedXml = parseXmlToolCalls('<tool_call><function=write_file><parameter=path>xml-call.txt</parameter><parameter=data>"38"</parameter><parameter=trailingNewline>LF</parameter><parameter=expectedHash>missing</parameter></function></tool_call>')
    expect(xml[0].args.trailingNewline).toBe('LF')
    for (const invocation of [json[0], quotedXml[0]]) {
      expect(invocation.args.trailingNewline).toBe('LF')
      const result = await writeFileTool.execute(invocation.args, ctx)
      expectBytesAndReceipt(result, path.join(root, String(invocation.args.path)), '38\n', 'LF')
    }
  })
})
