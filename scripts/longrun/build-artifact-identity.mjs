import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { applyNodePtyPatch, receiptName } from '../apply-node-pty-patch.mjs'

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const excludedDirectories = new Set(['test','tests','__tests__','fixtures','__fixtures__','__mocks__'])

function captureFile(engineRoot, relativePath, metadata) {
  const file = path.join(engineRoot, relativePath)
  const stat = fs.lstatSync(file)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`build-artifact-not-regular-file:${relativePath}`)
  const contents = fs.readFileSync(file)
  return { path: relativePath.replaceAll('\\', '/'), sha256: sha256(contents), bytes: contents.length, modifiedAt: stat.mtime.toISOString(), ...(metadata?.(contents)??{}) }
}

function captureNodePty(engineRoot, required, requirePatch) {
  const directory = 'node_modules/node-pty', resolved = path.join(engineRoot, directory)
  if (!fs.existsSync(resolved)) {
    if (required || requirePatch) throw new Error('build-artifact-node-pty-required-but-absent')
    return { directory, present: false, fileCount: 0, files: [], sha256: null, patchReceipt: { present: false, valid: false } }
  }
  const files = []
  const walk = relative => {
    const absolute = path.join(engineRoot, relative), stat = fs.lstatSync(absolute)
    if (stat.isSymbolicLink()) throw new Error(`build-artifact-node-pty-symlink:${relative}`)
    if (!stat.isDirectory()) throw new Error(`build-artifact-node-pty-not-directory:${relative}`)
    for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!excludedDirectories.has(entry.name.toLowerCase())) walk(path.join(relative, entry.name))
      } else if (entry.isSymbolicLink()) throw new Error(`build-artifact-node-pty-symlink:${path.join(relative, entry.name)}`)
      else if (/\.(?:js|mjs|cjs|node|dll)$/i.test(entry.name) && !/\.(?:test|spec)\.(?:js|mjs|cjs)$/i.test(entry.name)) files.push(captureFile(engineRoot, path.join(relative, entry.name)))
    }
  }
  walk(directory)
  files.push(captureFile(engineRoot, path.join(directory, 'package.json')))
  let patchReceipt = { present: false, valid: false }
  const receiptPath = path.join(resolved, receiptName)
  if (fs.existsSync(receiptPath)) {
    const checked = applyNodePtyPatch({ packageDir: resolved, check: true })
    const receipt = captureFile(engineRoot, path.join(directory, receiptName), bytes => ({ patchId: JSON.parse(bytes.toString('utf8')).patchId }))
    files.push(receipt)
    patchReceipt = { present: true, valid: checked.checked === true && checked.changed === false, patchId: checked.patchId, manifestSha256: checked.manifestSha256, file: receipt, verifiedFiles: checked.files.map(file=>({path:file.path,sha256:file.afterSha256})) }
  } else if (requirePatch) throw new Error('build-artifact-node-pty-patch-receipt-required-but-absent')
  files.sort((a,b)=>a.path.localeCompare(b.path))
  if (!files.some(file=>/\.(?:js|mjs|cjs)$/i.test(file.path))) throw new Error('build-artifact-node-pty-production-js-empty')
  if (required && !files.some(file=>/\.(?:node|dll)$/i.test(file.path))) throw new Error('build-artifact-node-pty-native-runtime-empty')
  return { directory, present: true, fileCount: files.length, files, patchReceipt, sha256: sha256(JSON.stringify(files.map(file=>[file.path,file.sha256]))) }
}

