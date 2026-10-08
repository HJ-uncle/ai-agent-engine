#!/usr/bin/env node
/**
 * workspace-shell.mjs — 受限沙箱 Shell
 * - 物理锁定在工作空间内（cd 越界直接拒绝）
 * - 支持多工作空间（WORKSPACE_ROOTS 环境变量）
 * - 纯 Node.js 内置命令，无外部依赖，无乱码
 */
import { createInterface } from 'node:readline'
import path from 'node:path'
import fs from 'node:fs'

// ── Windows 编码处理 ──────────────────────────────────────────────────────────
const IS_WINDOWS = process.platform === 'win32'

// Windows 启动时立刻把进程代码页切换到 UTF-8（65001）
// 之后所有子进程继承此代码页，cmd.exe 的错误信息也变成 UTF-8
/**
 * 将外部命令输出的 Buffer 解码为字符串（统一 UTF-8）
 */
function decodeBuffer(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf)
  return b.toString('utf8')
}

// ── 颜色工具 ───────────────────────────────────────────────────────────────
const C = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  dim:    '\x1b[2m',
  red:    '\x1b[31m',
  green:  '\x1b[32m',
  yellow: '\x1b[33m',
  blue:   '\x1b[34m',
  cyan:   '\x1b[36m',
  white:  '\x1b[37m',
}

// This process deliberately never launches a child process. A cwd check is
// not an OS sandbox; trusted builds use the separate OS-isolated executor.
const MAX_INPUT_BYTES = 32 * 1024
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024
const MAX_ENTRIES = 20_000
const MAX_FILE_BYTES = 8 * 1024 * 1024
let outputBytes = 0
let outputTruncated = false
function out(s) {
  if (outputTruncated) return
  const text = String(s)
  const bytes = Buffer.byteLength(text)
  if (outputBytes + bytes > MAX_OUTPUT_BYTES) {
    const remaining = Math.max(0, MAX_OUTPUT_BYTES - outputBytes)
    if (remaining) process.stdout.write(text.slice(0, remaining))
    outputBytes = MAX_OUTPUT_BYTES
    outputTruncated = true
    process.stdout.write('\r\n[输出已达到本条命令预算，已截断]\r\n')
    return
  }
  outputBytes += bytes
  process.stdout.write(text)
}
function outln(s = '') { out(String(s) + '\r\n') }
function resetOutputBudget() { outputBytes = 0; outputTruncated = false }

// ── 多工作空间初始化 ────────────────────────────────────────────────────────
let WORKSPACE_ROOTS = []
try {
  WORKSPACE_ROOTS = JSON.parse(process.env.WORKSPACE_ROOTS ?? '[]')
} catch {}
if (WORKSPACE_ROOTS.length === 0) {
  WORKSPACE_ROOTS = [path.resolve(process.env.WORKSPACE_ROOT ?? process.cwd())]
}
// A missing or non-directory root is a hard startup error; never fall back to
// a home directory because that would expand the authority unexpectedly.
try {
  WORKSPACE_ROOTS = [...new Set(WORKSPACE_ROOTS.map(p => fs.realpathSync(path.resolve(String(p)))))]
  if (!WORKSPACE_ROOTS.length || WORKSPACE_ROOTS.some(r => !fs.statSync(r).isDirectory())) throw new Error('workspace root is not a directory')
} catch (error) {
  process.stderr.write(`Workspace Shell 无法锁定工作空间: ${error.message}\n`)
  process.exit(1)
}

// 主工作空间（默认 cwd）
const PRIMARY_ROOT = WORKSPACE_ROOTS[0]
let cwd = PRIMARY_ROOT

// ── 路径安全检查 ───────────────────────────────────────────────────────────
function samePath(a, b) { return IS_WINDOWS ? a.toLowerCase() === b.toLowerCase() : a === b }
function relativeInside(root, target) {
  const rel = path.relative(root, target)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel))
}
function inAnyRoot(absPath) { return WORKSPACE_ROOTS.some(root => relativeInside(root, absPath)) }
function canonicalExistingParent(absPath) {
  let candidate = absPath
  while (true) {
    try { return fs.realpathSync(candidate) }
    catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error
      const parent = path.dirname(candidate)
      if (parent === candidate) return null
      candidate = parent
    }
  }
}
// Check lexical and canonical paths. For a new file, its nearest existing
// parent is canonicalized so a junction/symlink cannot redirect the write.
function safeResolve(target) {
  try {
    if (typeof target !== 'string' || target.length > 4096) return null
    const lexical = path.resolve(cwd, target)
    if (!inAnyRoot(lexical)) return null
    const canonical = canonicalExistingParent(lexical)
    if (!canonical) return null
    return WORKSPACE_ROOTS.some(root => relativeInside(root, canonical)) ? lexical : null
  } catch { return null }
}
function isWorkspaceRoot(target) { return WORKSPACE_ROOTS.some(root => samePath(root, target)) }
function readEntriesBounded(dirPath, limit = MAX_ENTRIES) {
  const handle = fs.opendirSync(dirPath)
  const entries = []
  try {
    while (entries.length < limit) {
      const entry = handle.readSync()
      if (!entry) break
      entries.push(entry)
    }
  } finally { handle.closeSync() }
  return entries
}

