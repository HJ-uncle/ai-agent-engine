/**
 * tar-helper.js
 *
 * 纯 Node.js 实现的 .tgz 创建工具（不依赖系统 tar 命令）。
 * 使用 Node 内置 zlib + 手写 POSIX ustar tar header。
 *
 * 修复历史：
 *   v2 - 实现 ustar prefix 字段支持长路径（> 100 字节）。
 *        原实现直接 name.slice(0, 100) 导致文件名被截断
 *        （如 multipleOf.js → multipleOf.），现改为标准 ustar 分割。
 *        对于 name 段本身 > 100 字节的极端情况，使用 GNU LongLink @LongLink 扩展。
 */
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')

/**
 * 将目录打包为 .tgz 文件（异步流式版本）。
 *
 * @param {string} srcDir  要打包的源目录
 * @param {string} outFile 输出 .tgz 文件路径
 * @param {string} prefix  tar 内部路径前缀（如 'package'）
 */
function createTgz(srcDir, outFile, prefix = '') {
  const output = fs.createWriteStream(outFile)
  const gzip = zlib.createGzip({ level: 6 })
  gzip.pipe(output)

  // 收集所有文件（递归）
  const entries = []
  collectEntries(srcDir, srcDir, prefix, entries)

  let i = 0
  function writeNext() {
    if (i >= entries.length) {
      // 写入 tar 结束块（两个 512 字节零块）
      gzip.write(Buffer.alloc(1024))
      gzip.end()
      return
    }

    const entry = entries[i++]
    if (entry.type === 'directory') {
      const headers = createHeaderBlocks(entry.tarPath + '/', 0, '5', entry.mode || 0o755)
      for (const h of headers) gzip.write(h)
      writeNext()
    } else {
      const stat = fs.statSync(entry.fsPath)
      const headers = createHeaderBlocks(entry.tarPath, stat.size, '0', entry.mode || 0o644)
      for (const h of headers) gzip.write(h)

      const readStream = fs.createReadStream(entry.fsPath)
      let bytesWritten = 0

      readStream.on('data', (chunk) => {
        gzip.write(chunk)
        bytesWritten += chunk.length
      })

      readStream.on('end', () => {
        // 512 字节对齐填充
        const remainder = bytesWritten % 512
        if (remainder !== 0) {
          gzip.write(Buffer.alloc(512 - remainder))
        }
        writeNext()
      })

      readStream.on('error', (err) => {
        console.warn(`[tar-helper] 跳过文件（读取错误）: ${entry.fsPath}`, err.message)
        writeNext()
      })
    }
  }

  writeNext()

  return new Promise((resolve, reject) => {
    output.on('finish', resolve)
    output.on('error', reject)
    gzip.on('error', reject)
  })
}

function collectEntries(baseDir, currentDir, prefix, entries) {
  // 跳过的目录/文件名
  const SKIP = new Set(['.git', '__pycache__', '.DS_Store', 'Thumbs.db'])

  let items
  try {
    items = fs.readdirSync(currentDir)
  } catch {
    return
  }

  for (const name of items) {
    if (SKIP.has(name)) continue

    const fsPath = path.join(currentDir, name)
    const relPath = path.relative(baseDir, fsPath).replace(/\\/g, '/')
    const tarPath = prefix ? `${prefix}/${relPath}` : relPath

    let stat
    try {
      stat = fs.statSync(fsPath)
    } catch {
      continue
    }

    if (stat.isDirectory()) {
      entries.push({ type: 'directory', fsPath, tarPath, mode: stat.mode & 0o777 })
      collectEntries(baseDir, fsPath, prefix, entries)
    } else if (stat.isFile()) {
      entries.push({ type: 'file', fsPath, tarPath, mode: stat.mode & 0o777 })
    } else if (stat.isSymbolicLink()) {
      // 符号链接转为普通文件（Windows 兼容性）
      try {
        const linkTarget = fs.realpathSync(fsPath)
        if (fs.statSync(linkTarget).isFile()) {
          entries.push({ type: 'file', fsPath: linkTarget, tarPath, mode: 0o644 })
        }
      } catch {
        // 忽略无效符号链接
      }
    }
  }
}