export function captureBuildArtifacts(engineRoot, { requireNodePty = false, requireNodePtyPatch = false } = {}) {
  const main = captureFile(engineRoot, 'dist/main.js')
  const manifest = captureFile(engineRoot, 'dist/runtime/build-manifest.json', bytes => {
    const contents = JSON.parse(bytes.toString('utf8'))
    if (typeof contents.buildId !== 'string' || !contents.buildId.trim()) throw new Error('build-manifest-missing-buildId')
    return { buildId: contents.buildId }
  })
  const directory = 'dist/storage/sqlite'
  const files = []
  const walk = relative => {
    const resolved = path.join(engineRoot, relative)
    if (fs.lstatSync(resolved).isSymbolicLink()) throw new Error(`build-artifact-symlink-directory:${relative}`)
    for (const entry of fs.readdirSync(resolved, { withFileTypes: true })) {
      if (entry.isDirectory() && !excludedDirectories.has(entry.name.toLowerCase())) walk(path.join(relative, entry.name))
      else if (entry.name.endsWith('.js') && !/\.(?:test|spec)\.js$/i.test(entry.name)) files.push(captureFile(engineRoot, path.join(relative, entry.name)))
    }
  }
  walk(directory)
  files.sort((a,b)=>a.path.localeCompare(b.path))
  if (!files.length) throw new Error('build-artifact-sqlite-production-js-empty')
  const sqliteProduction = { directory, fileCount: files.length, files, sha256: sha256(JSON.stringify(files.map(file=>[file.path,file.sha256]))) }
  const runtimeFiles=[]
  const walkRuntime=relative=>{
    const resolved=path.join(engineRoot,relative)
    if(fs.lstatSync(resolved).isSymbolicLink())throw new Error(`build-artifact-symlink-directory:${relative}`)
    for(const entry of fs.readdirSync(resolved,{withFileTypes:true})){
      if(entry.isDirectory()&&!excludedDirectories.has(entry.name.toLowerCase()))walkRuntime(path.join(relative,entry.name))
      else if(entry.isSymbolicLink())throw new Error(`build-artifact-runtime-symlink:${path.join(relative,entry.name)}`)
      else if(entry.isFile()&&/\.(?:js|mjs|cjs|json)$/i.test(entry.name)&&!/\.(?:test|spec)\./i.test(entry.name))runtimeFiles.push(captureFile(engineRoot,path.join(relative,entry.name)))
    }
  }
  walkRuntime('dist');runtimeFiles.sort((a,b)=>a.path.localeCompare(b.path))
  const runtimeProduction={directory:'dist',fileCount:runtimeFiles.length,files:runtimeFiles,sha256:sha256(JSON.stringify(runtimeFiles.map(file=>[file.path,file.sha256])))}
  const nodePtyProduction = captureNodePty(engineRoot, requireNodePty, requireNodePtyPatch)
  return { main, manifest, sqliteProduction, runtimeProduction, nodePtyProduction, fingerprintSha256: sha256(JSON.stringify({ main: main.sha256, manifest: manifest.sha256, buildId: manifest.buildId, sqliteProduction: sqliteProduction.sha256, runtimeProduction:runtimeProduction.sha256, nodePtyProduction: { present: nodePtyProduction.present, sha256: nodePtyProduction.sha256 } })) }
}

export function compareBuildArtifacts(before, after) {
  const toMap = snapshot => new Map([snapshot.main,snapshot.manifest,...snapshot.sqliteProduction.files,...(snapshot.runtimeProduction?.files??[]),...(snapshot.nodePtyProduction?.files??[])].map(file=>[file.path,file.sha256]))
  const prior=toMap(before),current=toMap(after),changedFiles=[]
  for (const name of [...new Set([...prior.keys(),...current.keys()])].sort()) {
    if(prior.get(name)!==current.get(name)) changedFiles.push({path:name,kind:!prior.has(name)?'added':!current.has(name)?'removed':'modified',beforeSha256:prior.get(name)??null,afterSha256:current.get(name)??null})
  }
  const nodePtyCoverageChanged = Boolean(before.nodePtyProduction) !== Boolean(after.nodePtyProduction) || before.nodePtyProduction?.present !== after.nodePtyProduction?.present
  return { unchanged: changedFiles.length===0 && before.manifest.buildId===after.manifest.buildId && !nodePtyCoverageChanged, manifestBuildIdChanged: before.manifest.buildId!==after.manifest.buildId, nodePtyCoverageChanged, nodePtyCovered: Boolean(before.nodePtyProduction?.present && after.nodePtyProduction?.present), changedFiles, beforeFingerprintSha256:before.fingerprintSha256,afterFingerprintSha256:after.fingerprintSha256 }
}