// ── 提示符 ─────────────────────────────────────────────────────────────────
function getPrompt() {
  // 找到当前路径属于哪个工作空间，显示为 @alias/subdir
  for (let i = 0; i < WORKSPACE_ROOTS.length; i++) {
    const root = WORKSPACE_ROOTS[i]
    if (relativeInside(root, cwd)) {
      const rel = path.relative(root, cwd)
      const alias = i === 0 ? '~' : `@ws${i + 1}`
      const display = rel ? `${alias}/${rel.replace(/\\/g, '/')}` : alias
      return `${C.green}${display}${C.reset} ${C.cyan}$${C.reset} `
    }
  }
  return `${C.yellow}?${C.reset} ${C.cyan}$${C.reset} `
}

// ── 列表排版 ──────────────────────────────────────────────────────────────
// Match the client's default xterm Unicode V6 wide-character ranges. In
// particular, supplementary emoji are one cell there (not Unicode 11's two).
// Measure plain text before applying ANSI styles; JS string.length counts UTF-16
// code units, not terminal cells.
/*
 * Frozen zero-width ranges from xterm.js 6.0.0, src/common/input/UnicodeV6.ts.
 * Modern Unicode property escapes differ from this provider's frozen tables.
 *
 * Copyright (c) 2019 The xterm.js authors. All rights reserved.
 * Copyright (c) 2017-2019, The xterm.js authors (https://github.com/xtermjs/xterm.js)
 * Copyright (c) 2014-2016, SourceLair Private Company (https://www.sourcelair.com)
 * Copyright (c) 2012-2013, Christopher Jeffrey (https://github.com/chjj/)
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 */
const ZERO_WIDTH_RANGES = [
  [0x0300, 0x036F], [0x0483, 0x0486], [0x0488, 0x0489],
  [0x0591, 0x05BD], [0x05BF, 0x05BF], [0x05C1, 0x05C2],
  [0x05C4, 0x05C5], [0x05C7, 0x05C7], [0x0600, 0x0603],
  [0x0610, 0x0615], [0x064B, 0x065E], [0x0670, 0x0670],
  [0x06D6, 0x06E4], [0x06E7, 0x06E8], [0x06EA, 0x06ED],
  [0x070F, 0x070F], [0x0711, 0x0711], [0x0730, 0x074A],
  [0x07A6, 0x07B0], [0x07EB, 0x07F3], [0x0901, 0x0902],
  [0x093C, 0x093C], [0x0941, 0x0948], [0x094D, 0x094D],
  [0x0951, 0x0954], [0x0962, 0x0963], [0x0981, 0x0981],
  [0x09BC, 0x09BC], [0x09C1, 0x09C4], [0x09CD, 0x09CD],
  [0x09E2, 0x09E3], [0x0A01, 0x0A02], [0x0A3C, 0x0A3C],
  [0x0A41, 0x0A42], [0x0A47, 0x0A48], [0x0A4B, 0x0A4D],
  [0x0A70, 0x0A71], [0x0A81, 0x0A82], [0x0ABC, 0x0ABC],
  [0x0AC1, 0x0AC5], [0x0AC7, 0x0AC8], [0x0ACD, 0x0ACD],
  [0x0AE2, 0x0AE3], [0x0B01, 0x0B01], [0x0B3C, 0x0B3C],
  [0x0B3F, 0x0B3F], [0x0B41, 0x0B43], [0x0B4D, 0x0B4D],
  [0x0B56, 0x0B56], [0x0B82, 0x0B82], [0x0BC0, 0x0BC0],
  [0x0BCD, 0x0BCD], [0x0C3E, 0x0C40], [0x0C46, 0x0C48],
  [0x0C4A, 0x0C4D], [0x0C55, 0x0C56], [0x0CBC, 0x0CBC],
  [0x0CBF, 0x0CBF], [0x0CC6, 0x0CC6], [0x0CCC, 0x0CCD],
  [0x0CE2, 0x0CE3], [0x0D41, 0x0D43], [0x0D4D, 0x0D4D],
  [0x0DCA, 0x0DCA], [0x0DD2, 0x0DD4], [0x0DD6, 0x0DD6],
  [0x0E31, 0x0E31], [0x0E34, 0x0E3A], [0x0E47, 0x0E4E],
  [0x0EB1, 0x0EB1], [0x0EB4, 0x0EB9], [0x0EBB, 0x0EBC],
  [0x0EC8, 0x0ECD], [0x0F18, 0x0F19], [0x0F35, 0x0F35],
  [0x0F37, 0x0F37], [0x0F39, 0x0F39], [0x0F71, 0x0F7E],
  [0x0F80, 0x0F84], [0x0F86, 0x0F87], [0x0F90, 0x0F97],
  [0x0F99, 0x0FBC], [0x0FC6, 0x0FC6], [0x102D, 0x1030],
  [0x1032, 0x1032], [0x1036, 0x1037], [0x1039, 0x1039],
  [0x1058, 0x1059], [0x1160, 0x11FF], [0x135F, 0x135F],
  [0x1712, 0x1714], [0x1732, 0x1734], [0x1752, 0x1753],
  [0x1772, 0x1773], [0x17B4, 0x17B5], [0x17B7, 0x17BD],
  [0x17C6, 0x17C6], [0x17C9, 0x17D3], [0x17DD, 0x17DD],
  [0x180B, 0x180D], [0x18A9, 0x18A9], [0x1920, 0x1922],
  [0x1927, 0x1928], [0x1932, 0x1932], [0x1939, 0x193B],
  [0x1A17, 0x1A18], [0x1B00, 0x1B03], [0x1B34, 0x1B34],
  [0x1B36, 0x1B3A], [0x1B3C, 0x1B3C], [0x1B42, 0x1B42],
  [0x1B6B, 0x1B73], [0x1DC0, 0x1DCA], [0x1DFE, 0x1DFF],
  [0x200B, 0x200F], [0x202A, 0x202E], [0x2060, 0x2063],
  [0x206A, 0x206F], [0x20D0, 0x20EF], [0x302A, 0x302F],
  [0x3099, 0x309A], [0xA806, 0xA806], [0xA80B, 0xA80B],
  [0xA825, 0xA826], [0xFB1E, 0xFB1E], [0xFE00, 0xFE0F],
  [0xFE20, 0xFE23], [0xFEFF, 0xFEFF], [0xFFF9, 0xFFFB],
  [0x10A01, 0x10A03], [0x10A05, 0x10A06], [0x10A0C, 0x10A0F],
  [0x10A38, 0x10A3A], [0x10A3F, 0x10A3F], [0x1D167, 0x1D169],
  [0x1D173, 0x1D182], [0x1D185, 0x1D18B], [0x1D1AA, 0x1D1AD],
  [0x1D242, 0x1D244], [0xE0001, 0xE0001], [0xE0020, 0xE007F],
  [0xE0100, 0xE01EF],
]

