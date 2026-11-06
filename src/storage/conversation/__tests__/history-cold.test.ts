import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { archiveSealedHistoryBackup, listSealedHistoryBackups, restoreColdHistoryArchive,
  verifyColdHistoryArchive } from '../history-cold.js'

let directory: string, sessions: string, cold: string, backup: string, active: string
const relative = 'tenant/session.jsonl.1770000000000.bak'
const digest = (value: Buffer) => createHash('sha256').update(value).digest('hex')
beforeEach(async () => {
  directory = path.resolve('.e2e-tmp', 'history-cold-' + randomUUID())
  sessions = path.join(directory, 'sessions'); cold = path.join(directory, 'history-cold')
  backup = path.join(sessions, relative); active = path.join(sessions, 'tenant/session.jsonl')
  await fsp.mkdir(path.dirname(backup), { recursive: true })
  await fsp.writeFile(backup, Buffer.from('{"old":"备份原始字节"}\r\n{"second":true}\n'))
  await fsp.writeFile(active, '{"active":"exact physical bytes"}\n')
})
afterEach(async () => {
  vi.restoreAllMocks()
  if (path.dirname(directory) !== path.resolve('.e2e-tmp') || !path.basename(directory).startsWith('history-cold-')) throw new Error('Unsafe fixture cleanup')
  await fsp.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})
