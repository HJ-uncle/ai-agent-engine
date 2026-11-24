// The desktop acceptance suite also exercises a real offline copy of npm. This fixture pins the argv and selection contracts independently of the host npm installation.
import fs from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { HTTPMCPClient } from '../client.js'
import { stdioCommand } from '../stdio-command.js'

const parent = path.resolve('.e2e-tmp', 'windows-mcp-launch')
let root: string, bin: string
const argv = ['two words', 'literal & | % ^', '中文', '']

describe.skipIf(process.platform !== 'win32')('Windows MCP package launchers', () => {
  beforeAll(() => {
    fs.mkdirSync(parent, { recursive: true }); root = fs.mkdtempSync(path.join(parent, 'run ')); bin = path.join(root, 'selected node')
    const cli = path.join(bin, 'node_modules', 'npm', 'bin'); fs.mkdirSync(cli, { recursive: true })
    fs.copyFileSync(process.execPath, path.join(bin, 'node.exe'))
    for (const name of ['npm', 'npx']) {
      fs.writeFileSync(path.join(bin, name + '.cmd'), '@exit /b 9\r\n')
      fs.writeFileSync(path.join(cli, name + '-cli.js'), [
        "const { createInterface } = require('node:readline');",
        "createInterface({input: process.stdin}).on('line', line => { const req=JSON.parse(line); if(req.id === undefined) return;",
        "const result=req.method==='initialize'?{protocolVersion:req.params.protocolVersion}:{tools:[{name:'receipt',description:JSON.stringify(process.argv.slice(2)),inputSchema:{type:'object'}}]};",
        "process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:req.id,result})+'\\n') });"
      ].join('\n'))
    }
  })
  afterAll(() => {
    if (root && path.dirname(fs.realpathSync(root)) === fs.realpathSync(parent) && !fs.lstatSync(root).isSymbolicLink()) fs.rmSync(root, { recursive: true, force: true, maxRetries: 4 })
  })
  it.each(['npm', 'npx', 'npx.cmd'])('handshakes using %s and preserves the exact arguments', async command => {
    const client = new HTTPMCPClient({ name: 'fixture', transportType: 'stdio', command, args: argv, env: { pAtH: bin }, timeoutMs: 5_000 })
    try { expect(await client.listTools()).toMatchObject([{ name: 'receipt', description: JSON.stringify(argv) }]) }
    finally { await client.disconnect() }
  })
  it('honors a native shim, an explicit launcher path, and an incompatible user wrapper', () => {
    const first = path.join(root, 'version manager'); fs.mkdirSync(first)
    const exe = path.join(first, 'npx.exe'); fs.copyFileSync(process.execPath, exe)
    const env = { PATH: [first, bin].join(';') }
    expect(stdioCommand('npx', argv, env)).toMatchObject({ command: exe, args: argv })
    expect(stdioCommand(path.join(bin, 'npx.cmd'), argv, env).command).toBe(path.join(bin, 'node.exe'))
    fs.writeFileSync(path.join(first, 'npm.cmd'), '@exit /b 8\r\n')
    expect(() => stdioCommand('npm', argv, env)).toThrow('configure the executable')
  })
})
