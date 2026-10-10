/** Genuine knowledge-format fixtures; source syntax or actual binary encoding. */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { Document, Packer, Paragraph, TextRun } from 'docx'
import XLSX from 'xlsx'
import PDFDocument from 'pdfkit'

export const KNOWLEDGE_FORMATS = ['.txt', '.md', '.markdown', '.json', '.html', '.htm', '.xml', '.csv', '.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.java', '.c', '.cpp', '.h', '.hpp', '.rs', '.css', '.scss', '.less', '.sh', '.yaml', '.yml', '.toml', '.ini', '.lock', '.log', '.svg', '.xlsx', '.xls', '.docx', '.doc', '.pdf', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tiff']
const OCR = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tiff']
const DOC_COMMIT = 'd971d9f69056245ae129bd2ce31436d518293854'
const DOC_BASE = `https://raw.githubusercontent.com/morungos/node-word-extractor/${DOC_COMMIT}`
export const hash = bytes => createHash('sha256').update(bytes).digest('hex')
export const magic = bytes => Buffer.from(bytes).subarray(0, 16).toString('hex')
const writeNew = (file, bytes) => fs.writeFileSync(file, bytes, { flag: 'wx' })

export function textFixture(ext, marker) {
  const q = JSON.stringify(marker)
  const sources = {
    '.txt': marker + '\n第二行：知识库文本。\n',
    '.md': `# Knowledge format\n\n${marker}\n\n- indexed markdown\n`,
    '.markdown': `# Markdown extension\n\n> ${marker}\n`,
    '.json': JSON.stringify({ oracle: marker, nested: { unicode: '知识库' }, values: [1, 2] }, null, 2),
    '.html': `<!doctype html><html><head><style>.hidden {color:red}</style><script>const hidden = 'SCRIPT_MUST_NOT_BE_INDEXED';</script></head><body><h1>${marker}</h1><p>Knowledge &amp; verification</p></body></html>`,
    '.htm': `<!doctype html><html><body><p>${marker}</p><script>const hidden = 'SCRIPT_MUST_NOT_BE_INDEXED';</script></body></html>`,
    '.xml': `<?xml version="1.0" encoding="utf-8"?><knowledge><oracle>${marker}</oracle></knowledge>`,
    '.csv': `kind,oracle\nknowledge,"${marker}"\n`,
    '.ts': `export const oracle: string = ${q};\n`,
    '.tsx': `import React from 'react';\nexport const Oracle = () => <p>${marker}</p>;\n`,
    '.js': `export const oracle = ${q};\n`,
    '.jsx': `import React from 'react';\nexport const Oracle = () => <p>${marker}</p>;\n`,
    '.py': `oracle = ${q}\nassert isinstance(oracle, str)\n`,
    '.go': `package knowledge\nconst Oracle = ${q}\n`,
    '.java': `final class KnowledgeOracle { static final String VALUE = ${q}; }\n`,
    '.c': `#include <stddef.h>\nconst char *knowledge_oracle = ${q};\n`,
    '.cpp': `#include <string>\nconst std::string knowledge_oracle = ${q};\n`,
    '.h': `#ifndef KNOWLEDGE_ORACLE_H\n#define KNOWLEDGE_ORACLE_H\n#define KNOWLEDGE_ORACLE ${q}\n#endif\n`,
    '.hpp': `#pragma once\ninline constexpr const char* knowledge_oracle = ${q};\n`,
    '.rs': `pub const KNOWLEDGE_ORACLE: &str = ${q};\n`,
    '.css': `/* ${marker} */\n.oracle { color: #345678; }\n`,
    '.scss': `$oracle-color: #345678;\n/* ${marker} */\n.oracle { color: $oracle-color; }\n`,
    '.less': `@oracle-color: #345678;\n/* ${marker} */\n.oracle { color: @oracle-color; }\n`,
    '.sh': `#!/bin/sh\n# ${marker}\nprintf '%s\\n' 'knowledge'\n`,
    '.yaml': `oracle: ${q}\nkind: knowledge\n`,
    '.yml': `oracle: ${q}\nkind: knowledge\n`,
    '.toml': `[knowledge]\noracle = ${q}\n`,
    '.ini': `[knowledge]\noracle=${marker}\n`,
    '.lock': JSON.stringify({ name: 'knowledge-fixture', lockfileVersion: 3, oracle: marker, packages: {} }, null, 2),
    '.log': `2026-10-10T00:00:00Z INFO ${marker}\n`,
    '.svg': `<?xml version="1.0" encoding="utf-8"?><svg xmlns="http://www.w3.org/2000/svg" width="600" height="80"><text x="10" y="40">${marker}</text></svg>`,
  }
  if (!(ext in sources)) throw new Error('No genuine text fixture: ' + ext)
  return sources[ext]
}

function processOutput(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout.on('data', data => { stdout += data })
    child.stderr.on('data', data => { stderr += data })
    child.once('error', reject)
    child.once('close', code => code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`Fixture encoder failed (${code}): ${stderr}`)))
  })
}