function isZeroWidth(cp) {
  if (cp < 32 || (cp >= 0x7f && cp < 0xa0)) return true
  let low = 0, high = ZERO_WIDTH_RANGES.length - 1
  while (low <= high) {
    const mid = (low + high) >>> 1
    const [start, end] = ZERO_WIDTH_RANGES[mid]
    if (cp < start) high = mid - 1
    else if (cp > end) low = mid + 1
    else return true
  }
  return false
}

function cellWidth(char) {
  const cp = char.codePointAt(0)
  if (isZeroWidth(cp)) return 0
  return cp >= 0x1100 && (cp <= 0x115f || cp === 0x2329 || cp === 0x232a ||
    (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
    (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe10 && cp <= 0xfe19) || (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x20000 && cp <= 0x2fffd) || (cp >= 0x30000 && cp <= 0x3fffd)) ? 2 : 1
}

function textWidth(text) {
  let width = 0
  for (const char of text) width += cellWidth(char)
  return width
}

function padCells(text, width, right = false) {
  const padding = ' '.repeat(Math.max(0, width - textWidth(text)))
  return right ? padding + text : text + padding
}

function wrapCells(text, width) {
  const lines = []
  let line = '', used = 0
  for (const char of text) {
    const cells = cellWidth(char)
    if (cells && used && used + cells > width) {
      lines.push(line)
      line = ''; used = 0
    }
    line += char
    used += cells
  }
  lines.push(line)
  return lines
}

function listingWidth() {
  // Re-read on every command, including after a PTY resize. Leave one spare
  // cell so terminals do not auto-wrap the last column before our newline.
  return Math.max(1, (process.stdout.columns || 80) - 1)
}

function visibleName(name) {
  // Remote Unix filenames may contain newlines or terminal escape sequences.
  // Show them literally instead of letting a name move the cursor or hide rows.
  const display = name.replace(/\\/g, '\\\\').replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g,
    char => ({ '\n': '\\n', '\r': '\\r', '\t': '\\t' })[char] ?? `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`)
  // A leading combining character has no preceding cell to join in xterm.
  // Give it a visible base without changing the underlying filesystem name.
  return display && cellWidth(display) === 0 ? `◌${display}` : display
}

function listingName(entry) {
  return visibleName(entry.name) + (entry.isDirectory() ? '/' : '')
}

function styledName(text, entry) {
  return entry.isDirectory() ? `${C.cyan}${C.bold}${text}${C.reset}` : text
}

function readListing(target, showHidden) {
  const all = readEntriesBounded(target)
  const entries = all.filter(e => showHidden || !e.name.startsWith('.')).sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1
    return a.name.localeCompare(b.name)
  })
  if (!entries.length) {
    for (const line of wrapCells(all.length ? '无可见项目（存在隐藏项，使用 -a 查看）' : '目录为空', listingWidth())) outln(line)
  }
  return entries
}

function fmtSize(bytes) {
  if (bytes == null) return '—'
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']
  let value = bytes, unit = 0
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++ }
  return `${unit ? value.toFixed(1) : value} ${units[unit]}`
}

