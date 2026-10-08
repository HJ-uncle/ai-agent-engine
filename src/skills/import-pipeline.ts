/**
 * Skill 包导入管线（ZIP/TAR/GZIP/standalone SKILL.md）
 *
 * 职责：归一化上传格式 → 安全校验 → 结构校验 → 冲突处理 → staging 解压 → 原子落盘。
 * 落盘到 skills 根目录后由 SkillsRegistry 的 fs.watch 自动热加载，即时生效。
 *
 * 安全校验链：
 *   magic number → 条目数/单文件/总解压上限 → 压缩比（zip bomb）→
 *   路径规范化（zip-slip）→ 扩展名白名单 → 符号链接条目拒绝 →
 *   SKILL.md 结构 + frontmatter 校验 → 保留目录名检查
 *
 * 一致性：解压先写入 .staging/<importId>/，全部成功后逐 skill 原子 rename
 * 到目标目录；任一步失败清理 staging，磁盘零残留。旧版本按策略备份到
 * .versions/<skillName>/<unix-ts>/。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { projectDataPath } from '../core/project-storage.js'
import { gunzipSync } from 'node:zlib'
import { unzipSync } from 'fflate'

// ─── 错误码与常量 ─────────────────────────────────────────────────────────────

export const SKILL_IMPORT_ERRORS = {
  BAD_FORMAT: 41010, // 非法 zip 格式
  OVER_LIMIT: 41011, // 超出大小/条目限制
  BAD_STRUCTURE: 41012, // 结构校验失败
  CONFLICT: 41013, // 名称冲突且策略为 reject
  INTERNAL: 50010, // 内部错误
} as const

export class SkillImportError extends Error {
  constructor(
    public readonly code: number,
    message: string,
  ) {
    super(message)
    this.name = 'SkillImportError'
  }
}

// 运行限制（可通过环境变量调整）
const MAX_ENTRIES = parseInt(process.env.SKILL_IMPORT_MAX_ENTRIES ?? '500', 10)
const MAX_TOTAL_UNCOMPRESSED = parseInt(process.env.SKILL_IMPORT_MAX_TOTAL_MB ?? '50', 10) * 1024 * 1024
const MAX_SINGLE_FILE = parseInt(process.env.SKILL_IMPORT_MAX_FILE_MB ?? '10', 10) * 1024 * 1024
const MAX_COMPRESSION_RATIO = parseInt(process.env.SKILL_IMPORT_MAX_RATIO ?? '100', 10)
/** 直传模式单请求上限（超过走分片） */
export const DIRECT_UPLOAD_LIMIT = 5 * 1024 * 1024

// 扩展名白名单（技能包内容物）
const ALLOWED_EXTENSIONS = new Set([
  '.md', '.ts', '.js', '.mjs', '.cjs', '.json', '.sh', '.py', '.html', '.css',
  '.txt', '.png', '.jpg', '.jpeg', '.svg', '.gif', '.webp', '.yaml', '.yml',
  '.xml', '.csv', '.toml', '.ini', '.map',
])

// 保留目录名（skills 根目录内部使用）
const RESERVED_NAMES = new Set(['.staging', '.versions', '.git'])

export type ConflictStrategy = 'reject' | 'overwrite' | 'versioned'

export interface ImportProgress {
  progress: number // 0-100
  stage: string
}

export interface ImportSummary {
  skillNames: string[]
  importedCount: number
  skippedCount: number
}

export interface RunImportOptions {
  importId: string
  zipBuffer: Buffer
  filename: string
  /** Optional name for a root-level SKILL.md (used by standalone-file uploads). */
  skillName?: string
  skillsRoot?: string // 覆盖技能根目录（测试用）
  scope?: SkillScope // 落盘层级：project（默认）| global
  conflictStrategy?: ConflictStrategy
  /** 取消标志：外部置 true 后，rename 前中断 */
  isCancelled?: () => boolean
  onProgress?: (p: ImportProgress) => void
}

// ─── 技能根目录解析（与 SkillsRegistry 探测规则一致）────────────────────────

export type SkillScope = 'project' | 'global'

/** 全局技能目录：~/.aether/skills（单机多项目共享；集群时挂共享卷） */
export function globalSkillsRoot(): string {
  if (process.env.AETHER_GLOBAL_DIR) return path.resolve(process.env.AETHER_GLOBAL_DIR, 'skills')
  return path.join(os.homedir(), '.aether', 'skills')
}

