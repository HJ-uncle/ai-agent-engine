import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const assets = path.join(path.dirname(fileURLToPath(import.meta.url)), 'patches/node-pty-1.1.0')
export const receiptName = '.aether-node-pty-patch.json'
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const fail = message => { throw new Error(`NODE_PTY_PATCH_GUARD: ${message}`) }

function safePath(filename, kind = 'file') {
  const absolute = path.resolve(filename)
  let cursor = path.parse(absolute).root
  for (const part of absolute.slice(cursor.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part)
    const stat = fs.lstatSync(cursor)
    if (stat.isSymbolicLink()) fail(`linked path is not permitted: ${cursor}`)
  }
  const stat = fs.statSync(absolute)
  if (kind === 'file' ? !stat.isFile() : !stat.isDirectory()) fail(`expected ${kind}: ${absolute}`)
  if (path.normalize(fs.realpathSync.native(absolute)).toLowerCase() !== absolute.toLowerCase()) fail(`real path differs: ${absolute}`)
  return absolute
}

function atomicWrite(filename, bytes) {
  const temporary = `${filename}.${randomUUID()}.tmp`
  try {
    fs.writeFileSync(temporary, bytes, { flag: 'wx' })
    fs.renameSync(temporary, filename)
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary)
  }
}

export function applyNodePtyPatch({ packageDir, lockfile, check = false }) {
  const manifestBytes = fs.readFileSync(safePath(path.join(assets, 'manifest.json')))
  const manifest = JSON.parse(manifestBytes)
  if (manifest.schemaVersion !== 1 || manifest.package !== 'node-pty' || manifest.version !== '1.1.0') fail('invalid patch manifest')
  const target = safePath(packageDir, 'directory')
  const packagePath = safePath(path.join(target, 'package.json'))
  const packageBytes = fs.readFileSync(packagePath)
  const metadata = JSON.parse(packageBytes)
  if (metadata.name !== manifest.package || metadata.version !== manifest.version || digest(packageBytes) !== manifest.packageSha256) {
    fail(`unsupported package metadata at ${target}`)
  }
  if (lockfile) {
    const lock = JSON.parse(fs.readFileSync(safePath(lockfile), 'utf8'))
    const entry = lock.packages?.['node_modules/node-pty'] ?? lock.dependencies?.['node-pty']
    if (entry?.version !== manifest.version) fail('lockfile node-pty version does not match the guarded patch')
  }
  // Preflight every asset and every installed target before any writes.
  const states = manifest.files.map(entry => {
    if (!entry.path || path.isAbsolute(entry.path) || entry.path.split(/[\\/]/).includes('..')) fail('invalid manifest target path')
    if (!entry.asset || path.basename(entry.asset) !== entry.asset) fail('invalid manifest asset path')
    const source = fs.readFileSync(safePath(path.join(assets, entry.asset)))
    if (digest(source) !== entry.afterSha256) fail(`patch asset hash mismatch: ${entry.asset}`)
    const filename = safePath(path.join(target, entry.path))
    const current = digest(fs.readFileSync(filename))
    if (current !== entry.beforeSha256 && current !== entry.afterSha256) fail(`unknown installed hash: ${entry.path}`)
    return { entry, filename, source, current, patched: current === entry.afterSha256 }
  })
  const receipt = {
    schemaVersion: 1, patchId: manifest.patchId, package: manifest.package, version: manifest.version,
    manifestSha256: digest(manifestBytes), packageSha256: manifest.packageSha256,
    files: manifest.files.map(({ path: filename, beforeSha256, afterSha256 }) => ({ path: filename, beforeSha256, afterSha256 })),
  }
  const receiptPath = path.join(target, receiptName)
  if (fs.existsSync(receiptPath)) {
    safePath(receiptPath)
    let previous
    try { previous = JSON.parse(fs.readFileSync(receiptPath, 'utf8')) } catch { fail('invalid existing patch receipt') }
    if (JSON.stringify(previous) !== JSON.stringify(receipt)) fail('existing patch receipt differs from expected patch')
  }
  if (check) {
    if (states.some(state => !state.patched)) fail('patch is not applied to every required file')
    if (!fs.existsSync(receiptPath)) fail('required patch receipt is missing')
  } else {
    // A known original/patched mixture can resume after an interrupted write.
    for (const state of states) if (!state.patched) atomicWrite(state.filename, state.source)
    for (const state of states) if (digest(fs.readFileSync(state.filename)) !== state.entry.afterSha256) fail(`post-write verification failed: ${state.entry.path}`)
    if (!fs.existsSync(receiptPath)) atomicWrite(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`)
  }
  return { ...receipt, packageDir: target, checked: check, changed: check ? false : states.some(state => !state.patched) }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2)
    let check = false
    let packageDir
    let lockfile
    let root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
    let explicitPackage = false
    for (let index = 0; index < args.length; index++) {
      const arg = args[index]
      if (arg === '--check') check = true
      else if (['--package-dir', '--root', '--lockfile'].includes(arg)) {
        const value = args[++index]
        if (!value || value.startsWith('--')) fail(`missing value for ${arg}`)
        if (arg === '--package-dir') { packageDir = path.resolve(value); explicitPackage = true }
        if (arg === '--root') root = path.resolve(value)
        if (arg === '--lockfile') lockfile = path.resolve(value)
      } else fail(`unknown option ${arg}`)
    }
    if (!explicitPackage) { packageDir = path.join(root, 'node_modules/node-pty'); lockfile ??= path.join(root, 'package-lock.json') }
    console.log(JSON.stringify(applyNodePtyPatch({ packageDir, lockfile, check })))
  } catch (error) { console.error(error.stack || error); process.exitCode = 1 }
}