// ==================== tar header 工具 ====================

/**
 * 将 tarPath 分割为 ustar 兼容的 prefix + name。
 *
 * POSIX ustar 格式：
 *   - name  字段：offset   0，长度 100 字节
 *   - prefix 字段：offset 345，长度 155 字节
 *   完整路径 = prefix + '/' + name（当 prefix 非空时）
 *
 * 分割规则：
 *   1. 路径 <= 100 字节 → name = path, prefix = ''
 *   2. 路径  > 100 字节 → 找最后一个满足 name <= 100 && prefix <= 155 的 '/' 分割点
 *   3. 无法分割（name 段本身 > 100 字节）→ 返回 null，调用方改用 GNU LongLink
 *
 * @param {string} tarPath 完整 tar 内部路径（用 / 分隔）
 * @returns {{ prefix: string, name: string } | null}
 */
function splitUstarPath(tarPath) {
  if (Buffer.byteLength(tarPath, 'utf8') <= 100) {
    return { prefix: '', name: tarPath }
  }

  // 尝试从最后一个 '/' 向前找合法分割点
  let splitIdx = -1
  for (let i = tarPath.length - 1; i >= 0; i--) {
    if (tarPath[i] === '/') {
      const name = tarPath.slice(i + 1)
      const prefix = tarPath.slice(0, i)
      if (
        Buffer.byteLength(name, 'utf8') <= 100 &&
        Buffer.byteLength(prefix, 'utf8') <= 155
      ) {
        splitIdx = i
        break
      }
    }
  }

  if (splitIdx === -1) {
    // 无法通过 prefix/name 分割，需要 GNU LongLink
    return null
  }

  return {
    prefix: tarPath.slice(0, splitIdx),
    name: tarPath.slice(splitIdx + 1)
  }
}

/**
 * 创建 GNU LongLink 扩展 entry（@LongLink）。
 * 当路径超过 ustar 所能表示的范围时（极罕见），先写一个 LongLink entry 告知后续文件名。
 *
 * @param {string} longPath 完整长路径
 * @returns {Buffer[]} 需要写入的 buffer 数组（header + 路径数据 + 对齐填充）
 */
function createLongLinkBlocks(longPath) {
  const pathBuf = Buffer.from(longPath + '\0', 'utf8')
  const size = pathBuf.length

  // LongLink header：name = '././@LongLink', typeflag = 'L'
  const header = createRawHeader('././@LongLink', '', size, 'L', 0o644)

  const blocks = [header, pathBuf]
  const remainder = size % 512
  if (remainder !== 0) {
    blocks.push(Buffer.alloc(512 - remainder))
  }
  return blocks
}

/**
 * 创建 512 字节 POSIX ustar tar header（原始，不处理长路径）。
 *
 * @param {string} name     文件名（已确保 <= 100 字节）
 * @param {string} prefix   路径前缀（已确保 <= 155 字节）
 * @param {number} size     文件大小（字节）
 * @param {string} typeFlag '0'=普通文件，'5'=目录，'L'=GNU LongLink
 * @param {number} mode     文件权限（八进制）
 * @returns {Buffer}
 */
function createRawHeader(name, prefix, size, typeFlag, mode) {
  const buf = Buffer.alloc(512)

  // name（最多 100 字节）
  buf.write(name.slice(0, 100), 0, 'utf8')

  // mode（8 字节，八进制，末尾空格+null）
  buf.write(mode.toString(8).padStart(7, '0') + ' ', 100, 'ascii')

  // uid / gid（各 8 字节）
  buf.write('0000000 ', 108, 'ascii')
  buf.write('0000000 ', 116, 'ascii')

  // size（12 字节，八进制）
  buf.write(size.toString(8).padStart(11, '0') + ' ', 124, 'ascii')

  // mtime（12 字节，当前时间戳）
  const mtime = Math.floor(Date.now() / 1000)
  buf.write(mtime.toString(8).padStart(11, '0') + ' ', 136, 'ascii')

  // checksum 占位（8 个空格）
  buf.write('        ', 148, 'ascii')

  // typeflag
  buf.write(typeFlag, 156, 'ascii')

  // magic + version（ustar 标准）
  buf.write('ustar\0', 257, 'ascii')   // magic（6 字节，含 \0）
  buf.write('00', 263, 'ascii')         // version（2 字节）

  // prefix（offset 345，最多 155 字节）
  if (prefix) {
    buf.write(prefix.slice(0, 155), 345, 'utf8')
  }

  // 计算 checksum（对 8 个空格占位计算后替换）
  let checksum = 0
  for (let i = 0; i < 512; i++) checksum += buf[i]
  buf.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii')

  return buf
}

