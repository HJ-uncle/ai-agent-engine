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
const { spawnSync } = require('child_process')

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
checkPatch(path.join(agentEngineRoot, 'node_modules/node-pty'))

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
    // Keep the historical entry usable without moving its relative ESM imports.
    fs.writeFileSync(binMainJs, "import './dist/main.js'\n", 'utf8')
  }

  // workspace-shell.mjs 是终端 shell 的运行时 asset。tsc 只编译 .ts，
  // 不会把 src 下的 .mjs 带进 dist，缺失会导致引擎终端 shell 静默退出（exit 1）
  const shellAssetSrc = path.join(agentEngineRoot, 'src', 'terminal', 'workspace-shell.mjs')
  if (fs.existsSync(shellAssetSrc)) {
    const shellAssetDst = path.join(binDistDir, 'terminal', 'workspace-shell.mjs')
    fs.mkdirSync(path.dirname(shellAssetDst), { recursive: true })
    fs.copyFileSync(shellAssetSrc, shellAssetDst)
    console.log('[copy-bin] 复制 workspace-shell.mjs → bin/dist/terminal/')
  }
}

// ==================== 复制 node_modules → bin/node_modules ====================

// devDependencies 动态从 package.json 读取，避免手动维护黑名单遗漏
const rootPkg = require(path.join(agentEngineRoot, 'package.json'))
const DEV_ONLY_PACKAGES = new Set(Object.keys(rootPkg.devDependencies ?? {}))
// LSP 的 TypeScript 适配器运行时依赖 typescript 包（主包里是 devDependency），
// 不随 bin 分发会导致诊断静默返回空结果；.bin/tsc.cmd 垫片也依赖它
const RUNTIME_DEV_DEPS = new Set(['typescript'])

console.log(`[copy-bin] 复制 node_modules → bin/node_modules（排除 devDependencies）`)
fs.mkdirSync(binNodeModules, { recursive: true })

const packages = fs.readdirSync(srcNodeModules)
let copied = 0
let skipped = 0

for (const pkg of packages) {
  // 跳过 .bin 等非包目录（但保留 .bin，agent-engine 脚本可能需要）
  const isDevOnly =
    (DEV_ONLY_PACKAGES.has(pkg) ||
      [...DEV_ONLY_PACKAGES].some((d) => pkg.startsWith(d + '/'))) &&
    !RUNTIME_DEV_DEPS.has(pkg)

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
    // typescript 包的 lib/*.d.ts 是运行时必需资源（tsc CLI 的默认 lib 加载
    // 依赖它们），不能被声明文件过滤规则裁掉
    if (pkg === 'node-pty') fs.cpSync(srcPkg, dstPkg, { recursive: true, dereference: false })
    else copyDirRecursive(srcPkg, dstPkg, [], pkg === 'typescript')
    copied++
  }
}

console.log(`[copy-bin] node_modules 完成：${copied} 个包已复制，${skipped} 个 dev 包已跳过`)
checkPatch(path.join(binNodeModules, 'node-pty'))
fs.mkdirSync(path.join(binDir, 'scripts'), { recursive: true })
fs.copyFileSync(path.join(agentEngineRoot, 'scripts/apply-node-pty-patch.mjs'), path.join(binDir, 'scripts/apply-node-pty-patch.mjs'))
fs.cpSync(path.join(agentEngineRoot, 'scripts/patches'), path.join(binDir, 'scripts/patches'), { recursive: true })

// ==================== 复制技能目录 ====================
// 源目录：.aether/skills（新约定）优先，旧 SKILLs/ 回退
// 目标目录保持 bin/SKILLs（与 SDK 内嵌 processManager 的探测逻辑约定一致）

const skillsCandidates = [
  path.join(agentEngineRoot, '.aether', 'skills'),
  path.join(agentEngineRoot, 'SKILLs'),
]
const skillsSrc = skillsCandidates.find(p => fs.existsSync(p))
const skillsDst = path.join(binDir, 'SKILLs')
if (skillsSrc) {
  console.log(`[copy-bin] 复制 ${skillsSrc} → bin/SKILLs/`)
  copyDirRecursive(skillsSrc, skillsDst, [])
} else {
  console.warn(`[copy-bin] 警告：技能目录不存在（.aether/skills 与 SKILLs 均未找到），跳过`)
}

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
 * @param keepDeclarations 保留 .d.ts/.d.ts.map（typescript 等运行时需要声明文件的包用）
 */
function copyDirRecursive(src, dst, excludePatterns, keepDeclarations = false) {
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
    // （例外：keepDeclarations 的包，如 typescript 的 lib/*.d.ts）
    if (
      entry === '__tests__' ||
      entry === 'test' ||
      entry === 'tests' ||
      entry === '.cache' ||
      entry === '.git' ||
      entry.endsWith('.test.js') ||
      entry.endsWith('.spec.js') ||
      entry.endsWith('.map') ||
      (!keepDeclarations &&
        (entry.endsWith('.d.ts') || entry.endsWith('.d.ts.map')))
    ) {
      continue
    }

    const srcEntry = path.join(src, entry)
    const dstEntry = path.join(dst, entry)
    copyDirRecursive(srcEntry, dstEntry, excludePatterns, keepDeclarations)
  }
}

function checkPatch(packageDir) {
  const result = spawnSync(process.execPath, [path.join(agentEngineRoot, 'scripts/apply-node-pty-patch.mjs'), '--package-dir', packageDir, '--check'], { encoding: 'utf8', windowsHide: true })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`SDK node-pty patch verification failed: ${result.stderr || result.stdout}`)
}