describe('sealed JSONL cold archives', () => {
  it('inventories both backup spellings with bounds and skips active files and directory links', async () => {
    await fsp.writeFile(path.join(sessions, 'tenant/older.jsonl.bak.2026'), 'older')
    await fsp.mkdir(path.join(directory, 'outside'))
    await fsp.writeFile(path.join(directory, 'outside/hidden.jsonl.bak'), 'never traverse')
    await fsp.symlink(path.join(directory, 'outside'), path.join(sessions, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
    expect(await listSealedHistoryBackups(sessions, 1)).toMatchObject({ files: [{ relativePath: 'tenant/older.jsonl.bak.2026' }], hasMore: true })
    const all = await listSealedHistoryBackups(sessions)
    expect(all.files.map(file => file.relativePath)).toEqual(['tenant/older.jsonl.bak.2026', relative]); expect(all.hasMore).toBe(false)
  })

  it('streams large bytes into a durable manifest without reading source or gzip as one buffer', async () => {
    const original = Buffer.from('{"大工具结果":"' + '保持完整原始物理字节'.repeat(100_000) + '"}\r\n')
    await fsp.writeFile(backup, original)
    const activeBefore = fs.readFileSync(active), activeInfo = await fsp.stat(active)
    const read = vi.spyOn(fsp, 'readFile')
    const receipt = await archiveSealedHistoryBackup(sessions, relative, cold)
    expect(receipt.removedSource).toBe(false)
    expect(receipt.manifest.source).toMatchObject({ relativePath: relative, bytes: original.length, sha256: digest(original) })
    expect(receipt.manifest.archive.bytes).toBeLessThan(original.length / 100)
    await verifyColdHistoryArchive(cold, receipt.manifestPath)
    const restored = path.join(directory, 'exact.restored')
    await restoreColdHistoryArchive(cold, receipt.manifestPath, restored)
    expect(read.mock.calls.every(call => String(call[0]).endsWith('.manifest.json'))).toBe(true)
    expect(Buffer.compare(fs.readFileSync(restored), original)).toBe(0); expect(Buffer.compare(fs.readFileSync(backup), original)).toBe(0)
    expect(fs.readFileSync(active)).toEqual(activeBefore)
    const activeAfter = await fsp.stat(active)
    expect({ ino: activeAfter.ino, size: activeAfter.size, mtime: activeAfter.mtimeMs }).toEqual({ ino: activeInfo.ino, size: activeInfo.size, mtime: activeInfo.mtimeMs })
  })

  it('reuses a complete archive and only removes the sealed source when explicitly requested', async () => {
    const original = fs.readFileSync(backup)
    const first = await archiveSealedHistoryBackup(sessions, relative, cold)
    const second = await archiveSealedHistoryBackup(sessions, relative, cold, { removeSource: true })
    expect(second.manifestPath).toBe(first.manifestPath); expect(second.manifest).toEqual(first.manifest)
    expect(second.removedSource).toBe(true); expect(fs.existsSync(backup)).toBe(false); expect(fs.existsSync(active)).toBe(true)
    await restoreColdHistoryArchive(cold, second.manifestPath, backup)
    expect(fs.readFileSync(backup)).toEqual(original)
  })

  it('preserves the source if an existing archive is corrupt and never publishes a corrupt restore', async () => {
    const receipt = await archiveSealedHistoryBackup(sessions, relative, cold)
    const archive = path.join(cold, receipt.manifest.archive.relativePath), packed = fs.readFileSync(archive)
    packed[packed.length - 1] ^= 0xff; await fsp.writeFile(archive, packed)
    await expect(archiveSealedHistoryBackup(sessions, relative, cold, { removeSource: true })).rejects.toThrow()
    expect(fs.existsSync(backup)).toBe(true)
    const output = path.join(directory, 'failed.restored')
    await expect(restoreColdHistoryArchive(cold, receipt.manifestPath, output)).rejects.toThrow()
    expect(fs.existsSync(output)).toBe(false)
    expect((await fsp.readdir(directory)).some(file => file.endsWith('.restore.tmp'))).toBe(false)
  })

  it('keeps changed source bytes if a sealed file changes between compression and removal', async () => {
    const link = fsp.link.bind(fsp)
    let injected = false
    vi.spyOn(fsp, 'link').mockImplementation(async (source, target) => {
      if (!injected && String(target).endsWith('.jsonl.gz')) { injected = true; await fsp.writeFile(backup, 'new sealed contents') }
      return link(source, target)
    })
    await expect(archiveSealedHistoryBackup(sessions, relative, cold, { removeSource: true })).rejects.toThrow('changed before removal')
    expect(fs.readFileSync(backup, 'utf8')).toBe('new sealed contents')
  })

  it('keeps the source on manifest publication failure and cleans unfinished temporary files', async () => {
    const original = fs.readFileSync(backup), link = fsp.link.bind(fsp)
    vi.spyOn(fsp, 'link').mockImplementation(async (source, target) => {
      if (String(target).endsWith('.manifest.json')) throw new Error('injected manifest write failure')
      return link(source, target)
    })
    await expect(archiveSealedHistoryBackup(sessions, relative, cold, { removeSource: true })).rejects.toThrow('injected manifest write failure')
    expect(fs.readFileSync(backup)).toEqual(original)
    const rootEntries = await fsp.readdir(cold)
    expect(rootEntries.some(entry => entry.endsWith('.tmp'))).toBe(false)
    for (const subdir of rootEntries) expect((await fsp.readdir(path.join(cold, subdir))).some(file => file.endsWith('.tmp'))).toBe(false)
  })

  it('rejects active source/restore paths, path traversal, existing targets, and tampered manifests', async () => {
    await expect(archiveSealedHistoryBackup(sessions, 'tenant/session.jsonl', cold)).rejects.toThrow('Only sealed')
    await expect(archiveSealedHistoryBackup(sessions, '../outside.jsonl.bak', cold)).rejects.toThrow('Invalid relative')
    const receipt = await archiveSealedHistoryBackup(sessions, relative, cold)
    await expect(restoreColdHistoryArchive(cold, receipt.manifestPath, active)).rejects.toThrow('not an active')
    await expect(restoreColdHistoryArchive(cold, receipt.manifestPath, backup)).rejects.toMatchObject({ code: 'EEXIST' })
    const tampered = { ...receipt.manifest, archive: { ...receipt.manifest.archive, relativePath: '../outside.gz' } }
    await fsp.writeFile(receipt.manifestPath, JSON.stringify(tampered))
    await expect(verifyColdHistoryArchive(cold, receipt.manifestPath)).rejects.toThrow('Invalid history cold manifest')
  })
})