function fmtDate(d) {
  if (!d) return '—'
  const pad = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

// ── tree 辅助 ─────────────────────────────────────────────────────────────
function printTree(dir, prefix = '', depth = 0, maxDepth = 3) {
  if (depth > maxDepth) return
  let entries
  try { entries = readEntriesBounded(dir) } catch { return }
  entries.forEach((e, i) => {
    const isLast = i === entries.length - 1
    const branch = isLast ? '└── ' : '├── '
    const color = e.isDirectory() ? C.blue : C.reset
    outln(`${prefix}${branch}${color}${e.name}${C.reset}`)
    if (e.isDirectory()) {
      printTree(path.join(dir, e.name), prefix + (isLast ? '    ' : '│   '), depth + 1, maxDepth)
    }
  })
}

// ── 内置命令 ───────────────────────────────────────────────────────────────
const BUILTINS = {

  // ── 导航 ──────────────────────────────────────────────────────────────
  cd(args) {
    const target = args[0]
    if (!target || target === '~') { cwd = PRIMARY_ROOT; return }

    // 支持 @ws2 跳到第二个工作空间根
    const wsMatch = target.match(/^@ws(\d+)$/)
    if (wsMatch) {
      const idx = parseInt(wsMatch[1]) - 1
      if (idx >= 0 && idx < WORKSPACE_ROOTS.length) { cwd = WORKSPACE_ROOTS[idx]; return }
      outln(`${C.red}cd: 工作空间 @ws${wsMatch[1]} 不存在${C.reset}`)
      return
    }

    const resolved = safeResolve(target)
    if (!resolved) {
      outln(`${C.red}⛔ 禁止离开工作空间${C.reset}`)
      return
    }
    if (!fs.existsSync(resolved)) { outln(`cd: ${target}: 目录不存在`); return }
    if (!fs.statSync(resolved).isDirectory()) { outln(`cd: ${target}: 不是目录`); return }
    cwd = resolved
  },

  pwd() { outln(cwd) },

  // ── 列表 ──────────────────────────────────────────────────────────────
  ls(args) {
    if (args.some(a => /^-[al]*l[al]*$/.test(a))) return BUILTINS.ll(args)
    const showHidden = args.includes('-a') || args.includes('-la') || args.includes('-al')
    const targetArg = args.find(a => !a.startsWith('-')) 
    const target = targetArg ? safeResolve(targetArg) : cwd
    if (!target) { outln(`${C.red}⛔ 禁止访问工作空间外路径${C.reset}`); return }
    try {
      const entries = readListing(target, showHidden)
      if (!entries.length) return
      const width = listingWidth()
      const names = entries.map(listingName)
      const columnWidth = Math.max(...names.map(textWidth))
      const columns = Math.max(1, Math.floor((width + 2) / (columnWidth + 2)))
      for (let i = 0; i < names.length; i += columns) {
        if (columns === 1) {
          for (const line of wrapCells(names[i], width)) outln(styledName(line, entries[i]))
        } else {
          const row = names.slice(i, i + columns)
          outln(row.map((name, j) => styledName(j < row.length - 1 ? padCells(name, columnWidth) : name, entries[i + j])).join('  '))
        }
      }
    } catch (e) { outln(`ls: ${e.message}`) }
  },

  ll(args) {
    const showHidden = args.includes('-a') || args.includes('-la') || args.includes('-al')
    const targetArg = args.find(a => !a.startsWith('-'))
    const target = targetArg ? safeResolve(targetArg) : cwd
    if (!target) { outln(`${C.red}⛔ 禁止访问工作空间外路径${C.reset}`); return }
    try {
      const entries = readListing(target, showHidden)
      if (!entries.length) return
      const width = listingWidth()
      const rows = entries.map(entry => {
        let stat
        // Inspect the entry itself, including broken/out-of-workspace links.
        try { stat = fs.lstatSync(path.join(target, entry.name)) } catch {}
        return {
          entry, name: listingName(entry),
          type: entry.isDirectory() ? '目录' : entry.isSymbolicLink() ? '链接' : '文件',
          size: fmtSize(entry.isFile() ? stat?.size : null),
          date: fmtDate(stat?.mtime),
        }
      })
      const sizeWidth = Math.max(4, ...rows.map(row => textWidth(row.size)))
      const metadataWidth = 4 + sizeWidth + 16 + 6
      const nameWidth = Math.min(Math.max(12, ...rows.map(row => textWidth(row.name))), width - metadataWidth)
      if (nameWidth >= 12) {
        outln(`${C.bold}${padCells('名称', nameWidth)}  类型  ${padCells('大小', sizeWidth, true)}  修改时间${C.reset}`)
        for (const row of rows) {
          const lines = wrapCells(row.name, nameWidth)
          outln(`${styledName(padCells(lines[0], nameWidth), row.entry)}  ${row.type}  ${padCells(row.size, sizeWidth, true)}  ${row.date}`)
          for (const line of lines.slice(1)) outln(styledName(line, row.entry))
        }
      } else {
        for (const row of rows) {
          for (const line of wrapCells(row.name, width)) outln(styledName(line, row.entry))
          const indent = width > 4 ? '  ' : ''
          for (const detail of [`${row.type} · ${row.size}`, `修改时间 ${row.date}`]) {
            for (const line of wrapCells(detail, width - indent.length)) outln(indent + line)
          }
          outln()
        }
      }
      for (const line of wrapCells(`共 ${entries.length} 项`, width)) outln(line)
    } catch (e) { outln(`ll: ${e.message}`) }
  },

  // ── 文件操作 ──────────────────────────────────────────────────────────
  cat(args) {
    const file = args[0]
    if (!file) { outln('用法: cat <文件>'); return }
    const resolved = safeResolve(file)
    if (!resolved) { outln(`${C.red}⛔ 禁止访问工作空间外路径${C.reset}`); return }
    try {
      if (fs.statSync(resolved).size > MAX_FILE_BYTES) { outln(`${C.yellow}文件超过 ${MAX_FILE_BYTES} 字节预算${C.reset}`); return }
      const content = fs.readFileSync(resolved, 'utf8')
      out(content.replace(/\n/g, '\r\n'))
      if (!content.endsWith('\n')) outln()
    } catch (e) { outln(`cat: ${e.message}`) }
  },

  mkdir(args) {
    const name = args[0]
    if (!name) { outln('用法: mkdir <目录>'); return }
    const resolved = safeResolve(name)
    if (!resolved) { outln(`${C.red}⛔ 禁止访问工作空间外路径${C.reset}`); return }
    try { fs.mkdirSync(resolved, { recursive: true }); outln(`已创建: ${name}`) }
    catch (e) { outln(`mkdir: ${e.message}`) }
  },

  touch(args) {
    const name = args[0]
    if (!name) { outln('用法: touch <文件>'); return }
    const resolved = safeResolve(name)
    if (!resolved) { outln(`${C.red}⛔ 禁止访问工作空间外路径${C.reset}`); return }
    try {
      if (fs.existsSync(resolved)) { fs.utimesSync(resolved, new Date(), new Date()) }
      else { fs.writeFileSync(resolved, '') }
    } catch (e) { outln(`touch: ${e.message}`) }
  },

  rm(args) {
    const force = args.includes('-f') || args.includes('-rf') || args.includes('-fr')
    const recursive = args.includes('-r') || args.includes('-rf') || args.includes('-fr')
    const name = args.find(a => !a.startsWith('-'))
    if (!name) { outln('用法: rm [-rf] <路径>'); return }
    const resolved = safeResolve(name)
    if (!resolved) { outln(`${C.red}⛔ 禁止访问工作空间外路径${C.reset}`); return }
    if (isWorkspaceRoot(resolved)) { outln(`${C.red}⛔ 不能删除工作空间根目录${C.reset}`); return }
    try {
      fs.rmSync(resolved, { recursive, force })
      outln(`已删除: ${name}`)
    } catch (e) { outln(`rm: ${e.message}`) }
  },

  cp(args) {
    const src = args[0], dst = args[1]
    if (!src || !dst) { outln('用法: cp <源> <目标>'); return }
    const rSrc = safeResolve(src), rDst = safeResolve(dst)
    if (!rSrc || !rDst) { outln(`${C.red}⛔ 禁止访问工作空间外路径${C.reset}`); return }
    try { fs.copyFileSync(rSrc, rDst); outln(`已复制: ${src} → ${dst}`) }
    catch (e) { outln(`cp: ${e.message}`) }
  },

  mv(args) {
    const src = args[0], dst = args[1]
    if (!src || !dst) { outln('用法: mv <源> <目标>'); return }
    const rSrc = safeResolve(src), rDst = safeResolve(dst)
    if (!rSrc || !rDst) { outln(`${C.red}⛔ 禁止访问工作空间外路径${C.reset}`); return }
    try { fs.renameSync(rSrc, rDst); outln(`已移动: ${src} → ${dst}`) }
    catch (e) { outln(`mv: ${e.message}`) }
  },

  // ── 搜索 ──────────────────────────────────────────────────────────────
  find(args) {
    const namePattern = args[args.indexOf('-name') + 1]
    const startArg = args.find(a => !a.startsWith('-') && a !== namePattern)
    const startDir = startArg ? safeResolve(startArg) : cwd
    if (!startDir) { outln(`${C.red}⛔ 禁止访问工作空间外路径${C.reset}`); return }

    function walk(dir, depth = 0) {
      if (depth > 8) return
      let entries
      try { entries = readEntriesBounded(dir) } catch { return }
      for (const e of entries.slice(0, MAX_ENTRIES)) {
        const full = path.join(dir, e.name)
        if (!namePattern || e.name.includes(namePattern.replace(/\*/g, ''))) {
          const rel = path.relative(cwd, full)
          const color = e.isDirectory() ? C.blue : C.reset
          outln(`${color}./${rel.replace(/\\/g, '/')}${C.reset}`)
        }
        if (e.isDirectory()) walk(full, depth + 1)
      }
    }
    walk(startDir)
  },

  grep(args) {
    const iFlag = args.includes('-i')
    const rFlag = args.includes('-r') || args.includes('-rn')
    const nFlag = args.includes('-n') || args.includes('-rn')
    const filtered = args.filter(a => !a.startsWith('-'))
    const pattern = filtered[0], fileArg = filtered[1]
    if (!pattern) { outln('用法: grep [-irn] <模式> [文件/目录]'); return }

    if (pattern.length > 256) { outln(`${C.red}grep: 模式过长${C.reset}`); return }
    // Reject the common nested-quantifier shape that can consume unbounded
    // CPU in backtracking regex engines. Full code search belongs in a worker
    // with its own deadline; this interactive terminal stays fail-closed.
    if (/\([^)]*[+*][^)]*\)[+*{]/.test(pattern)) { outln(`${C.red}grep: 可能导致过量回溯的模式已拒绝${C.reset}`); return }
    let regex
    try { regex = new RegExp(pattern, iFlag ? 'gi' : 'g') }
    catch (error) { outln(`${C.red}grep: 无效正则: ${error.message}${C.reset}`); return }

    function grepFile(filePath) {
      try {
        if (fs.statSync(filePath).size > MAX_FILE_BYTES) return
        const lines = fs.readFileSync(filePath, 'utf8').split('\n')
        lines.forEach((line, i) => {
          if (regex.test(line)) {
            regex.lastIndex = 0
            const rel = path.relative(cwd, filePath).replace(/\\/g, '/')
            const lineNum = nFlag ? `${C.dim}:${i+1}${C.reset}` : ''
            const highlighted = line.replace(regex, m => `${C.red}${C.bold}${m}${C.reset}`)
            regex.lastIndex = 0
            outln(`${C.cyan}${rel}${C.reset}${lineNum}: ${highlighted}`)
          }
        })
      } catch {}
    }

    const target = fileArg ? safeResolve(fileArg) : (rFlag ? cwd : null)
    if (fileArg && !target) { outln(`${C.red}⛔ 禁止访问工作空间外路径${C.reset}`); return }

    if (!target) { outln('用法: grep [-r] <模式> <文件/目录>'); return }

    const stat = fs.statSync(target)
    if (stat.isDirectory()) {
      function walkGrep(dir) {
        const entries = readEntriesBounded(dir)
        for (const e of entries) {
          const full = path.join(dir, e.name)
          if (e.isDirectory()) walkGrep(full)
          else grepFile(full)
        }
      }
      walkGrep(target)
    } else {
      grepFile(target)
    }
  },

  // ── 目录树 ────────────────────────────────────────────────────────────
  tree(args) {
    const depthArg = args[args.indexOf('-L') + 1]
    const maxDepth = depthArg ? parseInt(depthArg) - 1 : 3
    const targetArg = args.find(a => !a.startsWith('-') && a !== depthArg)
    const target = targetArg ? safeResolve(targetArg) : cwd
    if (!target) { outln(`${C.red}⛔ 禁止访问工作空间外路径${C.reset}`); return }
    outln(`${C.blue}${C.bold}.${C.reset}`)
    printTree(target, '', 0, maxDepth)
  },

  // ── 工作空间管理 ───────────────────────────────────────────────────────
  ws(args) {
    if (args[0] === 'ls' || !args[0]) {
      outln(`${C.bold}绑定的工作空间：${C.reset}`)
      WORKSPACE_ROOTS.forEach((r, i) => {
        const alias = i === 0 ? '~（主）' : `@ws${i + 1}`
        const isCurrent = relativeInside(r, cwd)
        const marker = isCurrent ? ` ${C.green}◀ 当前${C.reset}` : ''
        outln(`  ${C.cyan}${alias}${C.reset}  ${C.dim}${r}${C.reset}${marker}`)
      })
      return
    }
    if (args[0] === 'cd') {
      const idx = parseInt(args[1] ?? '1') - 1
      if (idx >= 0 && idx < WORKSPACE_ROOTS.length) { cwd = WORKSPACE_ROOTS[idx] }
      else outln(`${C.red}工作空间不存在${C.reset}`)
      return
    }
    outln('用法: ws [ls|cd <序号>]')
  },

  // ── 其他实用命令 ───────────────────────────────────────────────────────
  echo(args) { outln(args.join(' ')) },

  env(args) {
    // Never expose the engine environment; arbitrary process.env lookup leaked credentials.
    const safe = {
      NODE_ENV: process.env.NODE_ENV === 'production' ? 'production' : 'development',
      TERM: process.env.TERM ? 'present' : '',
      LANG: process.env.LANG ? 'present' : '',
    }
    if (args[0]) {
      const key = args[0].toUpperCase()
      if (!Object.prototype.hasOwnProperty.call(safe, key)) { outln(`${C.red}环境变量不可查询${C.reset}`); return }
      outln(safe[key] ?? '')
      return
    }
    Object.entries(safe).forEach(([k, v]) => { if (v) outln(`${C.cyan}${k}${C.reset}=${v}`) })
    outln(`${C.cyan}WORKSPACE_ROOT${C.reset}=${WORKSPACE_ROOTS[0]}`)
  },

  clear() { out('\x1b[2J\x1b[H') },

  help(args) {
    // 支持 help <命令> 查看特定命令详情
    const topic = args?.[0]
    if (topic) {
      const topics = {
        cd:    [`${C.bold}cd${C.reset} — 切换目录`,`  cd <目录>    进入子目录`, `  cd ..        返回上级目录`, `  cd ~         回到主工作空间根目录`, `  cd @ws2      切换到第 2 个工作空间`, `${C.dim}注：不允许跳出工作空间范围${C.reset}`],
        ls:    [`${C.bold}ls${C.reset} — 列出目录内容`, `  ls           列出当前目录`, `  ls -a        包含隐藏文件（. 开头）`, `  ls -l        详细列表（同 ll）`, `  ls -la       详细列表，包含隐藏文件`, `  ls <目录>    列出指定目录`],
        ll:    [`${C.bold}ll${C.reset} — 详细文件列表`, `  ll           显示文件类型、大小、修改时间`, `  ll -a        包含隐藏文件`],
        tree:  [`${C.bold}tree${C.reset} — 目录树`, `  tree              显示当前目录树（深度 3）`, `  tree -L 5         指定深度为 5`, `  tree <目录>        指定目录`],
        cat:   [`${C.bold}cat${C.reset} — 查看文件内容`, `  cat <文件>    输出文件全部内容`, `${C.dim}提示：大文件建议用 head/tail（外部命令）${C.reset}`],
        grep:  [`${C.bold}grep${C.reset} — 内容搜索`, `  grep <模式> <文件>       单文件搜索`, `  grep -i <模式> <文件>   忽略大小写`, `  grep -n <模式> <文件>   显示行号`, `  grep -r <模式> <目录>   递归搜索`, `  grep -rn <模式> .       递归+行号`],
        find:  [`${C.bold}find${C.reset} — 查找文件`, `  find                    列出当前目录所有文件`, `  find -name *.js         按名称查找（支持通配符）`, `  find src -name config    在 src 目录中查找`],
        git:   [`${C.bold}git${C.reset} — 不在受限文件终端中执行`, `  请使用可信终端或操作系统隔离执行器`],
        python:[`${C.bold}python / python3${C.reset} — 不在受限文件终端中执行`, `  请使用操作系统隔离执行器`],
        node:  [`${C.bold}node / npm${C.reset} — 不在受限文件终端中执行`, `  请使用操作系统隔离执行器`],
        rm:    [`${C.bold}rm${C.reset} — 删除文件/目录`, `  rm <文件>        删除文件`, `  rm -r <目录>     递归删除目录`, `  rm -rf <路径>    强制递归删除（谨慎！）`, `${C.red}⚠ 删除操作不可恢复，请谨慎使用${C.reset}`],
        ws:    [`${C.bold}ws${C.reset} — 工作空间管理`, `  ws              列出所有绑定的工作空间`, `  ws ls           同上`, `  ws cd 2         切换到第 2 个工作空间根目录`],
        exit:  [`${C.yellow}exit 命令已禁用${C.reset}`, `${C.dim}此终端由系统管理，请通过关闭终端面板来结束会话。${C.reset}`],
      }
      const lines = topics[topic]
      if (lines) { lines.forEach(l => outln(l)); return }
      outln(`${C.yellow}未找到 "${topic}" 的帮助，输入 help 查看全部命令${C.reset}`)
      return
    }

    const lines = [
      `${C.bold}╔═══════════════════════════════════════════════════════╗${C.reset}`,
      `${C.bold}║          Workspace Shell 帮助（受限文件终端）             ║${C.reset}`,
      `${C.bold}╚═══════════════════════════════════════════════════════╝${C.reset}`,
      '',
      `${C.yellow}导航命令${C.reset}`,
      `  ${C.cyan}cd <目录>${C.reset}         切换目录（限工作空间内）`,
      `  ${C.cyan}cd ..${C.reset}             返回上级目录`,
      `  ${C.cyan}cd ~${C.reset}              回到主工作空间根目录`,
      `  ${C.cyan}cd @ws2${C.reset}           切换到第 2 个工作空间根目录`,
      `  ${C.cyan}pwd${C.reset}               显示当前绝对路径`,
      `  ${C.cyan}ws${C.reset}                查看所有绑定的工作空间`,
      '',
      `${C.yellow}列表命令${C.reset}`,
      `  ${C.cyan}ls [-a] [目录]${C.reset}    列出文件（-a 显示隐藏文件）`,
      `  ${C.cyan}ll [-a] [目录]${C.reset}    详细列表（含大小、修改时间）`,
      `  ${C.cyan}tree [-L <深度>]${C.reset}  目录树（默认深度 3）`,
      '',
      `${C.yellow}文件操作${C.reset}`,
      `  ${C.cyan}cat <文件>${C.reset}        查看文件内容`,
      `  ${C.cyan}touch <文件>${C.reset}      创建空文件 / 更新时间戳`,
      `  ${C.cyan}mkdir <目录>${C.reset}      创建目录（自动递归创建）`,
      `  ${C.cyan}rm [-rf] <路径>${C.reset}   删除文件/目录`,
      `  ${C.cyan}cp <源> <目标>${C.reset}    复制文件`,
      `  ${C.cyan}mv <源> <目标>${C.reset}    移动 / 重命名`,
      '',
      `${C.yellow}搜索命令${C.reset}`,
      `  ${C.cyan}find [-name <模式>] [目录]${C.reset}     查找文件`,
      `  ${C.cyan}grep [-i] [-r] [-n] <模式> <路径>${C.reset}  内容搜索`,
      `  ${C.dim}  示例: grep -rn TODO .   递归搜索 TODO 并显示行号${C.reset}`,
      '',
      `${C.yellow}实用命令${C.reset}`,
      `  ${C.cyan}echo <文本>${C.reset}       输出文本`,
      `  ${C.cyan}env [变量名]${C.reset}      查看环境变量`,
      `  ${C.cyan}clear${C.reset}             清屏`,
      '',
      `${C.yellow}外部命令${C.reset}`,
      `  ${C.dim}  受限文件终端拒绝启动 node、python、git、npm 等外部进程。${C.reset}`,
      `  ${C.dim}  需要执行代码时，请使用单独的操作系统隔离执行器。${C.reset}`,
      '',
      `${C.yellow}快捷键${C.reset}`,
      `  ${C.cyan}Ctrl+C${C.reset}   中断当前正在运行的命令`,
      `  ${C.cyan}Ctrl+V${C.reset}   粘贴（由终端前端处理）`,
      `  ${C.cyan}Ctrl+L${C.reset}   清屏（等同于 clear 命令）`,
      '',
      `${C.dim}  此终端只提供工作区内置文件操作；它不是操作系统安全沙箱。${C.reset}`,
      `${C.dim}  输入 ${C.reset}${C.cyan}help <命令>${C.reset}${C.dim} 查看某个命令的详细说明${C.reset}`,
      `${C.bold}╔═══════════════════════════════════════════════════════╗${C.reset}`,
      `${C.bold}║  工作空间: ${PRIMARY_ROOT.length > 43 ? '...'+PRIMARY_ROOT.slice(-40) : PRIMARY_ROOT.padEnd(43)}║${C.reset}`,
      `${C.bold}╚═══════════════════════════════════════════════════════╝${C.reset}`,
    ]
    lines.forEach(l => outln(l))
  },

  // exit 命令已禁用——终端由外部管理，不允许从 Shell 内部退出
  exit() {
    outln(`${C.yellow}提示：此终端由系统管理，无法从 Shell 内部退出。${C.reset}`)
    outln(`${C.dim}如需关闭，请关闭终端面板。${C.reset}`)
  },
}

