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

  it('成功后 staging 目录零残留', () => {
    const zip = makeZip({ 'a/SKILL.md': SKILL_MD('a') })
    run(zip)
    expect(fs.existsSync(path.join(tmpRoot, '.staging'))).toBe(false)
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

  it('frontmatter 缺 description → BAD_STRUCTURE', () => {
    const zip = makeZip({ 'a/SKILL.md': strToU8('---\nname: only-name\n---\n# x') })
    try {
      run(zip)
      expect.unreachable('should throw')
    } catch (e) {
      expect((e as SkillImportError).message).toContain('description')
    }
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
    const zip = makeZip({ 'a/SKILL.md': SKILL_MD('a'), 'b/SKILL.md': strToU8('no frontmatter') })
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
