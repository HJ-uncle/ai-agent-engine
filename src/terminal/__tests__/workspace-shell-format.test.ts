import { afterEach, describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripVTControlCharacters } from 'node:util'

const shellPath = fileURLToPath(new URL('../workspace-shell.mjs', import.meta.url))
const fixtureRoots: string[] = []

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'workspace-shell-format-'))
  fixtureRoots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(fixtureRoots.splice(0).map(root => {
    const resolved = path.resolve(root)
    if (!resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) || !path.basename(resolved).startsWith('workspace-shell-format-')) {
      throw new Error('Unsafe terminal fixture cleanup path')
    }
    return rm(resolved, { recursive: true, force: true })
  }))
})

// Deliberately independent of the shell formatter. These fixture characters have
// known widths in the client's default xterm Unicode V6 provider: CJK/fullwidth
// letters = 2, combining acute = 0, supplementary emoji = 1, ASCII = 1.
function cellWidth(text: string) {
  return [...text].reduce((width, char) => {
    const code = char.codePointAt(0)!
    if ([0x0301, 0x0600, 0x200d, 0x2060, 0x302e, 0xfe0f, 0xe0001].includes(code)) return width
    return width + ((code >= 0x4e00 && code <= 0x9fff) || (code >= 0xff01 && code <= 0xff60) ? 2 : 1)
  }, 0)
}

function cellColumn(line: string, token: string) {
  const index = line.indexOf(token)
  expect(index, `Missing ${JSON.stringify(token)} in ${JSON.stringify(line)}`).toBeGreaterThanOrEqual(0)
  return cellWidth(line.slice(0, index))
}

function firstCells(line: string, cells: number) {
  let text = ''
  let used = 0
  for (const char of line) {
    const width = cellWidth(char)
    if (used + width > cells) break
    text += char
    used += width
  }
  return text
}