// ── 启动横幅 ────────────────────────────────────────────────────────────────
outln(`${C.bold}${C.cyan}╔════════════════════════════════════════╗${C.reset}`)
outln(`${C.bold}${C.cyan}║       Workspace Shell (受限文件终端)   ║${C.reset}`)
outln(`${C.bold}${C.cyan}╚════════════════════════════════════════╝${C.reset}`)
outln(`${C.dim}主工作空间: ${PRIMARY_ROOT}${C.reset}`)
if (WORKSPACE_ROOTS.length > 1) {
  outln(`${C.dim}附加工作空间: ${WORKSPACE_ROOTS.slice(1).join(', ')}${C.reset}`)
}
outln(`${C.dim}仅提供工作区内置文件操作；外部命令需使用隔离执行器${C.reset}`)
for (const hint of [
  '输入 help 查看命令菜单，help <命令> 查看详细用法',
  'Tab 补全 · ↑/↓ 历史 · Ctrl+L 清屏',
]) {
  for (const line of wrapCells(hint, listingWidth())) {
    outln(line.replace(/help(?: <命令>)?/g, command => `${C.bold}${C.cyan}${command}${C.reset}`))
  }
}
outln()

// ── Tab 补全 ──────────────────────────────────────────────────────────────

/** 根据部分路径字符串，返回匹配的文件/目录候选列表 */
function getPathCompletions(partial) {
  try {
    const norm = partial.replace(/\\/g, '/')
    const lastSlash = norm.lastIndexOf('/')
    const dirPart  = lastSlash >= 0 ? norm.slice(0, lastSlash + 1) : ''
    const filePart = lastSlash >= 0 ? norm.slice(lastSlash + 1) : norm
    const searchDir = dirPart ? (safeResolve(dirPart) ?? cwd) : cwd
    if (!searchDir || !fs.existsSync(searchDir)) return []
    return readEntriesBounded(searchDir)
      .filter(e => e.name.toLowerCase().startsWith(filePart.toLowerCase()))
      .map(e => {
        const full = dirPart + e.name
        return e.isDirectory() ? `${full}/` : full
      })
      .sort()
  } catch { return [] }
}

