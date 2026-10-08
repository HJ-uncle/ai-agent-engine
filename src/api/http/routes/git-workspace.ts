import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export interface GitWorkspace {
  base: string
  cwd: string
  repository?: { workTree: string; gitDir: string }
}

function inside(base: string, target: string): boolean {
  const relative = path.relative(base, target)
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep))
}

async function canonical(target: string): Promise<string> {
  try { return await fs.realpath(target) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    const parent = path.dirname(target)
    if (parent === target) return target
    return path.join(await canonical(parent), path.basename(target))
  }
}

async function bounded(base: string, target: string): Promise<string> {
  const resolved = await canonical(path.resolve(target))
  if (!inside(base, resolved)) throw new Error('Git repository points outside the current workspace')
  return resolved
}

async function optionalText(target: string): Promise<string | undefined> {
  try { return await fs.readFile(target, 'utf8') }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
}

async function validateObjectDirectory(base: string, target: string, visited: Set<string>): Promise<void> {
  const objects = await bounded(base, target)
  if (visited.has(objects)) return
  visited.add(objects)
  const alternatesFile = await bounded(base, path.join(objects, 'info', 'alternates'))
  const alternates = await optionalText(alternatesFile)
  for (const value of (alternates ?? '').split(/\r?\n/).filter(Boolean)) {
    // Git follows alternate chains recursively. Checking only the first hop
    // would let an internal object store delegate back to a different tenant.
    if (value.startsWith('"')) throw new Error('Quoted Git object alternates are not supported')
    await validateObjectDirectory(base, path.resolve(objects, value), visited)
  }
}

async function validateGitDirectory(base: string, gitDir: string): Promise<void> {
  if (!(await fs.stat(gitDir)).isDirectory()) throw new Error('Git directory is invalid')
  // Git follows these independently of cwd; a .git entry alone does not define
  // the repository boundary (linked worktrees share their common directory).
  const commonFile = await bounded(base, path.join(gitDir, 'commondir'))
  const common = await optionalText(commonFile)
  const commonDir = common === undefined ? gitDir : await bounded(base, path.resolve(gitDir, common.trim()))
  for (const directory of new Set([gitDir, commonDir])) {
    if (!(await fs.stat(directory)).isDirectory()) throw new Error('Git common directory is invalid')
    for (const name of ['HEAD', 'index', 'config', 'config.worktree', 'objects', 'refs']) {
      await bounded(base, path.join(directory, name))
    }
    await validateObjectDirectory(base, path.join(directory, 'objects'), new Set())
  }
}

export async function resolveGitWorkspace(basePath: string, cwdPath: string): Promise<GitWorkspace> {
  const base = await canonical(path.resolve(basePath))
  const cwd = await bounded(base, cwdPath)
  const workspace: GitWorkspace = { base, cwd }
  // Do not ask Git to discover a repository: a private session commonly lives
  // below the engine checkout, whose .git is outside this session's authority.
  let candidate = cwd
  while (inside(base, candidate)) {
    const marker = path.join(candidate, '.git')
    let stat
    try { stat = await fs.lstat(marker) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    if (stat) {
      const actualMarker = await bounded(base, marker)
      const actualStat = await fs.stat(actualMarker)
      let gitDir = actualMarker
      if (!actualStat.isDirectory()) {
        const content = await fs.readFile(actualMarker, 'utf8')
        const match = /^gitdir: ([^\r\n]+)\r?\n?$/.exec(content)
        if (!match) throw new Error('Git directory pointer is invalid')
        gitDir = await bounded(base, path.resolve(candidate, match[1]))
      }
      await validateGitDirectory(base, gitDir)
      workspace.repository = { workTree: candidate, gitDir }
      return workspace
    }
    if (candidate === base) break
    candidate = path.dirname(candidate)
  }
  return workspace
}

export function gitEnvironment(workspace: GitWorkspace): NodeJS.ProcessEnv {
  // Service launch environments may carry GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE,
  // alternates, or config injection. None may override an authenticated scope.
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^GIT_/i.test(name)))
  env.GIT_CEILING_DIRECTORIES = path.dirname(workspace.base)
  return env
}

export function gitArguments(workspace: GitWorkspace, args: string[]): string[] {
  if (args[0] === 'clone') return ['-C', workspace.cwd, ...args]
  if (!workspace.repository) {
    if (args[0] === 'init') return ['-C', workspace.cwd, ...args]
    throw new Error('The current workspace is not a Git repository')
  }
  const { workTree, gitDir } = workspace.repository
  // Explicit work-tree also defeats a stored core.worktree pointing elsewhere.
  return ['-C', workspace.cwd, `--git-dir=${gitDir}`, `--work-tree=${workTree}`, ...args]
}

export async function resolveGitPath(workspace: GitWorkspace, relativePath: string): Promise<string> {
  return bounded(workspace.base, path.resolve(workspace.cwd, relativePath))
}

export async function resolveGitCloneSource(workspace: GitWorkspace, value: string): Promise<string> {
  if (!/^file:/i.test(value)) return value
  const url = new URL(value)
  if (url.hostname) throw new Error('File clone sources must be local paths inside the current workspace')
  const source = await bounded(workspace.base, fileURLToPath(url))
  return pathToFileURL(source).href
}
