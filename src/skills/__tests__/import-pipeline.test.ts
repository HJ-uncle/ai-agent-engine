/**
 * Skill 导入管线单元测试
 *
 * 覆盖：正常导入（多技能/根级单技能）、zip-slip、zip bomb、损坏包、
 * frontmatter 缺失、不安全条目、白名单外类型、冲突三策略、取消、
 * staging 清理与版本备份。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { gzipSync } from 'node:zlib'
import { zipSync, strToU8 } from 'fflate'
import {
  runSkillImport,
  SkillImportError,
  SKILL_IMPORT_ERRORS,
} from '../import-pipeline.js'

let tmpRoot: string

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-import-test-'))
})

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true })
})

const SKILL_MD = (name: string, desc = 'Test skill') =>
  strToU8(`---\nname: ${name}\ndescription: ${desc}\n---\n\n# ${name}\n`)

function makeZip(entries: Record<string, Uint8Array>): Buffer {
  return Buffer.from(zipSync(entries))
}

function makeTar(entries: Record<string, Uint8Array>): Buffer {
  const blocks: Buffer[] = []
  for (const [name, value] of Object.entries(entries)) {
    const header = Buffer.alloc(512)
    header.write(name, 0, 100, 'utf8')
    header.write('0000644\0', 100, 8, 'ascii')
    header.write('0000000\0', 108, 8, 'ascii')
    header.write('0000000\0', 116, 8, 'ascii')
    header.write(`${value.length.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii')
    header.write('00000000000\0', 136, 12, 'ascii')
    header[156] = 0
    header.write('ustar\0', 257, 6, 'ascii')
    header.write('00', 263, 2, 'ascii')
    header.write('test', 265, 4, 'ascii')
    header.write('test', 297, 4, 'ascii')
    // checksum field is spaces while calculating, then octal value + NUL/space
    header.fill(0x20, 148, 156)
    const checksum = header.reduce((sum, byte) => sum + byte, 0)
    header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii')
    const body = Buffer.from(value)
    blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512))
  }
  blocks.push(Buffer.alloc(1024))
  return Buffer.concat(blocks)
}

function run(buffer: Buffer, opts: Partial<Parameters<typeof runSkillImport>[0]> = {}) {
  return runSkillImport({
    importId: 'test-import',
    zipBuffer: buffer,
    filename: 'test.zip',
    skillsRoot: tmpRoot,
    ...opts,
  })
}

// ─── 正常路径 ─────────────────────────────────────────────────────────────────

describe('runSkillImport — scope 层级', () => {
  it("scope='global' 时落盘到显式 skillsRoot（调用方解析好的全局层）", () => {
    const globalRoot = path.join(tmpRoot, 'global')
    const zip = makeZip({ 'shared/SKILL.md': SKILL_MD('shared') })
    const summary = run(zip, { skillsRoot: globalRoot, scope: 'global' })
    expect(summary.importedCount).toBe(1)
    expect(fs.existsSync(path.join(globalRoot, 'shared', 'SKILL.md'))).toBe(true)
  })

  it('resolveSkillsRoot(scope=global) 返回全局层目录（AETHER_GLOBAL_DIR 优先）', async () => {
    const { resolveSkillsRoot, globalSkillsRoot } = await import('../import-pipeline.js')
    const g = path.join(tmpRoot, 'cluster-shared')
    process.env.AETHER_GLOBAL_DIR = g
    try {
      expect(globalSkillsRoot()).toBe(path.join(g, 'skills'))
      expect(resolveSkillsRoot(undefined, 'global')).toBe(path.join(g, 'skills'))
    } finally {
      delete process.env.AETHER_GLOBAL_DIR
    }
  })
})

describe('runSkillImport — 正常导入', () => {
  it('多技能包：解压到独立目录并原子落盘', () => {
    const zip = makeZip({
      'os-tdd/SKILL.md': SKILL_MD('os-tdd'),
      'os-tdd/scripts/run.sh': strToU8('echo ok'),
      'os-review/SKILL.md': SKILL_MD('os-review'),
    })
    const progress: number[] = []
    const summary = run(zip, { onProgress: (p) => progress.push(p.progress) })

    expect(summary.importedCount).toBe(2)
    expect(summary.skillNames).toEqual(['os-tdd', 'os-review'])
    expect(fs.existsSync(path.join(tmpRoot, 'os-tdd', 'SKILL.md'))).toBe(true)
    expect(fs.existsSync(path.join(tmpRoot, 'os-tdd', 'scripts', 'run.sh'))).toBe(true)
    expect(progress.at(-1)).toBe(100)
  })

  it('根级单技能包：用 zip 文件名作为技能目录名', () => {
    const zip = makeZip({
      'SKILL.md': SKILL_MD('root-skill'),
      'assets/logo.png': new Uint8Array([0x89, 0x50]),
    })
    const summary = run(zip, { filename: 'my-pack.zip' })
    expect(summary.importedCount).toBe(1)
    expect(fs.existsSync(path.join(tmpRoot, 'my-pack', 'SKILL.md'))).toBe(true)
    expect(fs.existsSync(path.join(tmpRoot, 'my-pack', 'assets', 'logo.png'))).toBe(true)
  })

  it('单个 SKILL.md：按上传文件名适配为技能目录', () => {
    const content = Buffer.from(`---\nname: standalone\ndescription: Standalone\n---\n\n# standalone\n`)
    const summary = run(content, { filename: 'standalone.md' })
    expect(summary.skillNames).toEqual(['standalone'])
    expect(fs.readFileSync(path.join(tmpRoot, 'standalone', 'SKILL.md'), 'utf8')).toContain('name: standalone')
  })

  it('TAR 与 GZIP TAR：导入与 ZIP 使用同一安全管线', () => {
    const tar = makeTar({ 'tar-skill/SKILL.md': SKILL_MD('tar-skill'), 'tar-skill/readme.txt': strToU8('ok') })
    const tarSummary = run(tar, { filename: 'tar-skill.tar' })
    expect(tarSummary.skillNames).toEqual(['tar-skill'])
    const gzSummary = run(gzipSync(tar), { filename: 'tar-skill.tgz', importId: 'gzip-import' })
    expect(gzSummary.skillNames).toEqual(['tar-skill'])
  })

  it('成功后 staging 目录零残留', () => {
    const zip = makeZip({ 'a/SKILL.md': SKILL_MD('a') })
    run(zip)
    expect(fs.existsSync(path.join(tmpRoot, '.staging'))).toBe(false)
  })

  it('含目录条目的 zip（macOS zip -r / Finder 压缩）正常导入', () => {
    // 真实系统 zip 会为每个目录生成以 / 结尾的空条目
    const zip = makeZip({
      'global-chain-test/': new Uint8Array(0),
      'global-chain-test/SKILL.md': SKILL_MD('global-chain-test'),
      'global-chain-test/assets/': new Uint8Array(0),
      'global-chain-test/assets/note.txt': strToU8('附属文件'),
    })
    const summary = run(zip)
    expect(summary.importedCount).toBe(1)
    expect(summary.skillNames).toEqual(['global-chain-test'])
    expect(fs.existsSync(path.join(tmpRoot, 'global-chain-test', 'SKILL.md'))).toBe(true)
    expect(fs.existsSync(path.join(tmpRoot, 'global-chain-test', 'assets', 'note.txt'))).toBe(true)
  })

  it('含 __MACOSX / .DS_Store / ._ AppleDouble 垃圾的 zip（Finder 压缩）正常导入且垃圾零落盘', () => {
    const zip = makeZip({
      '__MACOSX/': new Uint8Array(0),
      '__MACOSX/._novel-writer': strToU8('binary appleDouble junk'),
      '__MACOSX/novel-writer/': new Uint8Array(0),
      '.DS_Store': strToU8('junk'),
      'novel-writer/.DS_Store': strToU8('junk'),
      'novel-writer/._SKILL.md': strToU8('binary appleDouble junk'),
      'novel-writer/SKILL.md': SKILL_MD('novel-writer'),
    })
    const summary = run(zip, { filename: 'novel-writer.zip' })
    expect(summary.importedCount).toBe(1)
    expect(summary.skillNames).toEqual(['novel-writer'])
    expect(fs.existsSync(path.join(tmpRoot, 'novel-writer', 'SKILL.md'))).toBe(true)
    // 垃圾条目不得落盘
    expect(fs.existsSync(path.join(tmpRoot, '__MACOSX'))).toBe(false)
    expect(fs.existsSync(path.join(tmpRoot, '.DS_Store'))).toBe(false)
    expect(fs.existsSync(path.join(tmpRoot, 'novel-writer', '.DS_Store'))).toBe(false)
    expect(fs.existsSync(path.join(tmpRoot, 'novel-writer', '._SKILL.md'))).toBe(false)
  })
})

// ─── 格式与安全 ───────────────────────────────────────────────────────────────

describe('runSkillImport — 格式与安全防护', () => {
  it('非 zip 内容 → BAD_FORMAT', () => {
    expect(() => run(Buffer.from('this is not a zip at all!!!'))).toThrowError(SkillImportError)
    try {
      run(Buffer.from('plain text file content'))
    } catch (e) {
      expect((e as SkillImportError).code).toBe(SKILL_IMPORT_ERRORS.BAD_FORMAT)
    }
  })

  it('zip-slip 路径穿越条目 → BAD_STRUCTURE', () => {
    const zip = makeZip({ '../evil/SKILL.md': SKILL_MD('evil') })
    try {
      run(zip)
      expect.unreachable('should throw')
    } catch (e) {
      expect((e as SkillImportError).code).toBe(SKILL_IMPORT_ERRORS.BAD_STRUCTURE)
    }
  })

  it('绝对路径条目 → BAD_STRUCTURE', () => {
    const zip = makeZip({ '/etc/passwd.md': strToU8('# x') })
    try {
      run(zip)
      expect.unreachable('should throw')
    } catch (e) {
      expect((e as SkillImportError).code).toBe(SKILL_IMPORT_ERRORS.BAD_STRUCTURE)
    }
  })

  it('白名单外扩展名 → BAD_STRUCTURE', () => {
    const zip = makeZip({ 'a/SKILL.md': SKILL_MD('a'), 'a/payload.exe': strToU8('MZ') })
    try {
      run(zip)
      expect.unreachable('should throw')
    } catch (e) {
      expect((e as SkillImportError).code).toBe(SKILL_IMPORT_ERRORS.BAD_STRUCTURE)
    }
  })

  it('高压缩比（疑似 zip bomb）→ OVER_LIMIT', () => {
    // 重复字节压缩比极高
    const big = strToU8('# pad\n'.repeat(400000)) // ~2.4MB 解压
    const zip = makeZip({ 'a/SKILL.md': SKILL_MD('a'), 'a/pad.md': big })
    try {
      run(zip)
      expect.unreachable('should throw')
    } catch (e) {
      expect((e as SkillImportError).code).toBe(SKILL_IMPORT_ERRORS.OVER_LIMIT)
    }
  })

  it('缺少 SKILL.md → BAD_STRUCTURE', () => {
    const zip = makeZip({ 'a/README.md': strToU8('# no skill md') })
    try {
      run(zip)
      expect.unreachable('should throw')
    } catch (e) {
      expect((e as SkillImportError).code).toBe(SKILL_IMPORT_ERRORS.BAD_STRUCTURE)
      expect((e as SkillImportError).message).toContain('SKILL.md')
    }
  })

  it('frontmatter 缺字段仍可导入，并由注册表回退元数据', () => {
    const zip = makeZip({ 'a/SKILL.md': strToU8('---\nname: only-name\n---\n# x') })
    expect(run(zip).skillNames).toEqual(['a'])
  })

  it('保留目录名 → BAD_STRUCTURE', () => {
    const zip = makeZip({ '.staging/SKILL.md': SKILL_MD('x') })
    try {
      run(zip)
      expect.unreachable('should throw')
    } catch (e) {
      expect((e as SkillImportError).code).toBe(SKILL_IMPORT_ERRORS.BAD_STRUCTURE)
    }
  })

  it('失败后 staging 零残留（磁盘一致性）', () => {
    const zip = makeZip({ 'a/SKILL.md': SKILL_MD('a'), 'b/payload.exe': strToU8('MZ') })
    try {
      run(zip)
      expect.unreachable('should throw')
    } catch {
      expect(fs.existsSync(path.join(tmpRoot, '.staging'))).toBe(false)
      expect(fs.existsSync(path.join(tmpRoot, 'a'))).toBe(false)
    }
  })
})

// ─── 冲突策略 ─────────────────────────────────────────────────────────────────

describe('runSkillImport — 冲突策略', () => {
  const goodZip = () => makeZip({ 'a/SKILL.md': SKILL_MD('a', 'v2') })

  beforeEach(() => {
    fs.mkdirSync(path.join(tmpRoot, 'a'))
    fs.writeFileSync(path.join(tmpRoot, 'a', 'SKILL.md'), '---\nname: a\ndescription: v1\n---\n')
  })

  it('reject：冲突时抛 CONFLICT 且旧版不动', () => {
    try {
      run(goodZip(), { conflictStrategy: 'reject' })
      expect.unreachable('should throw')
    } catch (e) {
      expect((e as SkillImportError).code).toBe(SKILL_IMPORT_ERRORS.CONFLICT)
    }
    expect(fs.readFileSync(path.join(tmpRoot, 'a', 'SKILL.md'), 'utf-8')).toContain('v1')
  })

  it('versioned：旧版备份到 .versions 后替换新版', () => {
    const summary = run(goodZip(), { conflictStrategy: 'versioned' })
    expect(summary.importedCount).toBe(1)
    expect(fs.readFileSync(path.join(tmpRoot, 'a', 'SKILL.md'), 'utf-8')).toContain('v2')
    const versionsDir = path.join(tmpRoot, '.versions', 'a')
    expect(fs.existsSync(versionsDir)).toBe(true)
    const backup = fs.readdirSync(versionsDir)[0]
    expect(fs.readFileSync(path.join(versionsDir, backup, 'SKILL.md'), 'utf-8')).toContain('v1')
  })

  it('overwrite：同样替换为新版（带备份）', () => {
    run(goodZip(), { conflictStrategy: 'overwrite' })
    expect(fs.readFileSync(path.join(tmpRoot, 'a', 'SKILL.md'), 'utf-8')).toContain('v2')
  })
})

// ─── 取消 ─────────────────────────────────────────────────────────────────────

describe('runSkillImport — 取消', () => {
  it('rename 前取消 → 失败且零残留', () => {
    const zip = makeZip({ 'a/SKILL.md': SKILL_MD('a') })
    try {
      run(zip, { isCancelled: () => true })
      expect.unreachable('should throw')
    } catch (e) {
      expect((e as Error).message).toContain('取消')
    }
    expect(fs.existsSync(path.join(tmpRoot, 'a'))).toBe(false)
    expect(fs.existsSync(path.join(tmpRoot, '.staging'))).toBe(false)
  })
})
