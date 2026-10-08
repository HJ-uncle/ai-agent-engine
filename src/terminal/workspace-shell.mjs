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

// ── 格式化文件大小 ─────────────────────────────────────────────────────────
function fmtSize(bytes) {
  if (bytes == null) return '     -'
  if (bytes < 1024) return String(bytes).padStart(6)
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1).padStart(5) + 'K'
  if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1).padStart(5) + 'M'
  return (bytes / 1024 / 1024 / 1024).toFixed(1).padStart(5) + 'G'
}

function fmtDate(d) {
  if (!d) return '                '
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
    const showHidden = args.includes('-a') || args.includes('-la') || args.includes('-al')
    const targetArg = args.find(a => !a.startsWith('-')) 
    const target = targetArg ? safeResolve(targetArg) : cwd
    if (!target) { outln(`${C.red}⛔ 禁止访问工作空间外路径${C.reset}`); return }
    try {
      const entries = readEntriesBounded(target)
        .filter(e => showHidden || !e.name.startsWith('.'))
        .sort((a, b) => {
          if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1
          return a.name.localeCompare(b.name)
        })
      const cols = Math.floor((process.stdout.columns || 80) / 22) || 1
      const names = entries.map(e => {
        const color = e.isDirectory() ? C.blue + C.bold : C.reset
        const suffix = e.isDirectory() ? '/' : ''
        return `${color}${e.name}${suffix}${C.reset}`
      })
      // 按列排列
      for (let i = 0; i < names.length; i += cols) {
        outln(names.slice(i, i + cols).join('  '))
      }
    } catch (e) { outln(`ls: ${e.message}`) }
  },

  ll(args) {
    const showHidden = args.includes('-a')
    const targetArg = args.find(a => !a.startsWith('-'))
    const target = targetArg ? safeResolve(targetArg) : cwd
    if (!target) { outln(`${C.red}⛔ 禁止访问工作空间外路径${C.reset}`); return }
    try {
      const entries = readEntriesBounded(target)
        .filter(e => showHidden || !e.name.startsWith('.'))
        .sort((a, b) => {
          if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1
          return a.name.localeCompare(b.name)
        })
      outln(`${C.dim}${'类型'.padEnd(6)} ${'大小'.padStart(6)}  ${'修改时间'.padEnd(16)}  名称${C.reset}`)
      outln(`${C.dim}${'-'.repeat(55)}${C.reset}`)
      for (const e of entries) {
        let stat, size, mtime
        try { stat = fs.statSync(path.join(target, e.name)); size = stat.size; mtime = stat.mtime } catch {}
        const type = e.isDirectory() ? `${C.blue}dir${C.reset}  ` : `${C.dim}file${C.reset} `
        const color = e.isDirectory() ? C.blue + C.bold : C.reset
        const suffix = e.isDirectory() ? '/' : ''
        outln(`${type} ${fmtSize(size)}  ${C.dim}${fmtDate(mtime)}${C.reset}  ${color}${e.name}${suffix}${C.reset}`)
      }
      outln(`${C.dim}共 ${entries.length} 项${C.reset}`)
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
        ls:    [`${C.bold}ls${C.reset} — 列出目录内容`, `  ls           列出当前目录`, `  ls -a        包含隐藏文件（. 开头）`, `  ls <目录>    列出指定目录`],
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
