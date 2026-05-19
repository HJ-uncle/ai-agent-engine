#!/usr/bin/env node
/**
 * copy-bin.js
 *
 * 将 agent-engine 主包编译产物复制到 sdk-package/bin/，供 SDK 打包使用。
 *
 * 前置条件：主包根目录已执行 `npm run build`（产出 dist/main.js）
 *
 * 执行：node scripts/copy-bin.js
 */

const fs = require('fs')
const path = require('path')

// ==================== 路径定义 ====================

const sdkPackageDir = path.resolve(__dirname, '..')
const agentEngineRoot = path.resolve(sdkPackageDir, '..')
const distMainJs = path.join(agentEngineRoot, 'dist', 'main.js')
const srcNodeModules = path.join(agentEngineRoot, 'node_modules')
const binDir = path.join(sdkPackageDir, 'bin')
const binMainJs = path.join(binDir, 'main.js')
const binNodeModules = path.join(binDir, 'node_modules')

// ==================== 前置检查 ====================

if (!fs.existsSync(distMainJs)) {
  console.error(
    `[copy-bin] 错误：dist/main.js not found at ${distMainJs}\n` +
    `请先在 agent-engine 根目录执行：\n` +
    `  npm run build\n` +
    `然后再执行 sdk-package 的构建。`
  )
  process.exit(1)
}

if (!fs.existsSync(srcNodeModules)) {
  console.error(
    `[copy-bin] 错误：node_modules not found at ${srcNodeModules}\n` +
    `请先在 agent-engine 根目录执行：\n` +
    `  npm install`
  )
  process.exit(1)
}

// ==================== 清理旧 bin/ 目录（全量重建，避免残留） ====================

if (fs.existsSync(binDir)) {
  console.log(`[copy-bin] 清理旧 bin/ 目录...`)
  fs.rmSync(binDir, { recursive: true, force: true })
}
fs.mkdirSync(binDir, { recursive: true })

// ==================== 复制 dist/main.js → bin/main.js ====================

console.log(`[copy-bin] 复制 dist/main.js → bin/main.js`)
fs.copyFileSync(distMainJs, binMainJs)

// ==================== 复制 dist/ 其余文件（若存在子模块） ====================

const distDir = path.join(agentEngineRoot, 'dist')
const binDistDir = path.join(binDir, 'dist')

// 将整个 dist/ 复制到 bin/dist/（agent-engine 用 ESM import，main.js 会引用其他 dist 文件）
if (fs.existsSync(distDir)) {
  console.log(`[copy-bin] 复制 dist/ → bin/dist/`)
  copyDirRecursive(distDir, binDistDir, [])
  // 把 bin/main.js 覆盖为 bin/dist/main.js（保持根目录 main.js 入口不变）
  if (fs.existsSync(path.join(binDistDir, 'main.js'))) {
    fs.copyFileSync(path.join(binDistDir, 'main.js'), binMainJs)
  }
}

// ==================== 复制 node_modules → bin/node_modules ====================

// devDependencies 动态从 package.json 读取，避免手动维护黑名单遗漏
const rootPkg = require(path.join(agentEngineRoot, 'package.json'))
const DEV_ONLY_PACKAGES = new Set(Object.keys(rootPkg.devDependencies ?? {}))

console.log(`[copy-bin] 复制 node_modules → bin/node_modules（排除 devDependencies）`)
fs.mkdirSync(binNodeModules, { recursive: true })

const packages = fs.readdirSync(srcNodeModules)
let copied = 0
let skipped = 0

for (const pkg of packages) {
  // 跳过 .bin 等非包目录（但保留 .bin，agent-engine 脚本可能需要）
  const isDevOnly = DEV_ONLY_PACKAGES.has(pkg) ||
    [...DEV_ONLY_PACKAGES].some(d => pkg.startsWith(d + '/'))

  if (isDevOnly) {
    skipped++
    continue
  }

  const srcPkg = path.join(srcNodeModules, pkg)
  const dstPkg = path.join(binNodeModules, pkg)

  // scoped 包（@xxx/yyy）需要先创建父目录
  if (pkg.startsWith('@')) {
    fs.mkdirSync(dstPkg, { recursive: true })
    const subPkgs = fs.readdirSync(srcPkg)
    for (const sub of subPkgs) {
      copyDirRecursive(path.join(srcPkg, sub), path.join(dstPkg, sub), [])
      copied++
    }
  } else {
    copyDirRecursive(srcPkg, dstPkg, [])
    copied++
  }
}

console.log(`[copy-bin] node_modules 完成：${copied} 个包已复制，${skipped} 个 dev 包已跳过`)

// ==================== 复制配置文件（.env.example 等） ====================

const configFiles = ['.env.example', 'config']
for (const f of configFiles) {
  const src = path.join(agentEngineRoot, f)
  if (fs.existsSync(src)) {
    const dst = path.join(binDir, f)
    if (fs.statSync(src).isDirectory()) {
      copyDirRecursive(src, dst, [])
    } else {
      fs.copyFileSync(src, dst)
    }
    console.log(`[copy-bin] 复制 ${f} → bin/${f}`)
  }
}

// ==================== 写入 package.json（声明 "type": "module"）====================

// agent-engine 是 ESM 项目，Node.js 需要 package.json 中的 "type": "module" 来正确解析 .js 文件
// 只保留必要字段，避免把 devDependencies 等无关信息带入运行时
const runtimePkg = {
  name: rootPkg.name,
  version: rootPkg.version,
  type: rootPkg.type ?? 'module'
}
fs.writeFileSync(path.join(binDir, 'package.json'), JSON.stringify(runtimePkg, null, 2), 'utf-8')
console.log(`[copy-bin] 写入 bin/package.json (type: ${runtimePkg.type})`)

console.log(`\n[copy-bin] ✓ bin/ 构建完成`)

// ==================== 工具函数 ====================

/**
 * 递归复制目录，跳过 excludePatterns 中匹配的子目录/文件名
 */
function copyDirRecursive(src, dst, excludePatterns) {
  if (!fs.existsSync(src)) return

  const stat = fs.statSync(src)
  if (!stat.isDirectory()) {
    // 直接复制文件
    fs.mkdirSync(path.dirname(dst), { recursive: true })
    fs.copyFileSync(src, dst)
    return
  }

  fs.mkdirSync(dst, { recursive: true })
  const entries = fs.readdirSync(src)

  for (const entry of entries) {
    // 跳过 __tests__、*.test.js、*.spec.js、.cache 等
    // 同时跳过 TypeScript 声明文件（*.d.ts、*.d.ts.map）——运行时不需要
    if (
      entry === '__tests__' ||
      entry === 'test' ||
      entry === 'tests' ||
      entry === '.cache' ||
      entry === '.git' ||
      entry.endsWith('.test.js') ||
      entry.endsWith('.spec.js') ||
      entry.endsWith('.map') ||
      entry.endsWith('.d.ts') ||
      entry.endsWith('.d.ts.map')
    ) {
      continue
    }

    const srcEntry = path.join(src, entry)
    const dstEntry = path.join(dst, entry)
    copyDirRecursive(srcEntry, dstEntry, excludePatterns)
  }
}
