/** Prepare a separate sibling checkout for full client regression against a candidate.
 * Never replace the live engine dist or the live client's resource directory.
 * Usage: node scripts/longrun/prepare-isolated-client-candidate.mjs
 *   --candidate-dist <compiled-dist> --expected-build-id sha256:<64 hex>
 *   [--destination <engine-root>/.tmp/client-candidate-<name>]
 */
import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'

const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const sha = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex')
const json = file => JSON.parse(fs.readFileSync(file, 'utf8'))
const equalPath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
const directoryExists = file => fs.existsSync(file) && fs.lstatSync(file).isDirectory() && !fs.lstatSync(file).isSymbolicLink()

export function assertDestination(engineRoot, destination) {
  const root = fs.realpathSync(engineRoot), temp = path.join(root, '.tmp'), resolved = path.resolve(destination)
  if (!equalPath(path.dirname(resolved), temp) || !/^client-candidate-[a-z0-9-]+$/i.test(path.basename(resolved))) {
    throw new Error('Destination must be a named client-candidate-* direct child of engine .tmp')
  }
  if (fs.existsSync(temp) && (!directoryExists(temp) || !equalPath(fs.realpathSync(temp), temp))) {
    throw new Error('Engine .tmp must be an ordinary contained directory')
  }
  if (fs.existsSync(resolved) && (!directoryExists(resolved) || !equalPath(fs.realpathSync(resolved), resolved))) {
    throw new Error('Candidate destination must not be a link or escaped directory')
  }
  return resolved
}

export function productionDistPath(relative) {
  return !relative.split(/[\\/]/).includes('__tests__') && !/\.(?:test|spec)\./.test(relative) && !/\.map$|\.d\.ts$/.test(relative)
}

/** All copies are new ordinary files. Only explicit node_modules links may target an original checkout. */
function copyTree(source, target, filter = () => true, prefix = '') {
  if (!directoryExists(source)) throw new Error('Copy source must be an ordinary directory: ' + source)
  fs.mkdirSync(target, { recursive: true })
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const relative = prefix ? prefix + '/' + entry.name : entry.name
    if (!filter(relative)) continue
    const input = path.join(source, entry.name), output = path.join(target, entry.name)
    const stat = fs.lstatSync(input)
    if (stat.isSymbolicLink()) throw new Error('Copy refused symbolic link: ' + input)
    if (stat.isDirectory()) copyTree(input, output, filter, relative)
    else if (stat.isFile()) fs.copyFileSync(input, output, fs.constants.COPYFILE_EXCL)
    else throw new Error('Copy refused non-regular asset: ' + input)
  }
}

function inventory(directory, filter = () => true, prefix = '') {
  const files = []
  for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = prefix ? prefix + '/' + entry.name : entry.name
    if (!filter(relative)) continue
    const file = path.join(directory, entry.name), stat = fs.lstatSync(file)
    if (stat.isSymbolicLink()) throw new Error('Inventory refused symbolic link: ' + file)
    if (stat.isDirectory()) files.push(...inventory(file, filter, relative))
    else if (stat.isFile()) files.push({ path: relative, bytes: stat.size, sha256: sha(fs.readFileSync(file)) })
    else throw new Error('Inventory refused non-regular asset: ' + file)
  }
  return files
}

