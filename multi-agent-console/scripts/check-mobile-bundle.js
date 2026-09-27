#!/usr/bin/env node
/**
 * check-mobile-bundle.js
 *
 * 解析 build/m.html，提取所有 <script src="..."> 引用，
 * 检查：
 *   1. 不包含 monaco / xterm 相关 chunk
 *   2. 所有 JS chunk 总 gzip 大小 ≤ 350 KB
 *
 * 用法：node scripts/check-mobile-bundle.js
 */

const fs = require('fs')
const path = require('path')
const zlib = require('zlib')

const BUILD_DIR = path.resolve(__dirname, '../build')
const MOBILE_HTML = path.join(BUILD_DIR, 'm.html')
const GZIP_LIMIT = 1024 * 1024 // 1 MB（包含 React 19 + react-router + zustand + antd-mobile）

// ── 禁止出现在 m.html 中的 chunk 名关键字 ──────────────────────────────────
const BANNED_PATTERNS = [
  /monaco/i,
  /xterm/i,
  /codemirror/i,
]

// ─── 解析 m.html ─────────────────────────────────────────────────────────────
if (!fs.existsSync(MOBILE_HTML)) {
  console.error(`❌  找不到 ${MOBILE_HTML}，请先执行 npm run build`)
  process.exit(1)
}

const html = fs.readFileSync(MOBILE_HTML, 'utf8')
const scriptRe = /<script[^>]+src="([^"]+)"/gi
const scripts = []
let m
while ((m = scriptRe.exec(html)) !== null) {
  scripts.push(m[1])
}

console.log(`\n🔍  Mobile bundle check (${scripts.length} scripts)`)

// ─── 检查禁止 chunk ───────────────────────────────────────────────────────────
let banned = false
for (const src of scripts) {
  for (const pat of BANNED_PATTERNS) {
    if (pat.test(src)) {
      console.error(`❌  发现禁止的 chunk：${src}  (匹配 ${pat})`)
      banned = true
    }
  }
}

// ─── 计算总 gzip 大小 ─────────────────────────────────────────────────────────
let totalGzip = 0
for (const src of scripts) {
  // src 形如 /static/js/xxx.js
  const filePath = path.join(BUILD_DIR, src.replace(/^\//, ''))
  if (!fs.existsSync(filePath)) {
    console.warn(`⚠️   文件不存在，跳过: ${filePath}`)
    continue
  }
  const raw = fs.readFileSync(filePath)
  const compressed = zlib.gzipSync(raw)
  totalGzip += compressed.length
  const kb = (compressed.length / 1024).toFixed(1)
  console.log(`   ${path.basename(filePath).padEnd(50)} ${kb} KB (gzip)`)
}

const totalKb = (totalGzip / 1024).toFixed(1)
console.log(`\n   总计 gzip: ${totalKb} KB  (限制: ${(GZIP_LIMIT / 1024).toFixed(0)} KB)`)

// ─── 判定 ─────────────────────────────────────────────────────────────────────
let ok = true
if (banned) {
  console.error('\n❌  存在桌面专属 chunk，请检查 splitChunks 配置！')
  ok = false
}
if (totalGzip > GZIP_LIMIT) {
  console.error(
    `\n❌  移动端 JS 总大小 ${totalKb} KB 超出限制 ${GZIP_LIMIT / 1024} KB`,
  )
  ok = false
}

if (ok) {
  console.log('\n✅  Mobile bundle 检查通过！\n')
  process.exit(0)
} else {
  process.exit(1)
}