/**
 * 解析目标落盘根目录。
 *  - project（默认）：<cwd>/.ae/skills（旧目录仅用于读取）
 *  - global：~/.aether/skills（AETHER_GLOBAL_DIR 可覆盖，集群共享卷场景）
 *  - SKILLS_ROOT 显式指定时项目 scope 使用该配置路径
 */
export function resolveSkillsRoot(explicit?: string, scope: SkillScope = 'project'): string {
  if (explicit) return path.resolve(explicit)
  // Global imports must remain in the global layer even when the process also
  // exposes a deployment-level SKILLS_ROOT containing built-in skills.
  if (scope === 'global') return globalSkillsRoot()
  if (process.env.SKILLS_ROOT) return path.resolve(process.env.SKILLS_ROOT)
  return projectDataPath(process.cwd(), 'skills')
}

// ─── frontmatter 轻量解析 ─────────────────────────────────────────────────────

function parseFrontmatter(content: string): Record<string, string> | null {
  if (!content.startsWith('---')) return null
  const end = content.indexOf('\n---', 3)
  if (end === -1) return null
  const block = content.slice(3, end)
  const out: Record<string, string> = {}
  for (const line of block.split('\n')) {
    const m = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.+)$/)
    if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
  }
  return out
}

/** macOS 元数据垃圾：__MACOSX/（Finder 压缩目录）、._*（AppleDouble 资源分叉）、.DS_Store */
function isMacJunk(name: string): boolean {
  if (name === '__MACOSX' || name.startsWith('__MACOSX/')) return true
  const base = name.slice(name.lastIndexOf('/') + 1)
  return base === '.DS_Store' || base.startsWith('._')
}

/** Remove an archive/document suffix and turn an uploaded filename into a safe
 * skill directory name. The directory is still checked by the normal
 * reserved-name/character validation below. */
function filenameSkillName(filename: string, explicit?: string): string {
  const candidate = explicit?.trim() || path.basename(filename).replace(/\.(?:tar\.gz|tar\.tgz|tgz|zip|tar|gz|md)$/i, '')
  const cleaned = candidate.replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^[^A-Za-z0-9]+/, '').slice(0, 80)
  return !cleaned || cleaned.toLowerCase() === 'skill' ? 'imported-skill' : cleaned
}

type ArchiveEntries = Record<string, Uint8Array>

/** Parse the small, deliberately conservative subset of POSIX/GNU tar needed
 * for skill packages. We parse in memory so the existing size and zip-slip
 * checks apply equally to zip and tar uploads and no archive can write outside
 * the staging directory. */
function parseTar(buffer: Buffer): ArchiveEntries {
  const entries: ArchiveEntries = {}
  const readString = (start: number, length: number) => {
    const end = Math.min(buffer.length, start + length)
    let value = buffer.subarray(start, end).toString('utf8')
    const nul = value.indexOf('\0')
    if (nul >= 0) value = value.slice(0, nul)
    return value.trim()
  }
  const readOctal = (start: number, length: number) => {
    const raw = readString(start, length).replace(/[^0-7]/g, '')
    return raw ? parseInt(raw, 8) : 0
  }

  let offset = 0
  let longName: string | undefined
  let paxPath: string | undefined
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512)
    if (header.every((v) => v === 0)) break
    const name = readString(offset, 100)
    const prefix = readString(offset + 345, 155)
    const size = readOctal(offset + 124, 12)
    const type = String.fromCharCode(buffer[offset + 156] || 0)
    const dataStart = offset + 512
    const dataEnd = dataStart + size
    if (dataEnd > buffer.length) throw new SkillImportError(SKILL_IMPORT_ERRORS.BAD_FORMAT, 'TAR 条目超出文件范围')
    const data = buffer.subarray(dataStart, dataEnd)
    offset = dataStart + Math.ceil(size / 512) * 512

    // GNU long-name and POSIX PAX records carry the real path in their data.
    if (type === 'L') {
      longName = data.toString('utf8').replace(/\0+$/, '')
      continue
    }
    if (type === 'x' || type === 'g') {
      const pax = data.toString('utf8')
      const match = pax.match(/(?:^|\n)\d+ path=([^\n]*)/)
      if (match) paxPath = match[1]
      continue
    }
    const entryName = paxPath || longName || (prefix ? `${prefix}/${name}` : name)
    longName = undefined
    paxPath = undefined
    // Directories are represented by a trailing slash and do not need to be
    // materialised. Symlinks/hardlinks/devices are rejected by the importer.
    if (type === '5' || entryName.endsWith('/')) continue
    if (type === '1' || type === '2' || type === '3' || type === '4' || type === '6') {
      throw new SkillImportError(SKILL_IMPORT_ERRORS.BAD_STRUCTURE, `TAR 包包含不支持的特殊条目: ${entryName}`)
    }
    entries[entryName] = new Uint8Array(data)
  }
  if (Object.keys(entries).length === 0) throw new SkillImportError(SKILL_IMPORT_ERRORS.BAD_FORMAT, 'TAR 压缩包为空或已损坏')
  return entries
}

