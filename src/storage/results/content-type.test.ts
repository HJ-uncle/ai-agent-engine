/** Regression coverage for immutable delivery text classification. No model,
 * window, filesystem mutation, or legacy end-to-end suite is involved. */
import { describe, expect, it } from 'vitest'
import { resultAssetIsBinary, resultAssetMimeType } from './content-type.js'

const code = Buffer.from('#!/usr/bin/env node\n// 中文脚本\nimport { spawn } from "node:child_process";\n')

describe('published source and configuration files', () => {
  it.each(['server.mjs', 'server.cjs', 'script.js', 'component.jsx', 'module.mts', 'module.cts', 'view.tsx', 'styles.css',
    'settings.yaml', 'settings.yml', 'pyproject.toml', 'settings.ini', '.env.local', 'script.ps1', 'script.sh', 'script.py',
    'Dockerfile', 'Makefile', 'LICENSE', 'pnpm-lock.yaml', 'output.log', 'custom.filetype'])('%s remains text for new and legacy manifests', name => {
    const mime = resultAssetMimeType(name, code)
    expect(mime).not.toBe('application/octet-stream')
    expect(resultAssetIsBinary(code, name, mime)).toBe(false)
    expect(resultAssetIsBinary(code, name, 'application/octet-stream')).toBe(false)
  })

  it('announces JavaScript modules with a JavaScript MIME', () => {
    expect(resultAssetMimeType('C:\\project\\SERVER.MJS', code)).toBe('text/javascript')
  })

  it.each(['application/javascript', 'application/ecmascript', 'application/json; charset=utf-8', 'application/ld+json', 'application/xml', 'application/schema+xml'])('recognizes %s without relying on a filename', mime => {
    expect(resultAssetIsBinary(Buffer.from('content'), 'source', mime)).toBe(false)
  })

  it('supports empty files and UTF-8 BOM without rewriting their bytes', () => {
    expect(resultAssetIsBinary(Buffer.alloc(0), 'empty', 'application/octet-stream')).toBe(false)
    const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), code])
    expect(resultAssetIsBinary(bom, 'bom.mjs', 'application/octet-stream')).toBe(false)
    expect(bom.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]))
  })
})

describe('binary bytes must not acquire a text hint', () => {
  it.each(['report.pdf', 'slides.pptx', 'data.xlsx', 'document.docx', 'image.svg', 'archive.zip', 'library.jar', 'animation.apng', 'film.mp4', 'sound.mp3', 'font.woff2'])('retains the binary preview for %s even with generic MIME', name => {
    expect(resultAssetIsBinary(Buffer.from('printable placeholder'), name, 'application/octet-stream')).toBe(true)
  })

  it('recognizes a printable PDF signature even with a text-looking name and MIME', () => {
    expect(resultAssetIsBinary(Buffer.from('%PDF-1.7\n1 0 obj\n'), 'source.mjs', 'text/javascript')).toBe(true)
  })

  it.each([Buffer.from([0, 1, 2]), Buffer.from([0xff, 0xfe, 0x41, 0]), Buffer.from([0xc3, 0x28]), Buffer.from('plain\x1b[31m'), Buffer.from('plain\x7f')])('rejects binary/control bytes regardless of text extension', bytes => {
    expect(resultAssetIsBinary(bytes, 'source.mjs', 'text/javascript')).toBe(true)
  })

  it('does not overlook a NUL byte beyond a small prefix probe', () => {
    expect(resultAssetIsBinary(Buffer.concat([Buffer.alloc(16384, 65), Buffer.from([0])]), 'large.mjs', 'application/octet-stream')).toBe(true)
  })

  it('preserves explicitly typed image, document and other binary payloads', () => {
    expect(resultAssetIsBinary(Buffer.from('<svg/>'), 'drawing', 'image/svg+xml', 'image')).toBe(true)
    expect(resultAssetIsBinary(Buffer.from('document'), 'no-extension', 'application/pdf')).toBe(true)
    expect(resultAssetIsBinary(Buffer.from('opaque'), 'no-extension', 'application/vnd.custom-binary')).toBe(true)
  })
})