async function runShell(root: string, columns: number, commands: string[]) {
  // Set the pipe's terminal width in a test-only preload. Production has no test
  // flag, and the real command parser/readline/file-system path remains active.
  const bootstrap = `Object.defineProperty(process.stdout, 'columns', { get: () => ${columns} });`
  const child = spawn(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(bootstrap)}`, shellPath], {
    cwd: root,
    env: { ...process.env, WORKSPACE_ROOT: root, WORKSPACE_ROOTS: JSON.stringify([root]) },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let output = ''
  let stderr = ''
  let processError: Error | undefined
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => { output += chunk })
  child.stderr.on('data', (chunk: string) => { stderr += chunk })
  child.on('error', error => { processError = error })

  async function waitForPrompt(offset: number, initial = false) {
    const deadline = Date.now() + 5_000
    while (Date.now() < deadline) {
      if (processError) throw processError
      if (child.exitCode !== null) throw new Error(`Shell exited (${child.exitCode}): ${stderr}\n${output}`)
      const chunk = output.slice(offset)
      const plain = stripVTControlCharacters(chunk).replace(/\r/g, '')
      if (plain.endsWith('~ $ ') && (initial || plain.includes('\n'))) return chunk
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    throw new Error(`Timed out waiting for shell prompt: ${stderr}\n${output.slice(offset)}`)
  }

  try {
    await waitForPrompt(0, true)
    const results: { raw: string; lines: string[] }[] = []
    for (const command of commands) {
      const offset = output.length
      child.stdin.write(command + '\n')
      const raw = await waitForPrompt(offset)
      const lines = stripVTControlCharacters(raw).replace(/\r/g, '').split('\n')
      expect(lines.shift()).toBe(command)
      expect(lines.pop()).toBe('~ $ ')
      results.push({ raw, lines })
    }
    return results
  } finally {
    if (child.exitCode === null) {
      const exited = once(child, 'exit')
      child.kill()
      await exited
    }
  }
}

describe('Workspace Shell listing output', () => {
  it.each([80, 120])('aligns Chinese headers, file metadata and right-aligned sizes at %i columns', async columns => {
    const root = await fixture()
    await mkdir(path.join(root, 'docs'))
    const files = ['alpha.txt', '中文报告.md', 'cafe\u0301.txt', 'rocket🚀.txt', 'ＡＢ.txt',
      'arabic\u0600.txt', 'tone\u302e.txt', 'join\u2060.txt', 'newer\u0487.txt', 'tag\u{e0001}.txt']
    await Promise.all(files.map((name, index) => writeFile(path.join(root, name), Buffer.alloc(index ? 2048 : 12))))
    const [{ raw, lines }] = await runShell(root, columns, ['ll'])
    const header = lines[0]
    expect(header.startsWith('名称')).toBe(true)
    const typeColumn = cellColumn(header, '类型')
    const timeColumn = cellColumn(header, '修改时间')
    const sizeEnd = cellColumn(header, '大小') + 4
    expect(sizeEnd).toBe(timeColumn - 2)
    expect(raw.split('\n').find(line => line.includes('修改时间'))).not.toContain('\x1b[2m')

    for (const name of ['docs/', ...files]) {
      const line = lines.find(value => value.startsWith(name))!
      expect(line, `Missing file ${name}`).toBeDefined()
      expect(cellColumn(line, name === 'docs/' ? '目录' : '文件')).toBe(typeColumn)
      const metadata = line.match(/(—|\d+(?:\.\d+)? (?:B|KB|MB|GB|TB)) {2}(\d{4}-\d{2}-\d{2} \d{2}:\d{2})$/)
      expect(metadata, line).not.toBeNull()
      expect(cellColumn(line, metadata![1]) + cellWidth(metadata![1])).toBe(sizeEnd)
      expect(cellColumn(line, metadata![2])).toBe(timeColumn)
      if (name === 'docs/') expect(metadata![1]).toBe('—')
    }
    expect(lines.at(-1)).toContain(`共 ${files.length + 1} 项`)
    // The separator belongs to the compact content table, not the viewport.
    expect(lines[1]).toMatch(/^─+$/)
    expect(cellWidth(lines[1])).toBe(timeColumn + 16)
    expect(cellWidth(lines[1])).toBeLessThan(columns - 1)
    expect(lines.every(line => cellWidth(line) < columns)).toBe(true)
  })

  it('gives leading combining characters a visible base in both listing layouts', async () => {
    const root = await fixture()
    const name = '\u0301\u2060accent.txt'
    await writeFile(path.join(root, name), 'content')
    const display = `◌${name}`
    const [ll, ls] = await runShell(root, 80, ['ll', 'ls'])
    const row = ll.lines.find(line => line.startsWith(display))!
    expect(row).toBeDefined()
    expect(cellColumn(row, '文件')).toBe(cellColumn(ll.lines[0], '类型'))
    expect(ls.lines).toEqual([display])
  })

  it.each([40, 80])('preserves an entire long Unicode filename without overflowing %i columns', async columns => {
    const root = await fixture()
    const name = '前端组件'.repeat(18) + '🚀cafe\u0301.txt'
    await writeFile(path.join(root, name), 'content')
    const [{ lines }] = await runShell(root, columns, ['ll'])
    expect(lines.every(line => cellWidth(line) < columns)).toBe(true)
    let fragments: string[]
    if (columns === 40) {
      expect(lines[0]).not.toContain('类型')
      const metadata = lines.findIndex(line => line.includes('文件 ·'))
      expect(metadata).toBeGreaterThan(0)
      fragments = lines.slice(0, metadata).filter(Boolean)
      expect(lines.some(line => line.includes('修改时间'))).toBe(true)
    } else {
      const typeColumn = cellColumn(lines[0], '类型')
      fragments = lines.slice(2).filter(line => !line.startsWith('共 ')).map(line => firstCells(line, typeColumn - 2))
    }
    expect(fragments.map(line => line.trimEnd()).join('')).toBe(name)
    expect(lines.join('\n')).not.toContain('…')
  })

  it('uses the detailed renderer for ls -l/-la/-al and distinguishes hidden-only from empty directories', async () => {
    const root = await fixture()
    await writeFile(path.join(root, '.hidden.md'), 'hidden')
    await mkdir(path.join(root, 'empty'))
    await mkdir(path.join(root, 'hidden-only'))
    await writeFile(path.join(root, 'hidden-only', '.secret'), 'hidden')
    const [ll, lsLong, llAll, lsLa, lsAl, empty, hidden, hiddenAll, lsEmpty, lsHidden] = await runShell(root, 80,
      ['ll', 'ls -l', 'll -a', 'ls -la', 'ls -al', 'll empty', 'll hidden-only', 'll -a hidden-only', 'ls empty', 'ls hidden-only'])
    expect(lsLong.lines).toEqual(ll.lines)
    expect(lsLa.lines).toEqual(llAll.lines)
    expect(lsAl.lines).toEqual(llAll.lines)
    expect(ll.lines.join('\n')).not.toContain('.hidden.md')
    expect(llAll.lines.join('\n')).toContain('.hidden.md')
    expect(empty.lines.join('\n')).toContain('目录为空')
    expect(hidden.lines.join('\n')).toContain('无可见项目（存在隐藏项，使用 -a 查看）')
    expect(hiddenAll.lines.join('\n')).toContain('.secret')
    expect(lsEmpty.lines.join('\n')).toContain('目录为空')
    expect(lsHidden.lines.join('\n')).toContain('无可见项目（存在隐藏项，使用 -a 查看）')
  })

  it('fits compact ls columns to actual mixed-width names and retains long filenames', async () => {
    const root = await fixture()
    const names = ['a.txt', '短.txt', 'cafe\u0301.txt', 'rocket🚀.txt', 'longer-name.txt', 'ＡＢ.txt', 'readme.md', 'z.txt']
    await Promise.all(names.map(name => writeFile(path.join(root, name), '')))
    const [{ lines }] = await runShell(root, 40, ['ls'])
    expect(lines.length).toBeLessThan(names.length)
    expect(lines.every(line => cellWidth(line) < 40)).toBe(true)
    const nonFirstColumns = new Set<number>()
    for (const name of names) {
      const line = lines.find(value => value.includes(name))!
      expect(line, `Missing file ${name}`).toBeDefined()
      const column = cellColumn(line, name)
      if (column) nonFirstColumns.add(column)
    }
    expect(nonFirstColumns.size).toBe(1)

    const longRoot = await fixture()
    const longName = '中文长文件名称'.repeat(8) + '.txt'
    await writeFile(path.join(longRoot, longName), '')
    const [longOutput] = await runShell(longRoot, 40, ['ls'])
    expect(longOutput.lines.every(line => cellWidth(line) < 40)).toBe(true)
    expect(longOutput.lines.join('')).toBe(longName)
  })

  it('identifies directory links without printing the target size', async () => {
    const root = await fixture()
    await mkdir(path.join(root, 'target'))
    await symlink(path.join(root, 'target'), path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
    const [{ lines }] = await runShell(root, 80, ['ll'])
    const linked = lines.find(line => line.startsWith('linked'))!
    expect(linked).toBeDefined()
    expect(linked).toMatch(/链接 +— {2}\d{4}-\d{2}-\d{2}/)
  })

  it.skipIf(process.platform === 'win32')('escapes filename terminal controls instead of executing them', async () => {
    const root = await fixture()
    await writeFile(path.join(root, 'bad\x1b[2Jname\n.txt'), '')
    const [{ raw, lines }] = await runShell(root, 80, ['ll'])
    expect(raw).not.toContain('bad\x1b[2J')
    expect(lines.filter(line => line.includes('文件'))).toHaveLength(1)
    expect(lines.join('\n')).toContain('\\n.txt')
  })
})