function writeJson(file, value) { fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' }) }
function verifyInventory(directory, files) {
  const actual = inventory(directory, relative => relative !== 'stage-manifest.json')
  if (JSON.stringify(actual) !== JSON.stringify(files)) throw new Error('Runtime stage inventory differs from preparation manifest')
}

function dependencyLink(target, original) {
  const resolved = fs.realpathSync(original)
  if (!directoryExists(resolved)) throw new Error('Dependency target must be an ordinary directory')
  fs.symlinkSync(resolved, target, process.platform === 'win32' ? 'junction' : 'dir')
  if (!equalPath(fs.realpathSync(target), resolved)) throw new Error('Dependency link resolved to an unexpected checkout')
  return { path: target, target: resolved, policy: 'Read dependencies only. Do not run install, postinstall, update, or lint in this candidate.' }
}

/** Runtime staging pins installed versions and adds the IDE's bundled language server. */
export function validateTemplateDependencies(enginePackage, engineLock, stagePackage, clientLock) {
  const source = enginePackage.dependencies ?? {}, staged = stagePackage.dependencies ?? {}
  for (const name of Object.keys(source)) {
    const locked = engineLock.packages?.['node_modules/' + name]?.version
    if (!locked || staged[name] !== locked) throw new Error('Candidate production dependency differs from locked runtime template: ' + name)
  }
  for (const name of Object.keys(staged)) {
    if (Object.hasOwn(source, name)) continue
    if (name !== 'typescript-language-server' || staged[name] !== clientLock.packages?.['node_modules/' + name]?.version) {
      throw new Error('Runtime template has an unexpected or unlocked dependency: ' + name)
    }
  }
}

export async function prepareCandidate({ candidateDist, expectedBuildId, engineRoot = scriptRoot, clientRoot = path.resolve(engineRoot, '../aether-code'), destination } = {}) {
  engineRoot = fs.realpathSync(engineRoot)
  clientRoot = fs.realpathSync(clientRoot)
  if (!/^sha256:[a-f0-9]{64}$/.test(expectedBuildId ?? '')) throw new Error('A precise expected candidate build ID is required')
  if (!candidateDist || !directoryExists(candidateDist)) throw new Error('An ordinary candidate dist directory is required')
  candidateDist = fs.realpathSync(candidateDist)
  const manifest = json(path.join(candidateDist, 'runtime/build-manifest.json'))
  if (manifest.buildId !== expectedBuildId || manifest.protocolVersion !== 1 || manifest.subagentSchemaVersion !== 1) throw new Error('Candidate manifest identity/protocol does not match the explicit expected build')
  for (const name of ['main.js', 'runtime/build-identity.js', 'storage/sqlite/local-process-runtime.js', 'terminal/workspace-shell.mjs']) {
    const file = path.join(candidateDist, name)
    if (!fs.existsSync(file) || !fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink()) throw new Error('Candidate dist missing ordinary runtime asset: ' + name)
  }
  const { createBuildManifest } = await import(pathToFileURL(path.join(candidateDist, 'runtime/build-identity.js')).href)
  if (createBuildManifest(engineRoot).buildId !== expectedBuildId) throw new Error('Candidate manifest does not describe current source build inputs')
  const candidateFiles = inventory(candidateDist, productionDistPath)
  const baseStage = path.join(clientRoot, 'resources/engine/win32-x64')
  const previousStage = json(path.join(baseStage, 'stage-manifest.json'))
  if (previousStage.schemaVersion !== 1 || previousStage.platform !== 'win32-x64') throw new Error('Valid Windows runtime template required')
  if (sha(fs.readFileSync(path.join(engineRoot, 'package-lock.json'))) !== previousStage.lockSha256) throw new Error('Candidate dependency lock differs from runtime template; prepare a matching isolated template first')
  const pkg = json(path.join(engineRoot, 'package.json'))
  const stagePackage = json(path.join(baseStage, 'package.json'))
  validateTemplateDependencies(pkg, json(path.join(engineRoot, 'package-lock.json')), stagePackage,
    fs.existsSync(path.join(clientRoot, 'package-lock.json')) ? json(path.join(clientRoot, 'package-lock.json')) : {})
  verifyInventory(baseStage, previousStage.files)
  for (const [name, version] of Object.entries(stagePackage.dependencies ?? {})) {
    if (json(path.join(baseStage, 'node_modules', name, 'package.json')).version !== version) throw new Error('Runtime dependency bytes differ from pinned package manifest: ' + name)
  }
  destination = assertDestination(engineRoot, destination ?? path.join(engineRoot, '.tmp', 'client-candidate-' + new Date().toISOString().replace(/[^0-9]/g, '') + '-' + randomUUID()))
  const resultFile = path.join(destination, 'candidate-preparation.json')
  if (fs.existsSync(destination)) {
    if (!fs.existsSync(resultFile)) throw new Error('Existing candidate is incomplete or unowned; choose a new destination')
    const result = json(resultFile)
    if (result.schemaVersion !== 1 || result.expectedBuildId !== expectedBuildId || !equalPath(result.sourceEngineRoot, engineRoot) || !equalPath(result.sourceClientRoot, clientRoot) || !equalPath(result.candidateDist, candidateDist)
      || !equalPath(result.destination, destination) || !equalPath(result.candidateEngineRoot, path.join(destination, 'ai-agent-engine')) || !equalPath(result.candidateClientRoot, path.join(destination, 'aether-code')) || !equalPath(result.runtimeStage, path.join(destination, 'aether-code/resources/engine/win32-x64'))) throw new Error('Existing candidate belongs to different build inputs')
    for (const [target, original] of [[path.join(result.candidateEngineRoot, 'node_modules'), path.join(engineRoot, 'node_modules')], [path.join(result.candidateClientRoot, 'node_modules'), path.join(clientRoot, 'node_modules')]]) {
      if (!fs.existsSync(target) || !equalPath(fs.realpathSync(target), fs.realpathSync(original))) throw new Error('Prepared dependency link target changed')
    }
    verifyInventory(result.runtimeStage, json(path.join(result.runtimeStage, 'stage-manifest.json')).files)
    if (JSON.stringify(inventory(path.join(result.candidateEngineRoot, 'dist'))) !== JSON.stringify(candidateFiles)) throw new Error('Prepared sibling engine differs from candidate dist')
    return { ...result, reused: true }
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  fs.mkdirSync(destination)
  writeJson(path.join(destination, 'candidate-owner.json'), { schemaVersion: 1, createdAt: new Date().toISOString(), expectedBuildId, sourceEngineRoot: engineRoot, sourceClientRoot: clientRoot, candidateDist })
  const siblingEngine = path.join(destination, 'ai-agent-engine'), isolatedClient = path.join(destination, 'aether-code')
  fs.mkdirSync(siblingEngine); fs.mkdirSync(isolatedClient)
  for (const name of ['package.json', 'package-lock.json', 'tsconfig.json', 'README.md']) if (fs.existsSync(path.join(engineRoot, name))) fs.copyFileSync(path.join(engineRoot, name), path.join(siblingEngine, name), fs.constants.COPYFILE_EXCL)
  copyTree(candidateDist, path.join(siblingEngine, 'dist'), productionDistPath)
  if (directoryExists(path.join(engineRoot, '.aether/skills'))) copyTree(path.join(engineRoot, '.aether/skills'), path.join(siblingEngine, '.aether/skills'))
  for (const name of ['src', 'out', 'e2e', 'scripts', 'build']) copyTree(path.join(clientRoot, name), path.join(isolatedClient, name))
  for (const name of ['package.json', 'package-lock.json', 'AGENTS.md', 'README.md', 'playwright.config.ts', 'electron.vite.config.ts', 'electron-builder.yml', 'tsconfig.json', 'tsconfig.node.json', 'tsconfig.web.json', 'eslint.config.mjs', '.prettierrc.yaml']) {
    if (fs.existsSync(path.join(clientRoot, name))) fs.copyFileSync(path.join(clientRoot, name), path.join(isolatedClient, name), fs.constants.COPYFILE_EXCL)
  }
  copyTree(path.join(clientRoot, 'resources'), path.join(isolatedClient, 'resources'), relative => relative !== 'engine')
  const runtimeStage = path.join(isolatedClient, 'resources/engine/win32-x64')
  copyTree(baseStage, runtimeStage, relative => relative !== 'dist' && relative !== 'stage-manifest.json' && relative !== 'verify-runtime.mjs' && relative !== 'package.json')
  writeJson(path.join(runtimeStage, 'package.json'), { ...stagePackage, name: pkg.name, version: pkg.version })
  copyTree(candidateDist, path.join(runtimeStage, 'dist'), productionDistPath)
  fs.copyFileSync(path.join(clientRoot, 'scripts/verify-engine-runtime.mjs'), path.join(runtimeStage, 'verify-runtime.mjs'), fs.constants.COPYFILE_EXCL)
  const files = inventory(runtimeStage)
  writeJson(path.join(runtimeStage, 'stage-manifest.json'), { ...previousStage, buildId: expectedBuildId, engineVersion: manifest.version, files, candidateTemplateBuildId: previousStage.buildId })
  verifyInventory(runtimeStage, files)
  if (JSON.stringify(inventory(path.join(siblingEngine, 'dist'))) !== JSON.stringify(candidateFiles) || JSON.stringify(inventory(path.join(runtimeStage, 'dist'))) !== JSON.stringify(candidateFiles)) throw new Error('Isolated engine or client runtime differs from candidate production dist')
  if (JSON.stringify(inventory(candidateDist, productionDistPath)) !== JSON.stringify(candidateFiles) || createBuildManifest(engineRoot).buildId !== expectedBuildId) throw new Error('Candidate build inputs changed during preparation')
  const links = [dependencyLink(path.join(siblingEngine, 'node_modules'), path.join(engineRoot, 'node_modules')), dependencyLink(path.join(isolatedClient, 'node_modules'), path.join(clientRoot, 'node_modules'))]
  const result = { schemaVersion: 1, createdAt: new Date().toISOString(), expectedBuildId, sourceEngineRoot: engineRoot, sourceClientRoot: clientRoot, candidateDist, destination, candidateEngineRoot: siblingEngine, candidateClientRoot: isolatedClient, runtimeStage, candidateProductionFiles: candidateFiles.length, stageFiles: files.length, originalStageBuildId: previousStage.buildId, links, commands: { fullClientSuite: { cwd: isolatedClient, command: 'npm run test:e2e -- --output=../client-results' }, verifyStage: { cwd: isolatedClient, command: 'npm run verify:engine' } }, qualification: 'Preparation validates source identity and artifact parity. Full client, runtime smoke, real-model compression, and semantic acceptance remain separate gates.' }
  writeJson(resultFile, result)
  return result
}

export function parseArguments(args) {
  const out = {}
  const names = new Map([['--candidate-dist', 'candidateDist'], ['--expected-build-id', 'expectedBuildId'], ['--destination', 'destination']])
  for (let index = 0; index < args.length; index += 2) {
    const name = names.get(args[index]), value = args[index + 1]
    if (!name || !value || value.startsWith('--') || out[name]) throw new Error('Unknown, missing, or repeated argument: ' + args[index])
    out[name] = value
  }
  return out
}

if (process.argv[1] && equalPath(process.argv[1], fileURLToPath(import.meta.url))) {
  console.log(JSON.stringify(await prepareCandidate(parseArguments(process.argv.slice(2))), null, 2))
}