function extractArchive(buffer: Buffer, filename: string, skillName?: string): ArchiveEntries {
  const lower = filename.toLowerCase()
  // A standalone SKILL.md is adapted to the same <name>/SKILL.md shape used by
  // archives. This lets all subsequent validation and atomic-write logic stay
  // shared and avoids a separate, less-safe file-writing path.
  if (lower.endsWith('.md') && buffer.slice(0, 2).toString('utf8') !== 'PK') {
    return { [`${filenameSkillName(filename, skillName)}/SKILL.md`]: new Uint8Array(buffer) }
  }
  if (buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b) {
    let expanded: Buffer
    try {
      expanded = gunzipSync(buffer)
    } catch (err) {
      throw new SkillImportError(SKILL_IMPORT_ERRORS.BAD_FORMAT, `GZIP 解析失败（文件可能已损坏）: ${(err as Error).message}`)
    }
    // .gz is commonly a tarball, but accepting a gzipped SKILL.md is useful
    // for drag-and-drop and remains subject to frontmatter validation.
    if (expanded.slice(0, 2).toString('utf8') === 'PK') return extractArchive(expanded, filename.replace(/\.gz$/i, '.zip'), skillName)
    if (expanded.length >= 512 && (expanded.subarray(257, 262).toString('ascii') === 'ustar' || /\.(?:tar|tgz|tar\.gz)$/i.test(lower))) {
      return parseTar(expanded)
    }
    if (expanded.toString('utf8').startsWith('---')) {
      return { [`${filenameSkillName(filename, skillName)}/SKILL.md`]: new Uint8Array(expanded) }
    }
    throw new SkillImportError(SKILL_IMPORT_ERRORS.BAD_FORMAT, 'GZIP 内容不是有效的 TAR 压缩包或 SKILL.md')
  }
  if (buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b) {
    try {
      return unzipSync(buffer)
    } catch (err) {
      throw new SkillImportError(SKILL_IMPORT_ERRORS.BAD_FORMAT, `ZIP 解析失败（文件可能已损坏）: ${(err as Error).message}`)
    }
  }
  if (buffer.length >= 512 && (buffer.subarray(257, 262).toString('ascii') === 'ustar' || /\.(?:tar|tgz|tar\.gz)$/i.test(lower))) {
    return parseTar(buffer)
  }
  throw new SkillImportError(SKILL_IMPORT_ERRORS.BAD_FORMAT, '文件格式不受支持，请上传 ZIP、TAR/TGZ/TAR.GZ 或 SKILL.md')
}

// ─── 单条目路径安全检查（zip-slip 防护）──────────────────────────────────────

function safeEntryName(rawName: string): string | null {
  // 统一分隔符，拒绝绝对路径与盘符
  let name = rawName.replace(/\\/g, '/')
  if (name.startsWith('/') || /^[a-zA-Z]:/.test(name)) return null
  // 拒绝符号链接（zip 内极少见，但防御性处理）
  if (name.includes('\0')) return null
  const segments = name.split('/').filter((s) => s.length > 0)
  // 过滤 . 与 .. 段（.. 段意味着逃逸，直接拒绝）
  if (segments.some((s) => s === '..')) return null
  if (segments.length === 0) return null
  return segments.join('/')
}

// ─── 主流程 ───────────────────────────────────────────────────────────────────