async function pdfBuffer(draw) {
  const document = new PDFDocument({ size: 'A4', margin: 40 })
  const chunks = [], completion = new Promise((resolve, reject) => { document.on('data', data => chunks.push(data)); document.once('error', reject); document.once('end', () => resolve(Buffer.concat(chunks))) })
  draw(document)
  document.end()
  return completion
}

export function verifyMagic(ext, data) {
  const h = magic(data)
  if (['.doc', '.xls'].includes(ext)) return h.startsWith('d0cf11e0a1b11ae1')
  if (['.docx', '.xlsx'].includes(ext)) return h.startsWith('504b0304')
  if (ext === '.pdf') return h.startsWith('255044462d')
  if (ext === '.png') return h.startsWith('89504e470d0a1a0a')
  if (['.jpg', '.jpeg'].includes(ext)) return h.startsWith('ffd8ff')
  if (ext === '.gif') return h.startsWith('474946383761') || h.startsWith('474946383961')
  if (ext === '.webp') return data.subarray(0, 4).toString() === 'RIFF' && data.subarray(8, 12).toString() === 'WEBP'
  if (ext === '.bmp') return h.startsWith('424d')
  if (ext === '.tiff') return h.startsWith('49492a00') || h.startsWith('4d4d002a')
  return !data.includes(0) && data.toString('utf8').length > 0
}