/**
 * readline completer：
 *  - 行首第一个词 → 补全内置命令名
 *  - 后续词       → 补全文件/目录路径
 */
function tabCompleter(line) {
  const trimmed = line.trimStart()
  const tokens  = trimmed.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? []

  // 补全命令名（空行，或只有一个词且末尾无空格）
  if (tokens.length === 0 || (tokens.length === 1 && !trimmed.endsWith(' '))) {
    const prefix = tokens[0] ?? ''
    const hits   = Object.keys(BUILTINS).filter(c => c.startsWith(prefix)).sort()
    return [hits, prefix]
  }

  // 补全文件路径（最后一个参数）
  const lastArg = trimmed.endsWith(' ') ? '' : (tokens[tokens.length - 1] ?? '')
  const hits    = getPathCompletions(lastArg)
  return [hits, lastArg]
}

// ── 主循环 ──────────────────────────────────────────────────────────────────

// 切换到 raw mode：禁用 PTY 自带的 echo/行编辑，由 readline 全权接管
// 这样 readline 才能处理 Tab 补全、↑↓ 历史、左右光标移动
if (process.stdin.isTTY) {
  try { process.stdin.setRawMode(true) } catch { /* 非 TTY 环境降级 */ }
}

const rl = createInterface({
  input:     process.stdin,
  output:    process.stdout,
  terminal:  true,           // 开启终端模式（Tab 补全、行编辑、历史记录）
  completer: tabCompleter,   // Tab 补全函数
})

