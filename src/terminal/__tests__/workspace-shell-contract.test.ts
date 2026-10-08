/** All fixtures, including boundary canaries, are disposable .e2e-tmp data. No server or user data is accessed. */
import { afterEach, describe, expect, it } from 'vitest'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { link, mkdir, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripVTControlCharacters } from 'node:util'

const shellPath = fileURLToPath(new URL('../workspace-shell.mjs', import.meta.url))
const tempRoot = path.resolve('.e2e-tmp')
const fixtures: string[] = []
const children = new Set<ChildProcessWithoutNullStreams>()
const allCommands = ['cd', 'pwd', 'ls', 'll', 'cat', 'mkdir', 'touch', 'rm', 'cp', 'mv', 'find', 'grep', 'tree', 'ws', 'echo', 'env', 'clear', 'help', 'exit', 'head', 'tail', 'wc', 'stat', 'hash', 'which', 'whoami', 'version', 'diagnose']
const canary = 'SYNTHETIC_OUTSIDE_CANARY_183765'
const plain = (value: string) => stripVTControlCharacters(value).replace(/\r/g, '')

async function fixture() {
  await mkdir(tempRoot, { recursive: true })
  const base = await mkdtemp(path.join(tempRoot, 'shell-validation-'))
  fixtures.push(base)
  const root = path.join(base, 'workspace'), outside = path.join(base, 'outside')
  await Promise.all([mkdir(root), mkdir(outside)])
  await writeFile(path.join(outside, 'canary.txt'), canary)
  return { base, root, outside }
}
async function stop(child: ChildProcessWithoutNullStreams) {
  if (!children.has(child)) return
  const closed = once(child, 'close')
  child.kill()
  await closed
}
afterEach(async () => {
  await Promise.all([...children].map(stop))
  for (const dir of fixtures.splice(0)) {
    const rel = path.relative(tempRoot, path.resolve(dir))
    if (!/^shell-validation-[^\\/]+$/.test(rel)) throw new Error('Unsafe shell fixture cleanup')
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
async function startShell(root: string, roots = [root], rootConfig = JSON.stringify(roots)) {
  // No inherited NODE_OPTIONS, profile paths, tokens, keys or engine DB config.
  const env: NodeJS.ProcessEnv = { WORKSPACE_ROOT: root, WORKSPACE_ROOTS: rootConfig, AUDIT_FAKE_ENGINE_TOKEN: 'synthetic-secret-only' }
  for (const key of ['SystemRoot', 'WINDIR', 'PATH', 'PATHEXT', 'COMSPEC']) if (process.env[key]) env[key] = process.env[key]
  const child = spawn(process.execPath, [shellPath], { cwd: root, env, windowsHide: true, stdio: 'pipe' })
  children.add(child)
  child.once('close', () => children.delete(child))
  let output = '', stderr = ''
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8')
  child.stdout.on('data', (value: string) => { output += value })
  child.stderr.on('data', (value: string) => { stderr += value })
  const waitPrompt = async (offset: number) => {
    const deadline = Date.now() + 7000
    while (Date.now() < deadline) {
      const current = plain(output.slice(offset))
      if (current.endsWith('$ ') && current.includes('\n')) return output.slice(offset)
      if (child.exitCode !== null) throw new Error(`Shell exited ${child.exitCode}: ${stderr}\n${current.slice(-1000)}`)
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    throw new Error(`No prompt: ${stderr}\n${plain(output.slice(offset)).slice(-2000)}`)
  }
  await waitPrompt(0)
  return {
    child,
    async command(command: string) {
      const offset = output.length
      child.stdin.write(command + '\n')
      const raw = await waitPrompt(offset)
      const lines = plain(raw).split('\n')
      expect(lines.shift()).toBe(command)
      expect(lines.pop()).toMatch(/\$ $/)
      return { text: lines.join('\n'), raw }
    },
    async input(input: string) {
      const offset = output.length
      child.stdin.write(input)
      return { text: plain(await waitPrompt(offset)), raw: output.slice(offset) }
    },
    async keys(chunks: string[]) {
      const offset = output.length
      // Simulate separate key events: readline treats a multi-key pipe chunk as paste.
      for (const chunk of chunks) {
        child.stdin.write(chunk)
        await new Promise(resolve => setTimeout(resolve, 15))
      }
      return { text: plain(await waitPrompt(offset)), raw: output.slice(offset) }
    },
    async finish(commands: string[]) {
      const closed = once(child, 'close')
      const offset = output.length
      child.stdin.end(commands.join('\n') + '\n')
      const timeout = setTimeout(() => child.kill(), 10_000)
      const [code] = await closed
      clearTimeout(timeout)
      expect(code).toBe(0)
      expect(stderr).toBe('')
      return plain(output.slice(offset))
    },
  }
}

describe('Workspace Shell complete help and functional contract', () => {
  it('lists all 28 implemented commands and has useful help for every entry', async () => {
    const { root } = await fixture(), shell = await startShell(root)
    const menu = (await shell.command('help')).text
    for (const name of allCommands) {
      expect(menu).toMatch(new RegExp(`(?:^|\\n)  ${name} +`))
      const topic = (await shell.command(`help ${name}`)).text
      expect(topic).not.toContain('未找到')
      expect(topic).toContain(name)
      expect(topic.length).toBeGreaterThan(name.length + 8)
    }
    expect((await shell.command('help constructor')).text).toContain('未找到')
  })

  it('navigates bound workspaces with cd/pwd/ws and rejects malformed indexes', async () => {
    const { root, outside } = await fixture()
    await mkdir(path.join(root, 'docs'))
    const shell = await startShell(root, [root, outside])
    expect((await shell.command('ws')).text).toContain('@ws2')
    await shell.command('cd docs')
    expect((await shell.command('pwd')).text).toBe(path.join(root, 'docs'))
    await shell.command('cd ..'); await shell.command('cd @ws2')
    expect((await shell.command('pwd')).text).toBe(outside)
    await shell.command('ws cd 1')
    expect((await shell.command('pwd')).text).toBe(root)
    expect((await shell.command('ws cd 1garbage')).text).toContain('整数')
    await shell.command('cd ~')
    expect((await shell.command('pwd')).text).toBe(root)
  })

  it('performs file mutations and reports their actual on-disk effects', async () => {
    const { root } = await fixture(), shell = await startShell(root)
    await shell.command('mkdir "nested folder/sub"')
    await shell.command('touch "nested folder/sub/empty.txt"')
    expect(await readFile(path.join(root, 'nested folder/sub/empty.txt'), 'utf8')).toBe('')
    await writeFile(path.join(root, 'source.txt'), 'preserve me\n')
    await shell.command('touch source.txt')
    expect(await readFile(path.join(root, 'source.txt'), 'utf8')).toBe('preserve me\n')
    await shell.command('cp source.txt copy.txt')
    await shell.command('mv copy.txt moved.txt')
    expect(existsSync(path.join(root, 'copy.txt'))).toBe(false)
    expect(await readFile(path.join(root, 'moved.txt'), 'utf8')).toBe('preserve me\n')
    await shell.command('rm moved.txt'); await shell.command('rm -r "nested folder"')
    expect(existsSync(path.join(root, 'moved.txt'))).toBe(false)
    expect(existsSync(path.join(root, 'nested folder'))).toBe(false)
  })

  it('lists hidden items, targets find/tree directories and respects exact glob/depth semantics', async () => {
    const { root } = await fixture(), shell = await startShell(root)
    await mkdir(path.join(root, 'src', 'sub'), { recursive: true })
    await writeFile(path.join(root, 'outside-name.txt'), '')
    await writeFile(path.join(root, '.hidden'), '')
    await writeFile(path.join(root, 'src', 'a.ts'), '')
    await writeFile(path.join(root, 'src', 'a.ts.bak'), '')
    await writeFile(path.join(root, 'src', 'sub', 'b.ts'), '')
    expect((await shell.command('ls')).text).not.toContain('.hidden')
    expect((await shell.command('ll -a')).text).toContain('.hidden')
    expect((await shell.command('ls -l')).text).toContain('修改时间')
    const found = (await shell.command('find src -name "*.ts"')).text
    expect(found).toContain('src/a.ts'); expect(found).toContain('src/sub/b.ts')
    expect(found).not.toContain('a.ts.bak'); expect(found).not.toContain('outside-name')
    expect((await shell.command('find src')).text).not.toContain('outside-name')
    const tree = (await shell.command('tree src -L 1')).text
    expect(tree).toContain('a.ts'); expect(tree).not.toContain('b.ts'); expect(tree).not.toContain('outside-name')
    expect((await shell.command('tree -L nope')).text).toContain('整数')
    expect((await shell.command('tree -L 33')).text).toContain('整数')
  })

  it('implements cat/head/tail/wc/stat/hash and reports independently computed data', async () => {
    const { root } = await fixture(), shell = await startShell(root)
    const content = 'alpha one\nBeta two\nthird\n'
    await writeFile(path.join(root, 'text.txt'), content)
    expect((await shell.command('cat text.txt')).text).toBe(content.trimEnd())
    expect((await shell.command('head -n 2 text.txt')).text).toBe('alpha one\nBeta two')
    expect((await shell.command('tail -n 1 text.txt')).text).toBe('third')
    expect((await shell.command('wc text.txt')).text).toBe(`3 5 ${Buffer.byteLength(content)} text.txt`)
    expect((await shell.command('wc -l text.txt')).text).toBe('3 text.txt')
    const metadata = JSON.parse((await shell.command('stat text.txt')).text)
    expect(metadata).toMatchObject({ type: 'file', bytes: Buffer.byteLength(content), contentReadable: true })
    for (const algorithm of ['sha256', 'sha512']) expect((await shell.command(`hash text.txt ${algorithm}`)).text).toBe(`${createHash(algorithm).update(content).digest('hex')}  text.txt`)
    expect((await shell.command('hash text.txt md5')).text).toContain('用法')
  })

  it('searches literal text by default and offers bounded opt-in regex', async () => {
    const { root } = await fixture(), shell = await startShell(root)
    await mkdir(path.join(root, 'src'))
    await writeFile(path.join(root, 'src', 'text.txt'), 'ALPHA\nalpha\na.b\naxb\n[\n')
    expect((await shell.command('grep -irn alpha src')).text).toBe('src/text.txt:1: ALPHA\nsrc/text.txt:2: alpha')
    expect((await shell.command('grep a.b src/text.txt')).text).toBe('src/text.txt: a.b')
    expect((await shell.command('grep --regex "^a.b$" src/text.txt')).text).toBe('src/text.txt: a.b\nsrc/text.txt: axb')
    expect((await shell.command('grep [ src/text.txt')).text).toBe('src/text.txt: [')
    expect((await shell.command('grep --regex [ src/text.txt')).text).toContain('无效正则')
    expect((await shell.command('grep alpha src')).text).toContain('需要 -r')
  })

  it('provides honest capabilities and never exposes arbitrary environment or host identity', async () => {
    const { root } = await fixture(), shell = await startShell(root)
    expect((await shell.command('which cat node constructor')).text).toBe('cat: 内置命令\nnode: 不可用（不查询宿主 PATH）\nconstructor: 不可用（不查询宿主 PATH）')
    expect((await shell.command('whoami')).text).toContain('不是宿主')
    expect((await shell.command('version')).text).toContain('Workspace Shell 1.1')
    expect((await shell.command('diagnose')).text).toContain('没有操作系统隔离')
    expect(JSON.parse((await shell.command('diagnose --json')).text)).toMatchObject({ osIsolation: false, externalProcesses: false, hostEnvironmentVisible: false, workspaceCount: 1, currentPathAvailable: true })
    expect((await shell.command('env')).text).not.toContain('synthetic-secret-only')
    expect((await shell.command('env AUDIT_FAKE_ENGINE_TOKEN')).text).toContain('不可查询')
    expect((await shell.command('env NODE_ENV')).text).toBe('development')
    expect((await shell.command('clear')).raw).toContain('\x1b[2J\x1b[H')
    expect((await shell.command('exit')).text).toContain('无法从 Shell 内部退出')
    expect((await shell.command('echo alive')).text).toBe('alive')
  })

  it('respects quotes before splitting commands and rejects an entire unmatched line', async () => {
    const { root } = await fixture(), shell = await startShell(root)
    expect((await shell.command('echo "a;b"; echo done')).text).toBe('a;b\ndone')
    await shell.command('touch "semi;colon.txt"')
    expect(existsSync(path.join(root, 'semi;colon.txt'))).toBe(true)
    expect((await shell.command('touch should-not-exist; echo "unclosed')).text).toContain('引号未闭合')
    expect(existsSync(path.join(root, 'should-not-exist'))).toBe(false)
    expect((await shell.command('echo "$TOKEN $(node nope) > redirection"')).text).toBe('$TOKEN $(node nope) > redirection')
    expect(existsSync(path.join(root, 'redirection'))).toBe(false)
  })

  it('drains 1200 queued commands after EOF instead of silently losing work', async () => {
    const { root } = await fixture(), shell = await startShell(root)
    const commands = Array.from({ length: 1200 }, (_, i) => `echo result-${i}`)
    commands.push('touch finished.txt')
    const output = await shell.finish(commands)
    const resultLines = output.split('\n').filter(line => /^result-\d+$/.test(line))
    expect(resultLines).toEqual(Array.from({ length: 1200 }, (_, i) => `result-${i}`))
    expect(existsSync(path.join(root, 'finished.txt'))).toBe(true)
  })
})

describe('Workspace Shell defensive boundary regression with synthetic fixtures', () => {
  it.each(['cat ../outside/canary.txt', 'head ../outside/canary.txt', 'tail ../outside/canary.txt', 'wc ../outside/canary.txt', 'hash ../outside/canary.txt', 'stat ../outside/canary.txt', 'grep CANARY ../outside/canary.txt', 'cp ../outside/canary.txt stolen.txt', 'touch ../outside/new.txt', 'mkdir ../outside/new', 'rm ../outside/canary.txt', 'mv ../outside/canary.txt stolen.txt'])('confines %s', async command => {
    const { root, outside } = await fixture(), shell = await startShell(root)
    const result = await shell.command(command)
    expect(result.text).toContain('禁止访问')
    expect(result.text).not.toContain(canary)
    expect(await readFile(path.join(outside, 'canary.txt'), 'utf8')).toBe(canary)
    expect(existsSync(path.join(outside, 'new.txt'))).toBe(false)
    expect(existsSync(path.join(root, 'stolen.txt'))).toBe(false)
  })

  it('rejects junction access, never follows recursive links, and revalidates an implicit cwd', async () => {
    const { root, outside } = await fixture(), shell = await startShell(root)
    await symlink(outside, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
    for (const command of ['cat linked/canary.txt', 'grep CANARY linked', 'mkdir linked/new', 'touch linked/new.txt']) expect((await shell.command(command)).text).toContain('禁止访问')
    expect((await shell.command('grep -r CANARY .')).text).not.toContain(canary)
    expect((await shell.command('tree')).text).not.toContain('canary.txt')
    expect((await shell.command('find')).text).not.toContain('canary.txt')
    await mkdir(path.join(root, 'changing'))
    await shell.command('cd changing')
    await rename(path.join(root, 'changing'), path.join(root, 'original'))
    await symlink(outside, path.join(root, 'changing'), process.platform === 'win32' ? 'junction' : 'dir')
    expect((await shell.command('ls')).text).toContain('禁止访问')
    expect((await shell.command('grep -r CANARY .')).text).not.toContain(canary)
    expect(await readFile(path.join(outside, 'canary.txt'), 'utf8')).toBe(canary)
  })

  it('refuses hardlinked file content and mutations while preserving outside data and timestamp', async () => {
    const { root, outside } = await fixture(), shell = await startShell(root)
    const target = path.join(outside, 'canary.txt')
    await link(target, path.join(root, 'hard.txt'))
    await writeFile(path.join(root, 'source.txt'), 'replacement')
    const before = await stat(target)
    for (const command of ['cat hard.txt', 'head hard.txt', 'tail hard.txt', 'wc hard.txt', 'hash hard.txt', 'cp hard.txt copied.txt', 'cp source.txt hard.txt', 'touch hard.txt', 'grep -r CANARY .']) {
      const output = (await shell.command(command)).text
      expect(output).toContain('单链接')
      expect(output).not.toContain(canary)
    }
    expect(await readFile(target, 'utf8')).toBe(canary)
    expect((await stat(target)).mtimeMs).toBe(before.mtimeMs)
    expect(existsSync(path.join(root, 'copied.txt'))).toBe(false)
  })

  it('protects roots even when another workspace is nested within the selected root', async () => {
    const { root } = await fixture()
    const nested = path.join(root, 'container', 'bound')
    await mkdir(nested, { recursive: true })
    const shell = await startShell(root, [root, nested])
    for (const command of ['rm -rf .', 'rm -rf container', 'mv . moved', 'mv container moved']) expect((await shell.command(command)).text).toContain('工作空间根目录')
    expect(existsSync(nested)).toBe(true)
  })

  it('rejects external programs and prototype members without starting processes', async () => {
    const { root } = await fixture(), shell = await startShell(root)
    for (const command of ['node --version', 'python --version', 'cmd.exe /c echo unexpected', 'powershell -Command echo unexpected', 'git status', 'npm --version', 'constructor', '__proto__', 'toString', '__defineGetter__']) expect((await shell.command(command)).text).toContain('已拒绝外部命令')
    expect((await shell.command('echo ready')).text).toBe('ready')
  })

  it('escapes terminal controls in file contents across all text output commands', async () => {
    const { root } = await fixture(), shell = await startShell(root)
    await writeFile(path.join(root, 'controls.txt'), 'normal\x1b]52;c;c2VjcmV0\x07\nCANARY\x1b[2J\n')
    for (const command of ['cat controls.txt', 'head controls.txt', 'tail controls.txt', 'grep -n CANARY controls.txt']) {
      const result = await shell.command(command)
      expect(result.raw).not.toContain('\x1b]52;')
      expect(result.raw).not.toContain('\x1b[2J')
      expect(result.text).toContain('\\u001b')
    }
  })

  it('times out pathological opt-in regex and remains available for subsequent commands', async () => {
    const { root } = await fixture(), shell = await startShell(root)
    await writeFile(path.join(root, 'repeat.txt'), 'a'.repeat(4000) + '!')
    const started = Date.now()
    expect((await shell.command('grep --regex "(a|aa)+$" repeat.txt')).text).toContain('超时')
    expect(Date.now() - started).toBeLessThan(3000)
    expect((await shell.command('echo responsive')).text).toBe('responsive')
  })

  it('refuses oversized files and unfinished input without executing their tail', async () => {
    const { root } = await fixture(), shell = await startShell(root)
    await writeFile(path.join(root, 'large.txt'), Buffer.alloc(8 * 1024 * 1024 + 1, 65))
    expect((await shell.command('cat large.txt')).text).toContain('字节预算')
    const result = await shell.input('echo ' + 'x'.repeat(34000) + '; touch injected.txt\n')
    expect(result.text).toContain('该行已丢弃')
    expect(existsSync(path.join(root, 'injected.txt'))).toBe(false)
    expect((await shell.command('echo recovered')).text).toBe('recovered')
  })

  it.skipIf(process.platform !== 'win32')('rejects Windows device names, ADS and namespace paths', async () => {
    const { root } = await fixture(), shell = await startShell(root)
    await writeFile(path.join(root, 'inside.txt'), 'inside')
    for (const target of ['NUL', 'CON.txt', 'COM1', 'COM¹.txt', 'inside.txt:secret', 'inside.txt.', '\\\\?\\' + root + '\\inside.txt']) {
      expect((await shell.command(`cat "${target}"`)).text).toContain('禁止访问')
    }
    expect((await shell.command('cat inside.txt')).text).toBe('inside')
  })

  it('fails closed on invalid root configuration instead of falling back to the host cwd', async () => {
    const { root } = await fixture()
    for (const config of ['null', '{}', '"not-an-array"', '[null]', '[3]', '{']) {
      const child = spawn(process.execPath, [shellPath], { cwd: root, env: { WORKSPACE_ROOTS: config }, windowsHide: true, stdio: 'pipe' })
      children.add(child); child.once('close', () => children.delete(child))
      let stderr = ''
      child.stderr.on('data', data => { stderr += data.toString() })
      const [code] = await once(child, 'close')
      expect(code).toBe(1)
      expect(stderr).toContain('工作空间配置无效')
    }
  })

  it('rejects missing or extra mutation arguments without partially changing files', async () => {
    const { root } = await fixture(), shell = await startShell(root)
    await writeFile(path.join(root, 'safe.txt'), 'original')
    for (const command of ['touch new.txt ignored', 'mkdir new ignored', 'cp safe.txt new.txt ignored', 'mv safe.txt new.txt ignored', 'rm -unknown safe.txt', 'rm safe.txt ignored']) {
      expect((await shell.command(command)).text).toMatch(/用法|不支持/)
    }
    expect(await readFile(path.join(root, 'safe.txt'), 'utf8')).toBe('original')
    expect(existsSync(path.join(root, 'new.txt'))).toBe(false)
    expect(existsSync(path.join(root, 'new'))).toBe(false)
  })

  it('matches wildcard filenames without treating regexp syntax as executable patterns', async () => {
    const { root } = await fixture(), shell = await startShell(root)
    await writeFile(path.join(root, '[a].txt'), '')
    await writeFile(path.join(root, 'a.txt'), '')
    expect((await shell.command('find -name "[a].txt"')).text).toBe('./[a].txt')
    expect((await shell.command('find -name "?.txt"')).text).toBe('./a.txt')
    expect((await shell.command('find -name "*a*a*a*a*a*a*a*a*a*b"')).text).toBe('')
  })

  it('supports terminal completion, history and editing without treating EOF keys as disconnection', async () => {
    const { root } = await fixture(), shell = await startShell(root)
    await writeFile(path.join(root, 'text.txt'), 'completion-content')
    expect((await shell.keys(['ca', '\t', ' text.txt\n'])).text).toContain('\ncompletion-content\n')
    await shell.command('echo history-result')
    expect((await shell.keys(['\x1b[A', '\n'])).text).toContain('\nhistory-result\n')
    expect((await shell.keys(['discard', '\x15', 'echo edited\n'])).text).toContain('\nedited\n')
    expect((await shell.keys(['\x04', 'echo alive-after-eof-key\n'])).text).toContain('\nalive-after-eof-key\n')
    expect((await shell.keys(['\x0c', 'echo cleared\n'])).raw).toContain('\x1b[2J\x1b[H')
  })

  it('bounds output and text line allocation while keeping the next command usable', async () => {
    const { root } = await fixture(), shell = await startShell(root)
    await writeFile(path.join(root, 'output.txt'), '汉'.repeat(900000))
    const output = await shell.command('cat output.txt')
    expect(output.text).toContain('输出已达到本条命令预算')
    expect(Buffer.byteLength(output.raw)).toBeLessThan(2 * 1024 * 1024 + 1024)
    await writeFile(path.join(root, 'lines.txt'), '\n'.repeat(100001))
    expect((await shell.command('tail lines.txt')).text).toContain('行预算')
    expect((await shell.command('grep anything lines.txt')).text).toContain('行预算')
    expect((await shell.command('echo available')).text).toBe('available')
  })

})