/** Refuses to reuse any existing fixture directory. */
export async function buildKnowledgeFixtures(directory, { python } = {}) {
  if (fs.existsSync(directory)) throw new Error('Fixture directory already exists; retain prior evidence')
  fs.mkdirSync(directory, { recursive: true })
  const fixtures = []
  const keep = (ext, data, { name = 'oracle' + ext, expectedText = 'AETHER KNOWLEDGE ORACLE', searchTerm = 'ORACLE', mime = 'text/plain', scenario = 'advertised', extra = {} } = {}) => {
    if (!verifyMagic(ext, data)) throw new Error('Not the claimed file format: ' + name)
    writeNew(path.join(directory, name), data)
    fixtures.push({ extension: ext, file: name, scenario, mime, expectedText, searchTerm, byteLength: data.length, sha256: hash(data), magic: magic(data), ...extra })
  }
  for (const ext of KNOWLEDGE_FORMATS.slice(0, 31)) {
    const marker = 'AETHER KNOWLEDGE ORACLE ' + ext.slice(1).toUpperCase()
    keep(ext, Buffer.from(textFixture(ext, marker)), { expectedText: marker })
  }
  for (const ext of ['.xlsx', '.xls']) {
    const book = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['oracle', 'kind'], ['AETHER KNOWLEDGE ORACLE', ext.slice(1)]]), 'Primary')
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['SECOND SHEET VERIFICATION']]), 'Secondary')
    keep(ext, XLSX.write(book, { type: 'buffer', bookType: ext === '.xls' ? 'biff8' : 'xlsx' }), { mime: ext === '.xls' ? 'application/vnd.ms-excel' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', extra: { additionalText: 'SECOND SHEET VERIFICATION' } })
  }
  const docx = new Document({ sections: [{ children: [new Paragraph({ children: [new TextRun('AETHER KNOWLEDGE ORACLE DOCX')] }), new Paragraph('Second paragraph verification.')] }] })
  keep('.docx', await Packer.toBuffer(docx), { expectedText: 'AETHER KNOWLEDGE ORACLE DOCX', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' })
  const docUrl = DOC_BASE + '/__tests__/data/test05.doc'
  const docResponse = await fetch(docUrl, { signal: AbortSignal.timeout(30000) })
  if (!docResponse.ok) throw new Error('Pinned upstream DOC fixture download failed: ' + docResponse.status)
  const doc = Buffer.from(await docResponse.arrayBuffer())
  if (doc.length !== 19456) throw new Error('Pinned upstream DOC fixture size changed')
  keep('.doc', doc, { expectedText: 'This is a simple file created with Word 97-SR2.', searchTerm: 'Word', mime: 'application/msword', extra: { source: { url: docUrl, repository: 'morungos/node-word-extractor', commit: DOC_COMMIT, oracle: DOC_BASE + '/__tests__/__snapshots__/test05.doc.snapx', license: 'MIT' } } })
  for (const [name, url] of [['word-extractor-MIT-LICENSE.txt', DOC_BASE + '/LICENSE'], ['word-extractor-test05.snapshot.txt', DOC_BASE + '/__tests__/__snapshots__/test05.doc.snapx']]) {
    const response = await fetch(url, { signal: AbortSignal.timeout(30000) })
    if (!response.ok) throw new Error('Pinned upstream fixture attribution download failed')
    writeNew(path.join(directory, name), Buffer.from(await response.arrayBuffer()))
  }
  keep('.pdf', await pdfBuffer(document => document.font('Helvetica').fontSize(20).text('AETHER KNOWLEDGE ORACLE PDF').fontSize(12).text('A genuine selectable text PDF fixture.')), { expectedText: 'AETHER KNOWLEDGE ORACLE PDF', mime: 'application/pdf' })
  if (!python) throw new Error('Existing Pillow Python runtime is required to encode true image formats')
  const pythonSource = `import sys,json,pathlib\nfrom PIL import Image,ImageDraw,ImageFont\nroot=pathlib.Path(sys.argv[1])\nfont=ImageFont.truetype(r'C:\\Windows\\Fonts\\arial.ttf',54)\ncjk=ImageFont.truetype(r'C:\\Windows\\Fonts\\msyh.ttc',54)\nimage=Image.new('RGB',(1600,400),'white')\ndraw=ImageDraw.Draw(image)\ndraw.text((60,55),'AETHER KNOWLEDGE ORACLE',font=font,fill='black')\ndraw.text((60,150),'FORMAT VERIFICATION',font=font,fill='black')\ndraw.text((60,245),'知识库格式验收',font=cjk,fill='black')\nformats={'.png':'PNG','.jpg':'JPEG','.jpeg':'JPEG','.gif':'GIF','.webp':'WEBP','.bmp':'BMP','.tiff':'TIFF'}\nfor ext,fmt in formats.items():\n image.save(root/('oracle'+ext),format=fmt,**({'quality':95 if ext=='.jpg' else 91} if fmt=='JPEG' else {'lossless':True} if fmt=='WEBP' else {}))\nprint(json.dumps({'formats':formats,'dimensions':[1600,400]}))\n`
  writeNew(path.join(directory, 'encode-images.py'), pythonSource)
  const encoder = await processOutput(python, ['-B', path.join(directory, 'encode-images.py'), directory])
  writeNew(path.join(directory, 'image-encoder-result.json'), JSON.stringify(encoder, null, 2) + '\n')
  for (const ext of OCR) {
    const file = 'oracle' + ext, data = fs.readFileSync(path.join(directory, file))
    if (!verifyMagic(ext, data)) throw new Error('Image encoder produced an incorrect format: ' + ext)
    fixtures.push({ extension: ext, file, scenario: 'advertised', mime: ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'image/' + ext.slice(1), expectedText: 'AETHER KNOWLEDGE ORACLE', additionalText: '知识库格式验收', searchTerm: 'ORACLE', byteLength: data.length, sha256: hash(data), magic: magic(data), encoder: 'Pillow', pixelDimensions: [1600, 400] })
  }
  keep('.pdf', await pdfBuffer(document => document.image(path.join(directory, 'oracle.png'), 30, 40, { width: 535 })), { name: 'scan-only.pdf', scenario: 'scan-pdf', mime: 'application/pdf', expectedText: 'AETHER KNOWLEDGE ORACLE', extra: { additionalText: '知识库格式验收', containsTextLayer: false } })
  const manifest = { schema: 'knowledge-format-fixtures-1', generatedAt: new Date().toISOString(), advertisedFormats: KNOWLEDGE_FORMATS, fixtures }
  writeNew(path.join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  return manifest
}