function showPrompt() {
  rl.setPrompt(getPrompt())
  rl.prompt()
}

// ── Ctrl+C：raw mode 下 PTY 不发信号，readline 拦截后触发此事件 ──────────
rl.on('SIGINT', () => {
  process.stdout.write('^C\r\n')
  showPrompt()
})

// ── 兜底：canonical mode 下 PTY 仍会发真实 SIGINT ────────────────────────
process.on('SIGINT', () => {
  process.stdout.write('^C\r\n')
  showPrompt()
})

// ── 特殊按键：readline 不处理的字节 ─────────────────────────────────────
// (raw mode 下这些字节直接到达，readline 不会消费它们)
process.stdin.on('data', (chunk) => {
  const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
  for (let i = 0; i < data.length; i++) {
    const byte = data[i]
    if (byte === 0x0C) {            // Ctrl+L — 清屏
      process.stdout.write('\x1b[2J\x1b[H')
      showPrompt()
      return
    }
    if (byte === 0x04) return       // Ctrl+D — 忽略，不退出
    if (byte === 0x1A && IS_WINDOWS) return  // Ctrl+Z — Windows 忽略
  }
})

// ── 命令处理：单一 Promise 队列，避免粘贴多行时竞态 ─────────────────────────
let commandQueue = Promise.resolve()
async function processLine(line) {
  resetOutputBudget()
  // 过滤残留控制字符
  if (Buffer.byteLength(line, 'utf8') > MAX_INPUT_BYTES) { outln(`${C.red}输入超过 ${MAX_INPUT_BYTES} 字节预算${C.reset}`); return }
  const input = line.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '').trim()
  if (!input) return

  // 支持分号分隔多命令（顺序执行）
  const parts = input.split(/\s*;\s*/)
  for (const part of parts) {
    const tokens = part.trim().match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? []
    if (!tokens.length) continue
    const [cmd, ...args] = tokens.map(t => t.replace(/^['"]|['"]$/g, ''))

    if (BUILTINS[cmd]) {
      await BUILTINS[cmd](args)
    } else {
      // No shell, interpreter, package manager, or native process is started.
      outln(`${C.yellow}已拒绝外部命令 “${cmd}”：请使用操作系统隔离执行器${C.reset}`)
    }
  }
}
rl.on('line', (line) => {
  commandQueue = commandQueue.then(() => processLine(line)).catch(error => {
    outln(`${C.red}命令处理失败：${error.message}${C.reset}`)
  }).finally(showPrompt)
})

// stdin EOF（连接真正断开）→ 退出进程
rl.on('close', () => process.exit(0))

// 显示初始提示符
showPrompt()
