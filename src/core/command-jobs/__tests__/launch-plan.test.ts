/** Real Windows processes cover argv, PATH/PATHEXT shims and cmd metacharacter preservation. */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { commandLooksLikeShellLine, createCommandLaunchPlan, resolveWindowsExecutable } from '../launch-plan.js'

let fixture: string
beforeEach(() => { fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'aether-launch-plan-')) })
afterEach(() => {
  if (path.dirname(fixture) !== path.resolve(os.tmpdir()) || !path.basename(fixture).startsWith('aether-launch-plan-')) throw new Error('Unsafe cleanup')
  fs.rmSync(fixture, { recursive: true, force: true })
})

function run(command: string, args: string[], env = process.env) {
  const plan = createCommandLaunchPlan(command, args, fixture, env)
  return spawnSync(plan.command, plan.args, { cwd: fixture, env, shell: false, windowsHide: true,
    windowsVerbatimArguments: plan.windowsVerbatimArguments, encoding: 'utf8', timeout: 10_000 })
}

describe('argv command contract', () => {
  it.each(['node -v', 'where python', 'cmd /c "node -v & python --version"'])('identifies a shell line: %s', command => {
    expect(commandLooksLikeShellLine(command, fixture)).toBe(true)
  })

  it('allows an executable path with spaces and an unresolved explicit executable path', () => {
    const executable = path.join(fixture, 'runtime with spaces.exe')
    fs.writeFileSync(executable, 'fixture')
    expect(commandLooksLikeShellLine(executable, fixture)).toBe(false)
    expect(commandLooksLikeShellLine(path.join(fixture, 'not installed.exe'), fixture)).toBe(false)
    expect(commandLooksLikeShellLine('node', fixture)).toBe(false)
  })

  it('preserves Node inline source and literal argv without a shell', () => {
    const values = ['two words', 'quote"inside', 'trailing\\', '%PATH%', '& echo injected', '| dir', '中文🙂']
    const source = 'const value = "quoted source";\nprocess.stdout.write(JSON.stringify({value,args:process.argv.slice(1)}))'
    const plan = createCommandLaunchPlan(process.execPath, ['-e', source, ...values], fixture, process.env)
    expect(plan.windowsVerbatimArguments).toBeUndefined()
    const result = run(process.execPath, ['-e', source, ...values])
    expect(result.error).toBeUndefined()
    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({ value: 'quoted source', args: values })
  })

  it('does not reinterpret an unknown command or a Unix command as a shell script', () => {
    expect(createCommandLaunchPlan('not-installed', ['hello & echo injected'], fixture, {}, 'win32'))
      .toEqual({ command: 'not-installed', args: ['hello & echo injected'] })
    expect(createCommandLaunchPlan('npm', ['run', 'build'], fixture, {}, 'linux'))
      .toEqual({ command: 'npm', args: ['run', 'build'] })
  })
})

describe.skipIf(process.platform !== 'win32')('Windows batch launch', () => {
  function shim(name: string, nodeModulesBin = false) {
    const directory = path.join(fixture, nodeModulesBin ? 'node_modules/.bin' : 'bin with spaces')
    fs.mkdirSync(directory, { recursive: true })
    const capture = path.join(fixture, 'capture.cjs')
    fs.writeFileSync(capture, 'process.stdout.write(JSON.stringify(process.argv.slice(2)))')
    const invoke = `"${process.execPath}" "${capture}" %*`
    const script = nodeModulesBin
      ? `@echo off\r\nsetlocal\r\nendlocal & goto #_undefined_# 2>NUL || title %COMSPEC% & ${invoke}\r\n`
      : `@echo off\r\n${invoke}\r\n`
    fs.writeFileSync(path.join(directory, name + '.cmd'), script)
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !['path', 'pathext'].includes(key.toLowerCase())))
    return { directory, env: { ...env, Path: directory, PATHEXT: '.EXE;.CMD', AETHER_LITERAL_PROBE: 'must-not-expand' } }
  }

  it.each(['npm', 'npx', 'pnpm', 'yarn'])('resolves bare %s from the supplied PATH and runs the batch shim', name => {
    const { directory, env } = shim(name)
    expect(resolveWindowsExecutable(name, fixture, env)).toBe(path.join(directory, name + '.CMD'))
    const result = run(name, ['--version'], env)
    expect(result.error).toBeUndefined()
    expect(result.status, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual(['--version'])
  })

  it.each([false, true])('preserves quoted and shell-looking arguments through a batch (node_modules/.bin=%s)', nodeModulesBin => {
    const { env } = shim('probe', nodeModulesBin)
    const values = ['two words', 'quote"inside', 'trailing\\', 'slash\\"quote', '%AETHER_LITERAL_PROBE%', '!', '^', 'a^b', '^^^', '^&', '中文🙂', '& echo injected > injected.txt', '| dir']
    const result = run('probe', values, env)
    expect(result.error).toBeUndefined()
    expect(result.status, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual(values)
    expect(fs.existsSync(path.join(fixture, 'injected.txt'))).toBe(false)
  })

  it.each(['\n', '\r\n'])('rejects batch arguments that cmd would truncate at a line break', newline => {
    const { env } = shim('probe')
    expect(() => run('probe', ['line one' + newline + '& echo injected > injected.txt'], env))
      .toThrow('未执行此命令')
    expect(fs.existsSync(path.join(fixture, 'injected.txt'))).toBe(false)
  })

  it('obeys PATHEXT and does not silently use an excluded batch extension', () => {
    const { env } = shim('probe')
    expect(resolveWindowsExecutable('probe', fixture, { ...env, PATHEXT: '.EXE' })).toBeUndefined()
    expect(createCommandLaunchPlan('probe', [], fixture, { ...env, PATHEXT: '.EXE' }))
      .toEqual({ command: 'probe', args: [] })
  })

  it('can still execute an explicit cmd script without rewriting its shell syntax', () => {
    const source = 'echo first & echo second'
    const result = run('cmd.exe', ['/d', '/s', '/c', source])
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout.trim().split(/\r?\n/).map(line => line.trim())).toEqual(['first', 'second'])
  })

  it('preserves valid nested quotes in a caller-supplied cmd /c script', () => {
    const source = `"${process.execPath}" -e "process.stdout.write('shell source')"`
    const plan = createCommandLaunchPlan('cmd.exe', ['/c', source], fixture, process.env)
    expect(plan.args.at(-1)).toBe('"' + source + '"')
    const result = run('cmd.exe', ['/c', source])
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toBe('shell source')
  })

  it('does not repair or reinterpret an invalid caller-supplied shell script', () => {
    const source = `"${process.execPath}" -e "const text = 'unterminated"`
    const result = run('cmd.exe', ['/d', '/s', '/c', source])
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('SyntaxError')
  })

  it('executes the installed npm shim without a network request', () => {
    const resolved = resolveWindowsExecutable('npm', fixture, process.env)
    if (!resolved) return
    const result = run('npm', ['--version'])
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/)
  })
})
