import { describe, expect, it } from 'vitest'
import { Document, Packer, Paragraph } from 'docx'
import PDFDocument from 'pdfkit'
import * as XLSX from 'xlsx'
import { extractKnowledgeContent, KNOWLEDGE_SUPPORTED_EXTENSIONS, supportedKnowledgeFormatsDescription } from '../content-extractor.js'

describe('knowledge content extraction', () => {
  it('keeps supported text bytes and strips HTML markup', async () => {
    expect((await extractKnowledgeContent('note.md', Buffer.from('# hello'))).content).toBe('# hello')
    expect((await extractKnowledgeContent('page.html', Buffer.from('<h1>Hello</h1><p>world</p>'))).content).toBe('Hello world')
  })

  it('converts the first worksheet and preserves sheet labels', async () => {
    const workbook = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['name', 'value'], ['a', 1]]), 'Data')
    const bytes = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' })
    const result = await extractKnowledgeContent('data.xlsx', bytes)
    expect(result.content).toContain('## Data')
    expect(result.content).toContain('name,value')
  })

  it('extracts DOCX and PDF text through the production dependencies', async () => {
    const docx = await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph('docx phrase')] }] }))
    expect((await extractKnowledgeContent('note.docx', docx)).content).toContain('docx phrase')

    const pdf = await new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = []
      const document = new PDFDocument()
      document.on('data', chunk => chunks.push(Buffer.from(chunk)))
      document.on('end', () => resolve(Buffer.concat(chunks)))
      document.on('error', reject)
      document.text('pdf phrase')
      document.end()
    })
    expect((await extractKnowledgeContent('note.pdf', pdf)).content).toContain('pdf phrase')
  })

  it('exposes a format description that matches the extractor contract', () => {
    expect(KNOWLEDGE_SUPPORTED_EXTENSIONS).toContain('.docx')
    expect(KNOWLEDGE_SUPPORTED_EXTENSIONS).toContain('.pdf')
    expect(supportedKnowledgeFormatsDescription()).toContain('.xlsx')
  })
})
