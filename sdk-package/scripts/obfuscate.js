#!/usr/bin/env node
/**
 * obfuscate.js
 *
 * 对指定目录下所有 .js 文件执行混淆 + 压缩，原地替换。
 *
 * 用法：
 *   node scripts/obfuscate.js <目录1> [目录2] ...
 *
 * 示例：
 *   node scripts/obfuscate.js dist bin/dist
 */

const fs = require('fs')
const path = require('path')
// javascript-obfuscator 安装在根目录 node_modules，Node 模块解析自动向上查找
const JavaScriptObfuscator = require('javascript-obfuscator')

// ==================== 混淆配置 ====================

/**
 * 排除混淆的目录名或文件名
 */
const SKIP_NAMES = new Set([
  'public',           // 前端静态资源（通常已压缩，且包含浏览器端代码）
  'node_modules',     // 第三方库
  '__tests__',        // 测试代码
  'test',
  'tests',
])

/**
 * 混淆选项说明：
 *
 * - compact: true              — 压缩为单行（等效 minify）
 * - identifierNamesGenerator  — 变量名替换策略
 *   'hexadecimal'              — 变量名变为 _0x1a2b 格式
 * - renameGlobals: false       — 不混淆全局变量（避免破坏 Node.js 内置/第三方模块调用）
 * - stringArray: true          — 字符串提取到数组，通过函数引用
 * - stringArrayEncoding        — base64 编码字符串数组，增加可读性阻断
 * - rotateStringArray: true    — 字符串数组随机旋转，增加分析难度
 * - shuffleStringArray: true   — 字符串数组随机打乱
 * - splitStrings: false        — 不拆分字符串（拆分会显著增大体积）
 * - controlFlowFlattening      — 控制流平坦化（增大体积约 2x，但提升逆向难度，可按需开启）
 * - deadCodeInjection: false   — 不注入死代码（会显著增大体积）
 * - selfDefending: false       — 不启用自我保护（格式化攻击检测，会与部分工具冲突）
 * - target: 'node'             — 目标环境，确保 Buffer/process 等全局量不被混淆
 */
const OBFUSCATE_OPTIONS = {
  compact: true,
  identifierNamesGenerator: 'hexadecimal',
  renameGlobals: false,
  stringArray: true,
  stringArrayEncoding: ['base64'],
  rotateStringArray: true,
  shuffleStringArray: true,
  splitStrings: false,
  controlFlowFlattening: false,
  deadCodeInjection: false,
  selfDefending: false,
  target: 'node',
}

// ==================== 主逻辑 ====================

const args = process.argv.slice(2)
if (args.length === 0) {
  console.error('[obfuscate] 用法: node scripts/obfuscate.js <目录1> [目录2] ...')
  process.exit(1)
}

let totalFiles = 0
let totalErrors = 0

for (const relDir of args) {
  const absDir = path.resolve(__dirname, '..', relDir)
  if (!fs.existsSync(absDir)) {
    console.warn(`[obfuscate] 目录不存在，跳过: ${absDir}`)
    continue
  }
  console.log(`[obfuscate] 处理目录: ${absDir}`)
  const { files, errors } = obfuscateDir(absDir)
  totalFiles += files
  totalErrors += errors
}

console.log(`\n[obfuscate] ✓ 完成：${totalFiles} 个文件已混淆，${totalErrors} 个错误`)

if (totalErrors > 0) {
  process.exit(1)
}

// ==================== 工具函数 ====================

/**
 * 递归混淆目录下所有 .js 文件（原地替换）
 */
function obfuscateDir(dir) {
  let files = 0
  let errors = 0

  const entries = fs.readdirSync(dir)
  for (const entry of entries) {
    if (SKIP_NAMES.has(entry)) {
      console.log(`  - 跳过目录/文件: ${entry}`)
      continue
    }

    const fullPath = path.join(dir, entry)
    const stat = fs.statSync(fullPath)

    if (stat.isDirectory()) {
      const sub = obfuscateDir(fullPath)
      files += sub.files
      errors += sub.errors
    } else if (stat.isFile() && entry.endsWith('.js')) {
      const result = obfuscateFile(fullPath)
      if (result) {
        files++
      } else {
        errors++
      }
    }
  }

  return { files, errors }
}

/**
 * 混淆单个 .js 文件（原地替换）
 * @returns {boolean} 成功返回 true
 */
function obfuscateFile(filePath) {
  try {
    const source = fs.readFileSync(filePath, 'utf8')

    // 跳过空文件
    if (!source.trim()) return true

    const result = JavaScriptObfuscator.obfuscate(source, OBFUSCATE_OPTIONS)
    const obfuscated = result.getObfuscatedCode()

    fs.writeFileSync(filePath, obfuscated, 'utf8')
    console.log(`  ✓ ${path.relative(process.cwd(), filePath)}`)
    return true
  } catch (err) {
    console.error(`  ✗ ${filePath}: ${err.message}`)
    return false
  }
}