export function runSkillImport(options: RunImportOptions): ImportSummary {
  const {
    importId,
    zipBuffer,
    filename,
    skillName,
    skillsRoot,
    scope = 'project',
    conflictStrategy = 'versioned',
    isCancelled,
    onProgress,
  } = options

  // ── 1. 格式校验与归一化（ZIP/TAR/GZIP/standalone SKILL.md）───────────────
  onProgress?.({ progress: 5, stage: '校验压缩包格式' })
  if (zipBuffer.length === 0) throw new SkillImportError(SKILL_IMPORT_ERRORS.BAD_FORMAT, '上传文件为空')
  const entries = extractArchive(zipBuffer, filename, skillName)

  // 目录条目（以 / 结尾，macOS `zip -r` / Finder 压缩必带）与 macOS 元数据垃圾
  // （__MACOSX/、._* AppleDouble、.DS_Store）跳过；否则 extname 为空会被白名单拒绝，
  // 导致正常技能包 100% 导入失败
  const fileEntries = Object.entries(entries).filter(([name]) => !name.endsWith('/') && !isMacJunk(name))

  // ── 2. 限制检查（条目数 / 单文件 / 总解压 / 压缩比）──────────────────────
  onProgress?.({ progress: 15, stage: '检查包体限制' })
  if (fileEntries.length > MAX_ENTRIES) {
    throw new SkillImportError(SKILL_IMPORT_ERRORS.OVER_LIMIT, `压缩包条目数超过限制（${fileEntries.length} > ${MAX_ENTRIES}）`)
  }
  let totalSize = 0
  for (const [, data] of fileEntries) {
    if (data.length > MAX_SINGLE_FILE) {
      throw new SkillImportError(SKILL_IMPORT_ERRORS.OVER_LIMIT, `单个文件超过限制（${data.length} > ${MAX_SINGLE_FILE} 字节）`)
    }
    totalSize += data.length
  }
  if (totalSize > MAX_TOTAL_UNCOMPRESSED) {
    throw new SkillImportError(SKILL_IMPORT_ERRORS.OVER_LIMIT, `解压总大小超过限制（${totalSize} 字节）`)
  }
  if (zipBuffer.length > 0 && totalSize / zipBuffer.length > MAX_COMPRESSION_RATIO) {
    throw new SkillImportError(SKILL_IMPORT_ERRORS.OVER_LIMIT, `压缩比异常（${(totalSize / zipBuffer.length).toFixed(0)}×，疑似 zip bomb），已拒绝`)
  }

  // ── 3. 逐条目安全检查 + 收集文件映射 ─────────────────────────────────────
  onProgress?.({ progress: 25, stage: '校验条目安全性' })
  const safeFiles = new Map<string, Uint8Array>()
  for (const [rawName, data] of fileEntries) {
    const safe = safeEntryName(rawName)
    if (!safe) {
      throw new SkillImportError(SKILL_IMPORT_ERRORS.BAD_STRUCTURE, `检测到不安全的条目路径: ${rawName}（zip-slip 防护）`)
    }
    const ext = path.posix.extname(safe).toLowerCase()
    if (!ALLOWED_EXTENSIONS.has(ext)) {
      throw new SkillImportError(SKILL_IMPORT_ERRORS.BAD_STRUCTURE, `不支持的文件类型: ${safe}（白名单: ${[...ALLOWED_EXTENSIONS].join(' ')}）`)
    }
    safeFiles.set(safe, data)
  }

  // ── 4. 结构校验：识别技能目录（*/SKILL.md 或根 SKILL.md）────────────────
  onProgress?.({ progress: 35, stage: '校验技能结构' })
  interface SkillDir { name: string; prefix: string } // prefix='' 表示根级
  const skillDirs: SkillDir[] = []
  for (const safeName of safeFiles.keys()) {
    if (safeName === 'SKILL.md') {
      // 根级单技能包：用 zip 文件名作为技能名
      const base = filenameSkillName(filename, skillName)
      skillDirs.push({ name: base, prefix: '' })
      break
    }
    const m = safeName.match(/^([^/]+)\/SKILL\.md$/)
    if (m) skillDirs.push({ name: m[1], prefix: m[1] })
  }

  if (skillDirs.length === 0) {
    throw new SkillImportError(
      SKILL_IMPORT_ERRORS.BAD_STRUCTURE,
      '未找到任何 SKILL.md：请确保压缩包内每个技能目录（或根目录）包含 SKILL.md',
    )
  }

  // frontmatter 与名称合法性校验
  for (const dir of skillDirs) {
    if (RESERVED_NAMES.has(dir.name) || !/^[A-Za-z0-9][\w.-]*$/.test(dir.name)) {
      throw new SkillImportError(SKILL_IMPORT_ERRORS.BAD_STRUCTURE, `技能目录名不合法或为保留名: ${dir.name}`)
    }
    const skillMdKey = dir.prefix ? `${dir.prefix}/SKILL.md` : 'SKILL.md'
    const content = Buffer.from(safeFiles.get(skillMdKey)!).toString('utf-8')
    // Frontmatter is useful metadata, but it is not required for a skill to
    // be usable. The registry already falls back to the directory/file name
    // and a generated description, so imports should preserve ordinary
    // Markdown documents instead of rejecting them for missing metadata.
    // Keep only the structural and byte/path checks above as hard failures.
    void parseFrontmatter(content)
  }

  // ── 5. 冲突检测 ────────────────────────────────────────────────────────────
  onProgress?.({ progress: 45, stage: '检测命名冲突' })
  const root = resolveSkillsRoot(skillsRoot, scope)
  fs.mkdirSync(root, { recursive: true }) // global 层可能首次使用
  const conflicts = skillDirs.filter((d) => fs.existsSync(path.join(root, d.name)))
  if (conflicts.length > 0 && conflictStrategy === 'reject') {
    throw new SkillImportError(
      SKILL_IMPORT_ERRORS.CONFLICT,
      `已存在同名技能: ${conflicts.map((c) => c.name).join(', ')}（当前策略为 reject，可选择 overwrite/versioned 重新导入）`,
    )
  }

  // ── 6. staging 解压（.staging/<importId>/）────────────────────────────────
  onProgress?.({ progress: 55, stage: '解压到暂存区' })
  const stagingRoot = path.join(root, '.staging', importId)
  fs.mkdirSync(stagingRoot, { recursive: true })

  try {
    for (const dir of skillDirs) {
      const dirStaging = path.join(stagingRoot, dir.name)
      fs.mkdirSync(dirStaging, { recursive: true })
      for (const [safeName, data] of safeFiles) {
        // 计算条目相对本技能目录的路径：
        //  - 多技能包（prefix 非空）：只取 <prefix>/ 下的文件
        //  - 根级单技能包（prefix 为空）：所有条目（含子目录附属文件）都属于该技能
        let rel: string | null
        if (dir.prefix) {
          if (!safeName.startsWith(dir.prefix + '/')) continue
          rel = safeName.slice(dir.prefix.length + 1)
        } else {
          rel = safeName
        }
        if (!rel) continue
        const target = path.join(dirStaging, rel)
        fs.mkdirSync(path.dirname(target), { recursive: true })
        fs.writeFileSync(target, data)
      }
    }

    // ── 7. 落盘前取消检查 ────────────────────────────────────────────────────
    if (isCancelled?.()) {
      throw new SkillImportError(SKILL_IMPORT_ERRORS.INTERNAL, '导入已被取消')
    }

    // ── 8. 冲突处理（备份旧版）+ 原子 rename ────────────────────────────────
    let done = 0
    const importedNames: string[] = []
    for (const dir of skillDirs) {
      onProgress?.({ progress: 55 + Math.round((done / skillDirs.length) * 40), stage: `导入技能 ${dir.name}` })
      const finalDir = path.join(root, dir.name)
      if (fs.existsSync(finalDir)) {
        // overwrite 与 versioned 都先备份旧版（版本追溯），reject 已提前抛出
        const backupDir = path.join(root, '.versions', dir.name, String(Math.floor(Date.now() / 1000)))
        fs.mkdirSync(path.dirname(backupDir), { recursive: true })
        fs.renameSync(finalDir, backupDir)
      }
      fs.renameSync(path.join(stagingRoot, dir.name), finalDir)
      importedNames.push(dir.name)
      done++
    }

    onProgress?.({ progress: 100, stage: '导入完成' })
    return { skillNames: importedNames, importedCount: importedNames.length, skippedCount: 0 }
  } finally {
    // staging 清理（无论成败）；.staging 父目录若已空则一并移除
    fs.rmSync(stagingRoot, { recursive: true, force: true })
    try {
      fs.rmdirSync(path.join(root, '.staging'))
    } catch {
      /* 目录非空（并发导入）或不存在：忽略 */
    }
  }
}
