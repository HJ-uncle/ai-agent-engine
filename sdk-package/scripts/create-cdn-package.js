#!/usr/bin/env node
/**
 * create-cdn-package.js
 *
 * 将 sdk-package/bin/ 目录打包为平台 .tgz，供上传到 CDN。
 *
 * 使用方式：
 *   node scripts/create-cdn-package.js [version] [platform]
 *
 * 示例：
 *   node scripts/create-cdn-package.js 0.1.0 win32-x64
 *   node scripts/create-cdn-package.js 0.1.0           # 自动检测当前平台
 *
 * 产出：
 *   release/agent-engine-<version>-<platform>.tgz
 *
 * 前置条件：
 *   1. 主包已执行 npm run build（产出 dist/）
 *   2. sdk-package 已执行 npm run build:full（产出 bin/）
 */

const fs = require('fs')
const path = require('path')

const { createTgzSync } = require('./tar-helper')

// ==================== 参数解析 ====================

const sdkPackageDir = path.resolve(__dirname, '..')
const agentEngineRoot = path.resolve(sdkPackageDir, '..')
const binDir = path.join(sdkPackageDir, 'bin')
const releaseDir = path.join(agentEngineRoot, 'release')

const version = process.argv[2] || require(path.join(agentEngineRoot, 'package.json')).version
const platform = process.argv[3] || `${process.platform}-${process.arch}`

console.log(`\n[create-cdn-package] 打包版本: ${version}，平台: ${platform}`)

// ==================== 前置检查 ====================

if (!fs.existsSync(binDir)) {
  console.error(
    `[create-cdn-package] 错误：bin/ 目录不存在: ${binDir}\n` +
    `请先执行：npm run build:full`
  )
  process.exit(1)
}

if (!fs.existsSync(path.join(binDir, 'dist', 'main.js'))) {
  console.error(
    `[create-cdn-package] 错误：bin/dist/main.js 不存在\n` +
    `请先执行：npm run build:full`
  )
  process.exit(1)
}

// ==================== 创建输出目录 ====================

fs.mkdirSync(releaseDir, { recursive: true })

const outputFile = path.join(releaseDir, `agent-engine-${version}-${platform}.tgz`)

// ==================== 打包 ====================

console.log(`[create-cdn-package] 正在打包，请稍候...`)
console.log(`  源目录：${binDir}`)
console.log(`  输出：${outputFile}`)

// 进度条渲染（原地刷新同一行）
let lastPercent = -1
function onProgress({ done, total, percent, stage }) {
  if (stage === 'compressing') {
    process.stdout.write('\r[create-cdn-package] 压缩中...                      ')
    return
  }
  if (percent === lastPercent) return
  lastPercent = percent
  const filled = Math.floor(percent / 5)   // 20 格进度条
  const bar = '█'.repeat(filled) + '░'.repeat(20 - filled)
  process.stdout.write(`\r[create-cdn-package] [${bar}] ${percent}%  (${done}/${total} 文件)`)
}

createTgzSync(binDir, outputFile, 'package', onProgress)
process.stdout.write('\n')

// 计算文件大小
const stats = fs.statSync(outputFile)
const sizeMB = (stats.size / 1024 / 1024).toFixed(1)
const cdnBase = 'https://fyav-pipe.s3.netease.com/static/wuzu-client/agent-engine'
const cdnUrl = `${cdnBase}/${version}/${path.basename(outputFile)}`

console.log(`\n✓ 打包完成！`)
console.log(`  文件大小：${sizeMB} MB`)
console.log(`\n  上传到 S3 的路径：`)
console.log(`  ${version}/${path.basename(outputFile)}`)

// ==================== 更新 versions.json ====================

const versionsFile = path.join(releaseDir, 'versions.json')

let versionsJson = { latest: version, versions: [] }
if (fs.existsSync(versionsFile)) {
  try {
    versionsJson = JSON.parse(fs.readFileSync(versionsFile, 'utf8'))
  } catch (e) {
    console.warn(`[create-cdn-package] versions.json 解析失败，将重建：${e.message}`)
  }
}

// 找到或新建对应 version 条目
let versionEntry = versionsJson.versions.find(v => v.version === version)
if (!versionEntry) {
  versionEntry = {
    version,
    releaseDate: new Date().toISOString().slice(0, 10),
    changelog: '',
    platforms: {}
  }
  versionsJson.versions.push(versionEntry)
  // 保持 versions 按版本降序
  versionsJson.versions.sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }))
}

// 更新当前平台的 url + size，同时刷新 releaseDate 为今天
if (!versionEntry.platforms) versionEntry.platforms = {}
versionEntry.releaseDate = new Date().toISOString().slice(0, 10)
versionEntry.platforms[platform] = {
  url: cdnUrl,
  size: stats.size
}

// 同步 latest 指向最高版本
versionsJson.latest = versionsJson.versions[0].version

fs.writeFileSync(versionsFile, JSON.stringify(versionsJson, null, 2) + '\n', 'utf8')
console.log(`\n  versions.json 已更新：`)
console.log(`    平台: ${platform}  url: ${cdnUrl}  size: ${stats.size}`)
console.log(`  文件路径：${versionsFile}`)