/**
 * 创建 tar entry 所需的所有 header block。
 *
 * 自动处理长路径：
 *   - 路径 <= 100 字节：直接用标准 header
 *   - 路径 > 100 字节且可 prefix 分割：ustar prefix/name 分割
 *   - 路径无法分割（name 段 > 100）：GNU LongLink + 普通 header
 *
 * @param {string} tarPath  完整 tar 内部路径
 * @param {number} size     文件大小
 * @param {string} typeFlag 类型标志
 * @param {number} mode     权限
 * @returns {Buffer[]}
 */
function createHeaderBlocks(tarPath, size, typeFlag, mode) {
  const split = splitUstarPath(tarPath)

  if (split !== null) {
    // 正常路径 或 ustar prefix 分割
    return [createRawHeader(split.name, split.prefix, size, typeFlag, mode)]
  }

  // GNU LongLink 扩展：先写 @LongLink entry，再写截断的普通 header
  // （截断是无奈之举，但 @LongLink 让解压工具能读到真实路径）
  const longLinkBlocks = createLongLinkBlocks(tarPath)
  // @LongLink 后的实际 entry：name 字段截断，但解压工具会用前面的 @LongLink 路径
  const fallbackName = tarPath.slice(tarPath.length - 99)  // 取末尾 99 字节（保留些可读性）
  const entryHeader = createRawHeader(fallbackName, '', size, typeFlag, mode)
  return [...longLinkBlocks, entryHeader]
}

/**
 * 兼容旧调用的 createHeader（单个 header，不支持长路径）。
 * @deprecated 请改用 createHeaderBlocks
 */
function createHeader(name, size, typeFlag, mode) {
  return createHeaderBlocks(name, size, typeFlag, mode)[0]
}

// ==================== 同步打包 ====================

/**
 * 将目录同步打包为 .tgz 文件。
 *
 * @param {string}   srcDir      要打包的源目录
 * @param {string}   outFile     输出 .tgz 文件路径
 * @param {string}   prefix      tar 内部路径前缀（如 'package'）
 * @param {Function} [onProgress] 进度回调 ({ done, total, percent, filePath })
 */
function createTgzSync(srcDir, outFile, prefix = '', onProgress = null) {
  // 收集所有文件
  const entries = []
  collectEntries(srcDir, srcDir, prefix, entries)

  const total = entries.filter(e => e.type === 'file').length
  let done = 0
  const chunks = []

  for (const entry of entries) {
    if (entry.type === 'directory') {
      const headers = createHeaderBlocks(entry.tarPath + '/', 0, '5', entry.mode || 0o755)
      for (const h of headers) chunks.push(h)
    } else {
      let fileData
      try {
        fileData = fs.readFileSync(entry.fsPath)
      } catch {
        continue
      }
      const headers = createHeaderBlocks(entry.tarPath, fileData.length, '0', entry.mode || 0o644)
      for (const h of headers) chunks.push(h)
      chunks.push(fileData)
      // 对齐填充
      const remainder = fileData.length % 512
      if (remainder !== 0) {
        chunks.push(Buffer.alloc(512 - remainder))
      }

      done++
      if (onProgress) {
        onProgress({ done, total, percent: Math.floor(done / total * 100), filePath: entry.fsPath })
      }
    }
  }

  // 结束块
  chunks.push(Buffer.alloc(1024))

  const tarBuffer = Buffer.concat(chunks)
  if (onProgress) onProgress({ done, total, percent: 100, stage: 'compressing' })
  const compressed = zlib.gzipSync(tarBuffer, { level: 6 })
  fs.writeFileSync(outFile, compressed)
}

module.exports = { createTgz, createTgzSync, collectEntries, createHeaderBlocks, createHeader }
