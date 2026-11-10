/** Actual PDF text integrity: selected-font coverage, control characters, pagination and neutral footers. */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createPdf, inspectPdf } from '../pdf.js'

describe('PDF text integrity and capability errors', () => {
  it('preserves ordinary text and emits page numbers without a product watermark', async () => {
    const result = await inspectPdf(await createPdf({ title: 'Review', markdown: 'Approved: 42 items.\nRemaining: 3 items.' }))
    expect(result.summary.pages).toBe(1)
    expect(result.content).toContain('Approved: 42 items.')
    expect(result.content).toContain('Remaining: 3 items.')
    expect(result.content).toContain('1 / 1')
    expect(result.content).not.toContain('Aether')
    expect(result.content).not.toContain('\u0000')
  })

  it.each([
    { markdown: 'Unsupported \u{10ffff}' },
    { title: 'Title \u{10ffff}', markdown: 'Ordinary text' },
    { markdown: '| Status | Result |\n| --- | --- |\n| Ready | \u{10ffff} |' },
  ])('rejects an absent glyph in the body, title or table instead of creating a broken PDF: %j', async input => {
    await expect(createPdf(input)).rejects.toThrow(/PDF_GLYPH_UNAVAILABLE.*U\+10FFFF/)
  })

  it.each(['A\tB', 'A\u007fB', 'A\u0085B'])('rejects control characters that PDFKit can misencode: %j', async markdown => {
    await expect(createPdf({ markdown })).rejects.toThrow('不支持的控制字符')
  })

  it('reports missing font capability while keeping the built-in ASCII path usable', async () => {
    const exists = vi.spyOn(fs, 'existsSync').mockReturnValue(false)
    try {
      await expect(createPdf({ markdown: '中文' })).rejects.toThrow('CJK_FONT_UNAVAILABLE')
      await expect(createPdf({ markdown: 'Approved ✓' })).rejects.toThrow(/PDF_GLYPH_UNAVAILABLE.*U\+2713/)
      expect((await inspectPdf(await createPdf({ markdown: 'Approved' }))).content).toContain('Approved')
    } finally { exists.mockRestore() }
  })

  it.skipIf(!fs.existsSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'Fonts', 'seguisym.ttf')))(
    'embeds a trusted symbol font and preserves a check mark in the actual PDF', async () => {
      const result = await inspectPdf(await createPdf({ markdown: 'Approved ✓' }))
      expect(result.content).toContain('Approved ✓')
      expect(result.content).not.toContain('\u0000')
    },
  )

  it('never silently drops symbols next to Chinese, including a zero-width space', async () => {
    for (const markdown of ['中文 ✓ 测试', '中\u200b文']) {
      let buffer: Buffer
      try { buffer = await createPdf({ markdown }) }
      catch (error) {
        expect(error).toBeInstanceOf(Error)
        expect((error as Error).message).toMatch(/CJK_FONT_UNAVAILABLE|PDF_GLYPH_UNAVAILABLE/)
        continue
      }
      const result = await inspectPdf(buffer)
      expect(result.content).not.toContain('\u0000')
      // PDF text extractors may discard an intentional zero-width space.
      expect(result.content.replace(/\u200b/g, '')).toContain(markdown.replace(/\u200b/g, ''))
    }
  })

  it('preserves every table row across pages and repeats headers without branded footers', async () => {
    const rows = Array.from({ length: 90 }, (_, index) => `| Row-${String(index + 1).padStart(3, '0')} | ${1000 + index} |`)
    const result = await inspectPdf(await createPdf({ markdown: '| Item | Amount |\n| --- | ---: |\n' + rows.join('\n') + '\n\nEnd of report.' }))
    expect(result.summary.pages).toBeGreaterThan(1)
    for (let row = 1; row <= 90; row++) {
      expect(result.content.match(new RegExp(`Row-${String(row).padStart(3, '0')}`, 'g'))).toHaveLength(1)
    }
    expect(result.content.match(/Amount/g)).toHaveLength(Number(result.summary.pages))
    expect(result.content).toContain('End of report.')
    expect(result.content).toContain(`${result.summary.pages} / ${result.summary.pages}`)
    expect(result.content).not.toContain('Aether')
  })
})
