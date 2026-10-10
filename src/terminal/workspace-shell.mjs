#!/usr/bin/env node
/**
 * workspace-shell.mjs — 受限沙箱 Shell
 * - 工作空间文件视图（不构成操作系统隔离）
 * - 支持多工作空间（WORKSPACE_ROOTS 环境变量）
 * - 纯 Node.js 内置命令，无外部依赖，无乱码
 */
import { createInterface } from 'node:readline'
import path from 'node:path'
import fs from 'node:fs'
import { createHash } from 'node:crypto'
import { Worker } from 'node:worker_threads'
import { Transform } from 'node:stream'

const IS_WINDOWS = process.platform === 'win32'
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
const MAX_QUEUE_BYTES = 1024 * 1024
const MAX_QUEUE_LINES = 2048
const MAX_DEPTH = 32
const MAX_TEXT_LINES = 100000
const COMMAND_DEADLINE_MS = 2000
let commandDeadline = Infinity
let visitedEntries = 0
let activeWorker = null
let commandCancelled = false
function checkBudget(entries = 0) {
  visitedEntries += entries
  if (commandCancelled) throw new Error('命令已取消')
  if (visitedEntries > MAX_ENTRIES || Date.now() > commandDeadline) throw new Error('已达到本条命令扫描预算')
}
function plainText(text) {
  // File data cannot emit OSC clipboard/hyperlink controls or cursor moves.
  return String(text).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g,
    char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`)
}
let outputBytes = 0
let outputTruncated = false
function out(s) {
  if (outputTruncated) return
  const text = String(s)
  const bytes = Buffer.byteLength(text)
  if (outputBytes + bytes > MAX_OUTPUT_BYTES) {
    const remaining = Math.max(0, MAX_OUTPUT_BYTES - outputBytes)
    if (remaining) process.stdout.write(Buffer.from(text).subarray(0, remaining))
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
  if (!Array.isArray(WORKSPACE_ROOTS) || WORKSPACE_ROOTS.some(root => typeof root !== 'string' || !root)) throw new Error('invalid workspace roots')
} catch {
  process.stderr.write('Workspace Shell 工作空间配置无效\n')
  process.exit(1)
}
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
    if (typeof target !== 'string' || target.length > 4096 || /[\x00-\x1f\x7f-\x9f]/.test(target)) return null
    if (IS_WINDOWS && (/^[\\/]{2}/.test(target) || /:/.test(target.replace(/^[a-z]:/i, '')) ||
      target.split(/[\\/]/).some(part => /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\..*)?$/i.test(part) || /[. ]$/.test(part) && part !== '.' && part !== '..'))) return null
    const lexical = path.resolve(cwd, target)
    if (!inAnyRoot(lexical)) return null
    const canonical = canonicalExistingParent(lexical)
    if (!canonical) return null
    return WORKSPACE_ROOTS.some(root => relativeInside(root, canonical)) ? lexical : null
  } catch { return null }
}
function isWorkspaceRoot(target) { return WORKSPACE_ROOTS.some(root => relativeInside(target, root)) }
function requirePath(value) {
  const resolved = safeResolve(value)
  if (!resolved) throw new Error('禁止访问工作空间外路径或特殊路径')
  return resolved
}
function regularStat(file) {
  const resolved = requirePath(file)
  const stat = fs.lstatSync(resolved)
  if (!stat.isFile() || stat.nlink !== 1) throw new Error('只允许普通单链接文件（不跟随符号链接或硬链接）')
  return { resolved, stat }
}
function readFileBounded(file) {
  const { resolved, stat } = regularStat(file)
  if (stat.size > MAX_FILE_BYTES) throw new Error(`文件超过 ${MAX_FILE_BYTES} 字节预算`)
  const fd = fs.openSync(resolved, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
  try {
    const opened = fs.fstatSync(fd)
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== stat.dev || opened.ino !== stat.ino) throw new Error('文件在访问过程中发生变化')
    if (opened.size > MAX_FILE_BYTES) throw new Error(`文件超过 ${MAX_FILE_BYTES} 字节预算`)
    const data = Buffer.alloc(Math.min(MAX_FILE_BYTES + 1, opened.size + 1))
    let used = 0
    while (used < data.length) {
      const bytes = fs.readSync(fd, data, used, data.length - used, null)
      if (!bytes) break
      used += bytes
    }
    if (used > opened.size || used > MAX_FILE_BYTES) throw new Error('文件在读取过程中增长，已停止读取')
    return data.subarray(0, used)
  } finally { fs.closeSync(fd) }
}
function writeFileBounded(file, data) {
  const resolved = requirePath(file)
  let original
  try { original = regularStat(resolved).stat } catch (error) { if (error.code !== 'ENOENT') throw error }
  const flags = original ? fs.constants.O_WRONLY : fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
  const fd = fs.openSync(resolved, flags | (fs.constants.O_NOFOLLOW ?? 0), 0o600)
  try {
    const stat = fs.fstatSync(fd)
    if (!stat.isFile() || stat.nlink !== 1 || original && (stat.dev !== original.dev || stat.ino !== original.ino)) throw new Error('文件在访问过程中发生变化')
    fs.ftruncateSync(fd, 0)
    fs.writeFileSync(fd, data)
  } finally { fs.closeSync(fd) }
}
function readEntriesBounded(dirPath, limit = MAX_ENTRIES) {
  const handle = fs.opendirSync(dirPath)
  const entries = []
  try {
    while (entries.length <= limit) {
      const entry = handle.readSync()
      if (!entry) break
      if (entries.length === limit) {
        if (limit === MAX_ENTRIES) throw new Error('已达到本条命令扫描预算')
        break
      }
      checkBudget(1)
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

// All walkers share a per-command budget and revalidate each directory.
function walkEntries(dir, visit, depth = 0, maxDepth = MAX_DEPTH) {
  checkBudget()
  if (depth >= maxDepth || outputTruncated) return
  const resolved = requirePath(dir)
  for (const entry of readEntriesBounded(resolved)) {
    checkBudget()
    if (outputTruncated) return
    const full = path.join(resolved, entry.name)
    visit(entry, full, depth)
    if (entry.isDirectory()) walkEntries(full, visit, depth + 1, maxDepth)
  }
}
function printTree(dir, prefix = '', depth = 0, maxDepth = 3) {
  checkBudget()
  if (depth >= maxDepth || outputTruncated) return
  const entries = readEntriesBounded(requirePath(dir))
  entries.forEach((entry, index) => {
    if (outputTruncated) return
    const last = index === entries.length - 1
    outln(`${prefix}${last ? '└── ' : '├── '}${entry.isDirectory() ? C.blue : C.reset}${visibleName(entry.name)}${C.reset}`)
    if (entry.isDirectory()) printTree(path.join(dir, entry.name), prefix + (last ? '    ' : '│   '), depth + 1, maxDepth)
  })
}
// Glob matching does not pass repeated wildcards to a backtracking RegExp.
function globMatches(pattern, value) {
  let p = 0, v = 0, star = -1, match = 0
  while (v < value.length) {
    if (pattern[p] === '?' || pattern[p] === value[v]) { p++; v++ }
    else if (pattern[p] === '*') { star = p++; match = v }
    else if (star !== -1) { p = star + 1; v = ++match }
    else return false
  }
  while (pattern[p] === '*') p++
  return p === pattern.length
}
function positiveInteger(value, maximum, label) {
  if (!/^\d+$/.test(value ?? '') || Number(value) < 1 || Number(value) > maximum) throw new Error(`${label} 必须为 1–${maximum} 的整数`)
  return Number(value)
}
function positional(args, supported = []) {
  let literal = false
  const values = [], flags = new Set()
  for (const arg of args) {
    if (!literal && arg === '--') { literal = true; continue }
    if (!literal && arg.startsWith('-')) {
      if (!supported.includes(arg)) throw new Error(`不支持的选项: ${plainText(arg)}`)
      flags.add(arg)
    } else values.push(arg)
  }
  return { values, flags }
}
function splitLines(text) {
  const lines = text.split('\n', MAX_TEXT_LINES + 1)
  if (lines.length > MAX_TEXT_LINES) throw new Error(`文本超过 ${MAX_TEXT_LINES} 行预算`)
  return lines
}
function fileLines(file) {
  const text = readFileBounded(file).toString('utf8')
  const lines = splitLines(text)
  if (text.endsWith('\n') || !text) lines.pop()
  return lines
}
function showLines(args, tail) {
  let count = 10
  const values = []
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-n') count = positiveInteger(args[++i], 10000, '行数')
    else values.push(args[i])
  }
  if (values.length !== 1) throw new Error(`用法: ${tail ? 'tail' : 'head'} [-n 行数] <文件>`)
  const lines = fileLines(values[0])
  for (const line of tail ? lines.slice(-count) : lines.slice(0, count)) outln(plainText(line.replace(/\r$/, '')))
}
function regexLineMatches(pattern, flags, content) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(`
      const {parentPort, workerData} = require('node:worker_threads');
      try {
        const regex = new RegExp(workerData.pattern, workerData.flags);
        const matches = []; let offset = 0, bytes = 0;
        for (const line of workerData.content.split('\\n', 100001)) {
          if (regex.test(line)) { matches.push(offset); bytes += Buffer.byteLength(line); }
          offset++;
          if (matches.length >= 10000 || bytes > 2 * 1024 * 1024) break;
        }
        parentPort.postMessage({ matches });
      } catch (error) { parentPort.postMessage({ error: error.message }); }
    `, { eval: true, workerData: { pattern, flags, content }, resourceLimits: { maxOldGenerationSizeMb: 64, stackSizeMb: 2 } })
    activeWorker = worker
    let settled = false
    const finish = (error, matches) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (activeWorker === worker) activeWorker = null
      void worker.terminate()
      if (error) reject(error); else resolve(matches)
    }
    const timer = setTimeout(() => finish(new Error('正则搜索超时，已停止；可使用默认的字面搜索')), 300)
    worker.once('message', result => finish(result.error ? new Error(`无效正则: ${result.error}`) : null, result.matches))
    worker.once('error', error => finish(error))
    worker.once('exit', () => { if (!settled) finish(new Error(commandCancelled ? '命令已取消' : '正则搜索进程已停止')) })
  })
}

// ── 内置命令 ───────────────────────────────────────────────────────────────
const BUILTINS = {

  // ── 导航 ──────────────────────────────────────────────────────────────
  cd(args) {
    if (args.length > 1) throw new Error('用法: cd [目录]')
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

  pwd() { outln(plainText(requirePath('.'))) },

  // ── 列表 ──────────────────────────────────────────────────────────────
  ls(args) {
    if (args.some(a => /^-[al]*l[al]*$/.test(a))) return BUILTINS.ll(args)
    const { values, flags } = positional(args, ['-a', '-l', '-la', '-al'])
    if (values.length > 1) throw new Error('只支持一个目录参数')
    const showHidden = flags.has('-a') || flags.has('-la') || flags.has('-al')
    const targetArg = values[0] 
    const target = safeResolve(targetArg ?? '.')
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
    const { values, flags } = positional(args, ['-a', '-l', '-la', '-al'])
    if (values.length > 1) throw new Error('只支持一个目录参数')
    const showHidden = flags.has('-a') || flags.has('-la') || flags.has('-al')
    const targetArg = values[0]
    const target = safeResolve(targetArg ?? '.')
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
      // Keep the table as wide as its content requires. The old fixed 12-cell
      // name column made a one-file listing look like a stretched report and
      // could push the last column into an automatic terminal wrap. Name is
      // still the first column (the conventional file-listing scan order),
      // while long names are capped to the available width and wrapped.
      const gap = 2
      const typeWidth = Math.max(textWidth('类型'), ...rows.map(row => textWidth(row.type)))
      const sizeWidth = Math.max(textWidth('大小'), ...rows.map(row => textWidth(row.size)))
      const dateWidth = Math.max(textWidth('修改时间'), ...rows.map(row => textWidth(row.date)))
      const fixedWidth = typeWidth + sizeWidth + dateWidth + gap * 3
      const availableNameWidth = Math.max(1, width - fixedWidth)
      const naturalNameWidth = Math.max(textWidth('名称'), ...rows.map(row => textWidth(row.name)))
      const nameWidth = Math.min(naturalNameWidth, availableNameWidth)
      const tableWidth = nameWidth + fixedWidth

      // With enough room, render one compact table and a separator that ends
      // at the final column. It must never be a full-terminal rule when the
      // rows are shorter than the viewport.
      if (nameWidth >= Math.min(naturalNameWidth, 12) && tableWidth <= width) {
        outln(`${C.bold}${padCells('名称', nameWidth)}${' '.repeat(gap)}${padCells('类型', typeWidth)}${' '.repeat(gap)}${padCells('大小', sizeWidth, true)}${' '.repeat(gap)}${padCells('修改时间', dateWidth)}${C.reset}`)
        outln(`${C.dim}${'─'.repeat(tableWidth)}${C.reset}`)
        for (const row of rows) {
          const lines = wrapCells(row.name, nameWidth)
          outln(`${styledName(padCells(lines[0], nameWidth), row.entry)}${' '.repeat(gap)}${padCells(row.type, typeWidth)}${' '.repeat(gap)}${padCells(row.size, sizeWidth, true)}${' '.repeat(gap)}${row.date}`)
          for (const line of lines.slice(1)) outln(styledName(line, row.entry))
        }
      } else {
        // A narrow terminal gets readable stacked records rather than a
        // squeezed header whose columns no longer communicate their values.
        for (const row of rows) {
          for (const line of wrapCells(row.name, width)) outln(styledName(line, row.entry))
          const indent = width > 4 ? '  ' : ''
          const detail = `类型 ${row.type} · 大小 ${row.size} · 修改时间 ${row.date}`
          for (const line of wrapCells(detail, Math.max(1, width - indent.length))) outln(indent + line)
          outln()
        }
      }
      for (const line of wrapCells(`共 ${entries.length} 项`, width)) outln(line)
    } catch (e) { outln(`ll: ${e.message}`) }
  },

  // ── 文件操作 ──────────────────────────────────────────────────────────
  cat(args) {
    if (args.length !== 1) { outln('用法: cat <文件>'); return }
    const content = plainText(readFileBounded(args[0]).toString('utf8').replace(/\r\n/g, '\n')).replace(/\n/g, '\r\n')
    out(content)
    if (!content.endsWith('\n')) outln()
  },

  mkdir(args) {
    const name = args[0]
    if (!name || args.length !== 1) { outln('用法: mkdir <目录>'); return }
    const resolved = safeResolve(name)
    if (!resolved) { outln(`${C.red}⛔ 禁止访问工作空间外路径${C.reset}`); return }
    try { fs.mkdirSync(resolved, { recursive: true }); outln(`已创建: ${name}`) }
    catch (e) { outln(`mkdir: ${e.message}`) }
  },

  touch(args) {
    const name = args[0]
    if (!name || args.length !== 1) { outln('用法: touch <文件>'); return }
    const resolved = safeResolve(name)
    if (!resolved) { outln(`${C.red}⛔ 禁止访问工作空间外路径${C.reset}`); return }
    try {
      if (fs.existsSync(resolved)) {
        const { stat } = regularStat(resolved)
        const fd = fs.openSync(resolved, fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW ?? 0))
        try {
          const opened = fs.fstatSync(fd)
          if (!opened.isFile() || opened.nlink !== 1 || opened.ino !== stat.ino || opened.dev !== stat.dev) throw new Error('文件在访问过程中发生变化')
          fs.futimesSync(fd, new Date(), new Date())
        } finally { fs.closeSync(fd) }
      } else { writeFileBounded(resolved, Buffer.alloc(0)) }
    } catch (e) { outln(`touch: ${e.message}`) }
  },

  rm(args) {
    const { values, flags } = positional(args, ['-f', '-r', '-rf', '-fr'])
    if (values.length !== 1) throw new Error('用法: rm [-rf] <路径>')
    const force = flags.has('-f') || flags.has('-rf') || flags.has('-fr')
    const recursive = flags.has('-r') || flags.has('-rf') || flags.has('-fr')
    const name = values[0]
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
    if (!src || !dst || args.length !== 2) { outln('用法: cp <源> <目标>'); return }
    const rSrc = safeResolve(src), rDst = safeResolve(dst)
    if (!rSrc || !rDst) { outln(`${C.red}⛔ 禁止访问工作空间外路径${C.reset}`); return }
    try { writeFileBounded(rDst, readFileBounded(rSrc)); outln(`已复制: ${src} → ${dst}`) }
    catch (e) { outln(`cp: ${e.message}`) }
  },

  mv(args) {
    const src = args[0], dst = args[1]
    if (!src || !dst || args.length !== 2) { outln('用法: mv <源> <目标>'); return }
    const rSrc = safeResolve(src), rDst = safeResolve(dst)
    if (!rSrc || !rDst) { outln(`${C.red}⛔ 禁止访问工作空间外路径${C.reset}`); return }
    if (isWorkspaceRoot(rSrc) || isWorkspaceRoot(rDst)) { outln(`${C.red}⛔ 不能移动或覆盖工作空间根目录${C.reset}`); return }
    try { fs.renameSync(rSrc, rDst); outln(`已移动: ${src} → ${dst}`) }
    catch (e) { outln(`mv: ${e.message}`) }
  },

  // ── 搜索 ──────────────────────────────────────────────────────────────
  find(args) {
    let pattern, directory
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '-name') {
        if (pattern !== undefined || !args[i + 1]) throw new Error('用法: find [目录] [-name 模式]')
        pattern = args[++i]
      } else if (args[i].startsWith('-') || directory !== undefined) throw new Error('用法: find [目录] [-name 模式]')
      else directory = args[i]
    }
    if (pattern && pattern.length > 256) throw new Error('文件名模式过长')
    walkEntries(requirePath(directory ?? '.'), (entry, full) => {
      if (pattern === undefined || globMatches(pattern, entry.name)) outln(`./${visibleName(path.relative(cwd, full).replace(/\\/g, '/'))}`)
    })
  },

  async grep(args) {
    const { values, flags } = positional(args, ['-i', '-n', '-r', '-rn', '-nr', '-irn', '-rin', '--regex', '-F'])
    const [pattern, file] = values
    if (pattern === undefined || values.length > 2 || !file && ![...flags].some(flag => flag.includes('r') && !flag.startsWith('--'))) throw new Error('用法: grep [-irn] [--regex] <文本> <文件/目录>')
    if (pattern.length > 256) throw new Error('grep: 模式过长')
    const insensitive = [...flags].some(flag => /^-[irn]*i/.test(flag))
    const recursive = [...flags].some(flag => /^-[irn]*r/.test(flag))
    const numbered = [...flags].some(flag => /^-[irn]*n/.test(flag))
    const target = requirePath(file ?? '.')
    const files = []
    if (fs.lstatSync(target).isDirectory()) {
      if (!recursive) throw new Error('grep: 搜索目录需要 -r')
      walkEntries(target, (entry, full) => { if (entry.isFile()) files.push(full) })
    } else files.push(target)
    const literal = insensitive ? pattern.toLocaleLowerCase() : pattern
    for (const filePath of files) {
      checkBudget()
      if (outputTruncated) break
      let text
      try { text = readFileBounded(filePath).toString('utf8') }
      catch (error) { outln(`grep: ${visibleName(path.relative(cwd, filePath))}: ${plainText(error.message)}`); continue }
      const lines = splitLines(text)
      let matches
      if (flags.has('--regex') && !flags.has('-F')) matches = await regexLineMatches(pattern, insensitive ? 'i' : '', text)
      else {
        matches = []
        for (let i = 0; i < lines.length; i++) {
          if (i % 256 === 0) checkBudget()
          if ((insensitive ? lines[i].toLocaleLowerCase() : lines[i]).includes(literal)) matches.push(i)
        }
      }
      for (const index of matches) {
        if (outputTruncated) break
        const rel = visibleName(path.relative(cwd, filePath).replace(/\\/g, '/'))
        outln(`${C.cyan}${rel}${C.reset}${numbered ? ':' + (index + 1) : ''}: ${plainText(lines[index].replace(/\r$/, ''))}`)
      }
    }
  },

  tree(args) {
    let depth = 3, directory
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '-L') depth = positiveInteger(args[++i], MAX_DEPTH, '深度')
      else if (args[i].startsWith('-') || directory !== undefined) throw new Error('用法: tree [目录] [-L 深度]')
      else directory = args[i]
    }
    const target = requirePath(directory ?? '.')
    outln(`${C.blue}${C.bold}.${C.reset}`)
    printTree(target, '', 0, depth)
  },

  // ── 工作空间管理 ───────────────────────────────────────────────────────
  ws(args) {
    if (args.length > 2 || (args[0] !== 'cd' && args.length > 1)) throw new Error('用法: ws [ls|cd 序号]')
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
      const idx = positiveInteger(args[1] ?? '1', WORKSPACE_ROOTS.length, '工作空间序号') - 1
      if (idx >= 0 && idx < WORKSPACE_ROOTS.length) { cwd = WORKSPACE_ROOTS[idx] }
      else outln(`${C.red}工作空间不存在${C.reset}`)
      return
    }
    outln('用法: ws [ls|cd <序号>]')
  },

  // ── 其他实用命令 ───────────────────────────────────────────────────────
  echo(args) { outln(plainText(args.join(' '))) },

  env(args) {
    if (args.length > 1) throw new Error('用法: env [变量名]')
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

  head(args) { showLines(args, false) },
  tail(args) { showLines(args, true) },
  wc(args) {
    const { values, flags } = positional(args, ['-l', '-w', '-c'])
    if (values.length !== 1) throw new Error('用法: wc [-l|-w|-c] <文件>')
    const data = readFileBounded(values[0]), text = data.toString('utf8')
    let newlines = 0, words = 0, inWord = false
    for (let i = 0; i < text.length; i++) {
      if (i % 4096 === 0) checkBudget()
      if (text[i] === '\n') newlines++
      if (/\s/.test(text[i])) inWord = false
      else if (!inWord) { words++; inWord = true }
    }
    const counts = { '-l': newlines, '-w': words, '-c': data.length }
    const selected = flags.size ? [...flags] : ['-l', '-w', '-c']
    outln(`${selected.map(flag => counts[flag]).join(' ')} ${visibleName(values[0])}`)
  },
  stat(args) {
    if (args.length !== 1) throw new Error('用法: stat <路径>')
    const resolved = requirePath(args[0]), stat = fs.lstatSync(resolved)
    outln(JSON.stringify({ path: visibleName(args[0]), type: stat.isSymbolicLink() ? 'link' : stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'special',
      bytes: stat.isFile() ? stat.size : null, modifiedAt: stat.mtime.toISOString(), contentReadable: stat.isFile() && stat.nlink === 1 }, null, 2))
  },
  hash(args) {
    const [file, algorithm = 'sha256'] = args
    if (!file || args.length > 2 || !['sha256', 'sha512'].includes(algorithm)) throw new Error('用法: hash <文件> [sha256|sha512]')
    outln(`${createHash(algorithm).update(readFileBounded(file)).digest('hex')}  ${visibleName(file)}`)
  },
  which(args) {
    if (!args.length) throw new Error('用法: which <命令...>')
    for (const name of args) outln(`${plainText(name)}: ${Object.hasOwn(BUILTINS, name) ? '内置命令' : '不可用（不查询宿主 PATH）'}`)
  },
  whoami() { outln('workspace-user（受限文件视图身份，不是宿主操作系统账号）') },
  version() { outln('Workspace Shell 1.1（受限文件视图）') },
  diagnose(args) {
    if (args.length && (args.length !== 1 || args[0] !== '--json')) throw new Error('用法: diagnose [--json]')
    const result = { kind: 'restricted-file-view', osIsolation: false, externalProcesses: false, hostEnvironmentVisible: false,
      workspaceCount: WORKSPACE_ROOTS.length, currentPathAvailable: safeResolve('.') !== null,
      limits: { inputBytes: MAX_INPUT_BYTES, outputBytes: MAX_OUTPUT_BYTES, fileBytes: MAX_FILE_BYTES, scannedEntries: MAX_ENTRIES, depth: MAX_DEPTH, textLines: MAX_TEXT_LINES, regexMs: 300 } }
    if (args[0] === '--json') outln(JSON.stringify(result, null, 2))
    else {
      outln('当前终端：受限文件视图；没有操作系统隔离。')
      outln(`工作空间: ${result.workspaceCount}；当前路径: ${result.currentPathAvailable ? '可用' : '不可用'}`)
      outln('外部进程: 禁止；宿主环境变量: 不可见；执行程序需要操作系统隔离终端。')
      outln(`单命令预算: 文件 ${MAX_FILE_BYTES} 字节 / 输出 ${MAX_OUTPUT_BYTES} 字节 / 扫描 ${MAX_ENTRIES} 项。`)
    }
  },
  help(args) {
    if (args.length > 1) throw new Error('用法: help [命令]')
    if (args[0]) {
      const topic = args[0]
      if (Object.hasOwn(HELP, topic)) { outln(`${C.bold}${topic}${C.reset} — ${HELP[topic][0]}`); HELP[topic].slice(1).forEach(line => outln('  ' + line)); return }
      outln(`未找到 "${plainText(topic)}" 的帮助，输入 help 查看全部命令`)
      return
    }
    outln(`${C.bold}Workspace Shell 帮助（受限文件视图）${C.reset}`)
    for (const [name, lines] of Object.entries(HELP)) outln(`  ${C.cyan}${name.padEnd(10)}${C.reset} ${lines[0]}`)
    outln('输入 help <命令> 查看用法。引号内的分号保留为文本；引号外分号顺序执行。')
    outln('Tab 补全 · ↑/↓ 历史 · Ctrl+L 清屏 · Ctrl+C 取消搜索')
    outln('外部进程、管道、重定向和命令替换不可用。需要执行程序时使用操作系统隔离终端。')
    outln('这是受限文件视图，不是操作系统安全沙箱；diagnose 可查看边界和预算。')
  },

  // exit 命令已禁用——终端由外部管理，不允许从 Shell 内部退出
  exit() {
    outln(`${C.yellow}提示：此终端由系统管理，无法从 Shell 内部退出。${C.reset}`)
    outln(`${C.dim}如需关闭，请关闭终端面板。${C.reset}`)
  },
}

// One entry per command keeps menu and topic coverage reviewable.
const HELP = {
  cd: ['切换目录', 'cd <目录> | cd .. | cd ~ | cd @ws2', '仅可访问绑定的工作空间。'],
  pwd: ['显示当前工作区路径', 'pwd'],
  ls: ['列出目录内容', 'ls [-a|-l|-la|-al] [目录]', '-a 包含隐藏项；-l 显示详细信息。'],
  ll: ['详细文件列表', 'll [-a] [目录]'],
  tree: ['目录树', 'tree [目录] [-L 深度]', '默认深度 3；范围 1–32；不跟随目录链接。'],
  cat: ['显示文件内容', 'cat <文件>', '只读取普通单链接文件，最多 8 MiB；控制字符显示为文本。'],
  head: ['显示文件前几行', 'head [-n 行数] <文件>', '默认 10 行；范围 1–10000；文件最多 8 MiB。'],
  tail: ['显示文件最后几行', 'tail [-n 行数] <文件>', '默认 10 行；范围 1–10000；文件最多 8 MiB。'],
  wc: ['统计换行、单词和字节', 'wc [-l|-w|-c] <文件>', '默认依次输出换行数、空白分词数、字节数；文件最多 8 MiB。'],
  stat: ['显示工作区文件元数据', 'stat <路径>', '不解析链接目标，也不显示宿主账号。'],
  hash: ['计算文件校验和', 'hash <文件> [sha256|sha512]', '默认 SHA-256；文件最多 8 MiB。'],
  touch: ['创建空文件或更新时间戳', 'touch <文件>', '不截断已有内容，不修改链接目标。'],
  mkdir: ['创建目录', 'mkdir <目录>', '自动创建缺失的父目录。'],
  rm: ['删除文件或目录', 'rm [-r|-f|-rf|-fr] <路径>', '删除不可撤销；禁止删除任一工作空间根或其祖先。'],
  cp: ['复制文件', 'cp <源> <目标>', '只复制普通单链接文件，最多 8 MiB；覆盖目标内容。'],
  mv: ['移动或重命名', 'mv <源> <目标>', '禁止移动、覆盖工作空间根或其祖先。'],
  find: ['按文件名搜索', 'find [目录] [-name 模式]', '* 匹配任意字符，? 匹配一个字符；不跟随链接。'],
  grep: ['搜索文件内容（默认字面文本）', 'grep [-i] [-r] [-n] [--regex] <文本> <文件/目录>', '-i 忽略大小写，-r 递归，-n 行号；可合并为 -irn。', '--regex 启用正则；独立线程每文件最多 300 ms，超时会停止；-F 强制字面文本。', '匹配以 - 开头的文本时，在参数前加 --。'],
  ws: ['查看或切换绑定的工作空间', 'ws | ws ls | ws cd <序号>'],
  echo: ['输出文本', 'echo <文本>', '不展开环境变量，不执行命令替换和重定向。'],
  env: ['显示允许的环境摘要', 'env [NODE_ENV|TERM|LANG]', '不提供任意宿主环境变量或秘密。'],
  which: ['检查内置命令是否可用', 'which <命令...>', '不查找宿主 PATH 或外部程序。'],
  whoami: ['显示文件视图身份', 'whoami', '此身份不是宿主操作系统账号。'],
  version: ['显示终端协议版本', 'version'],
  diagnose: ['显示边界、能力和预算', 'diagnose [--json]', '结果描述当前受限文件视图，不证明操作系统隔离。'],
  clear: ['清屏', 'clear | Ctrl+L'],
  help: ['显示命令帮助', 'help [命令]'],
  exit: ['终端由界面管理', '关闭终端标签页以结束会话；exit 不关闭会话。'],
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
// Keep a compact identity marker at the end of the startup block.  Small
// xterm viewports scroll the first banner lines out of view while the shell
// starts; the marker keeps the product identity visible beside the prompt.
outln(`${C.bold}${C.cyan}Workspace Shell${C.reset}`)
outln()

// ── Tab 补全 ──────────────────────────────────────────────────────────────

/** 根据部分路径字符串，返回匹配的文件/目录候选列表 */
function getPathCompletions(partial) {
  try {
    const norm = partial.replace(/\\/g, '/')
    const lastSlash = norm.lastIndexOf('/')
    const dirPart  = lastSlash >= 0 ? norm.slice(0, lastSlash + 1) : ''
    const filePart = lastSlash >= 0 ? norm.slice(lastSlash + 1) : norm
    const searchDir = safeResolve(dirPart || '.')
    if (!searchDir || !fs.existsSync(searchDir)) return []
    return readEntriesBounded(searchDir, 500)
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

// Bound unfinished lines before readline buffers them. The byte budget also
// bounds escape-sequence churn; a rejected line is discarded as a whole.
let inputBytes = 0, droppingInput = false
const boundedInput = new Transform({
  transform(chunk, _encoding, callback) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    let start = 0
    for (let i = 0; i < data.length; i++) {
      const byte = data[i]
      if (byte === 0x04 || IS_WINDOWS && byte === 0x1a) {
        if (!droppingInput && i > start) this.push(data.subarray(start, i))
        start = i + 1
        continue
      }
      if (byte === 10 || byte === 13) {
        if (droppingInput) {
          droppingInput = false
          process.stdout.write(`\r\n输入超过 ${MAX_INPUT_BYTES} 字节预算，该行已丢弃\r\n`)
          this.push(Buffer.from('\r'))
          start = i + 1
        }
        inputBytes = 0
      } else if (!droppingInput && ++inputBytes > MAX_INPUT_BYTES) {
        if (i > start) this.push(data.subarray(start, i))
        this.push(Buffer.from('\x15'))
        droppingInput = true
        start = i + 1
      }
    }
    if (!droppingInput && start < data.length) this.push(data.subarray(start))
    callback()
  },
})
process.stdin.pipe(boundedInput)

const rl = createInterface({
  input:     boundedInput,
  output:    process.stdout,
  terminal:  true,           // 开启终端模式（Tab 补全、行编辑、历史记录）
  completer: tabCompleter,   // Tab 补全函数
})

function showPrompt() {
  if (inputClosed || queuedLines > 0) return
  rl.setPrompt(getPrompt())
  rl.prompt()
}

// ── Ctrl+C：raw mode 下 PTY 不发信号，readline 拦截后触发此事件 ──────────
rl.on('SIGINT', () => {
  commandCancelled = true
  if (activeWorker) void activeWorker.terminate()
  process.stdout.write('^C\r\n')
  showPrompt()
})

// ── 兜底：canonical mode 下 PTY 仍会发真实 SIGINT ────────────────────────
process.on('SIGINT', () => {
  commandCancelled = true
  if (activeWorker) void activeWorker.terminate()
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
let queuedBytes = 0, queuedLines = 0, inputClosed = false
function parseCommands(input) {
  const commands = []
  let tokens = [], token = '', quote = '', started = false
  const finishToken = () => { if (started) tokens.push(token); token = ''; started = false }
  for (const char of input) {
    if (quote) {
      if (char === quote) quote = ''
      else token += char
      started = true
    } else if (char === '"' || char === "'") { quote = char; started = true }
    else if (char === ';') { finishToken(); if (tokens.length) commands.push(tokens); tokens = [] }
    else if (/\s/.test(char)) finishToken()
    else { token += char; started = true }
  }
  if (quote) throw new Error('引号未闭合；该行没有执行')
  finishToken()
  if (tokens.length) commands.push(tokens)
  return commands
}
async function processLine(line) {
  resetOutputBudget()
  visitedEntries = 0
  commandDeadline = Date.now() + COMMAND_DEADLINE_MS
  commandCancelled = false
  if (Buffer.byteLength(line, 'utf8') > MAX_INPUT_BYTES) { outln(`输入超过 ${MAX_INPUT_BYTES} 字节预算`); return }
  if (/[\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(line)) throw new Error('输入包含不支持的控制字符')
  for (const [cmd, ...args] of parseCommands(line.trim())) {
    checkBudget()
    if (Object.hasOwn(BUILTINS, cmd)) {
      try { await BUILTINS[cmd](args) }
      catch (error) { outln(`${C.red}${cmd}: ${plainText(error.message)}${C.reset}`) }
    } else outln(`${C.yellow}已拒绝外部命令 “${plainText(cmd)}”：请使用操作系统隔离执行器${C.reset}`)
  }
}
rl.on('line', line => {
  const bytes = Buffer.byteLength(line)
  if (queuedBytes + bytes > MAX_QUEUE_BYTES || queuedLines >= MAX_QUEUE_LINES) {
    process.stdout.write('\r\n命令队列繁忙，该行未执行；请等待当前命令完成\r\n')
    return
  }
  queuedBytes += bytes; queuedLines++
  commandQueue = commandQueue.then(() => processLine(line)).catch(error => {
    outln(`${C.red}命令处理失败：${plainText(error.message)}${C.reset}`)
  }).finally(() => {
    queuedBytes -= bytes; queuedLines--
    commandDeadline = Infinity; visitedEntries = 0
    showPrompt()
  })
})

// A closed pipe still has queued complete lines; drain them before exiting.
rl.on('close', () => { inputClosed = true; void commandQueue.finally(() => { process.exitCode = 0 }) })

// 显示初始提示符
showPrompt()
