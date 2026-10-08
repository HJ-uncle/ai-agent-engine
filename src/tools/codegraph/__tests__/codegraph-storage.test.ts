// Cover SDK failure contracts and .gitignore preservation that need controlled library writes.
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { loadCodeGraph } from '../codegraph-module.js'
import { projectDataPath } from '../../../core/project-storage.js'

const sdk = vi.hoisted(() => ({ isInitialized: vi.fn(), openSync: vi.fn(), init: vi.fn(), recreate: vi.fn() }))
vi.mock('@colbymchenry/codegraph', () => ({ CodeGraph: sdk, default: undefined }))
const fixtureParent = path.resolve('.e2e-tmp')
let root: string
let previousDirectory: string | undefined
const originalRules = '# CodeGraph data files — customized\n*.db\n!preferences.json\n'
const generatedRules = '# CodeGraph data files — local to each machine, not for committing.\n' +
  '# Ignore everything in .codegraph/ except this file itself, so transient\n' +
  '# files (the database, daemon.pid, sockets, logs) never show up in git.\n*\n!.gitignore\n'

beforeEach(() => {
  vi.resetAllMocks()
  previousDirectory = process.env.CODEGRAPH_DIR
  fs.mkdirSync(fixtureParent, { recursive: true })
  root = fs.mkdtempSync(path.join(fixtureParent, 'codegraph-storage-'))
  fs.mkdirSync(projectDataPath(root))
  fs.writeFileSync(projectDataPath(root, '.gitignore'), originalRules)
})

afterEach(() => {
  if (previousDirectory === undefined) delete process.env.CODEGRAPH_DIR
  else process.env.CODEGRAPH_DIR = previousDirectory
  const resolved = fs.realpathSync(root)
  if (path.dirname(resolved) !== fs.realpathSync(fixtureParent) ||
      !path.basename(resolved).startsWith('codegraph-storage-') || fs.lstatSync(root).isSymbolicLink()) {
    throw new Error('Unsafe codegraph storage fixture cleanup path')
  }
  fs.rmSync(resolved, { recursive: true, force: true })
})

it('rejects unsuccessful indexing and closes its database instead of publishing completion', async () => {
  const instance = { indexAll: vi.fn().mockResolvedValue({ success: false, errors: [{ message: 'Index lock occupied', severity: 'error' }] }), close: vi.fn() }
  sdk.init.mockResolvedValue(instance)
  const CodeGraph = await loadCodeGraph()
  await expect(CodeGraph.init(root, { index: true })).rejects.toThrow('Index lock occupied')
  expect(sdk.init).toHaveBeenCalledWith(root, { index: false })
  expect(instance.close).toHaveBeenCalledTimes(1)
})

it.each(['openSync', 'init', 'recreate'] as const)('restores an existing ignore file when SDK %s replaces it and then fails', async method => {
  const fail = () => {
    fs.writeFileSync(projectDataPath(root, '.gitignore'), generatedRules)
    throw new Error('SDK failed')
  }
  if (method === 'openSync') sdk.openSync.mockImplementation(fail)
  else sdk[method].mockImplementation(async () => fail())
  const CodeGraph = await loadCodeGraph()
  if (method === 'openSync') expect(() => CodeGraph.openSync(root)).toThrow('SDK failed')
  else await expect(CodeGraph[method](root)).rejects.toThrow('SDK failed')
  expect(fs.readFileSync(projectDataPath(root, '.gitignore'), 'utf8')).toBe(originalRules)
})

it('does not replace user changes made during SDK initialization', async () => {
  const userRules = '# New user rules\nnew-cache/\n'
  sdk.init.mockImplementation(async () => {
    fs.writeFileSync(projectDataPath(root, '.gitignore'), userRules)
    throw new Error('SDK failed')
  })
  const CodeGraph = await loadCodeGraph()
  await expect(CodeGraph.init(root)).rejects.toThrow('SDK failed')
  expect(fs.readFileSync(projectDataPath(root, '.gitignore'), 'utf8')).toBe(userRules)
})
