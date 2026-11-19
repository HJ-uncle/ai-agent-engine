import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { constants, open, mkdir, lstat, unlink } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { provisionOfflineAdmin } from './api/http/admin/rbac-storage.js'

// chmod on Windows does not establish a private ACL. Restrict the empty new file before writing a key.
async function privateWindowsFile(file: string): Promise<void> {
  if (process.platform !== 'win32') return
  const system = join(process.env.SystemRoot || 'C:\\Windows', 'System32'), run = promisify(execFile)
  const who = await run(join(system,'whoami.exe'), ['/user','/fo','csv','/nh'], {windowsHide:true,timeout:5000})
  const sid = who.stdout.match(/"(S-1-[0-9]+(?:-[0-9]+)+)"\s*$/im)?.[1]
  if (!sid) throw new Error('Cannot identify the operating account')
  await run(join(system,'icacls.exe'), [file,'/inheritance:r','/grant:r','*'+sid+':(F)'], {windowsHide:true,timeout:5000})
}

/** This command uses local filesystem authority. It does not load service or desktop secrets. */
export async function createManagementOwner(args: readonly string[]): Promise<number> {
  const options = new Map<string,string>()
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i], value = args[i+1]
    if (!['--data','--out','--name'].includes(name) || options.has(name) || !value || value.startsWith('--')) return usage()
    options.set(name,value)
  }
  if (!options.has('--data') || !options.has('--out')) return usage()
  const db = resolve(options.get('--data')!), output = resolve(options.get('--out')!)
  try {
    const check = await open(db, constants.O_RDONLY)
    try {
      const header = Buffer.alloc(16)
      if ((await check.read(header, 0, 16, 0)).bytesRead !== 16 || header.toString('latin1') !== 'SQLite format 3\0') throw new Error()
    } finally { await check.close() }
  } catch { process.stderr.write('请先启动引擎，并用 --data 指向该实例已初始化的主数据库文件。\n'); return 1 }
  let owned: { dev: bigint; ino: bigint } | undefined
  try {
    if (await lstat(output).then(()=>true,error=>{ if (error.code === 'ENOENT') return false; throw error })) {
      process.stderr.write('输出文件已存在，请选择新的私有文件。\n'); return 1
    }
    await provisionOfflineAdmin(db, options.get('--name') || '本机管理员', async key => {
      await mkdir(dirname(output), {recursive:true, mode:0o700})
      const file = await open(output,'wx',0o600)
      try { owned = await file.stat({bigint:true}); await file.chmod(0o600); await privateWindowsFile(output); await file.writeFile(key+'\n','utf8'); await file.sync() } finally { await file.close() }
    })
    process.stdout.write('后台主管理员已创建。请从指定的私有文件读取后台专用密钥；既有凭据没有被替换。\n'); return 0
  } catch {
    if (owned) { // The store never throws after confirming commit. Only clean up our own unsuccessful file.
      try { const actual=await lstat(output,{bigint:true}); if(actual.isFile()&&actual.dev===owned.dev&&actual.ino===owned.ino) await unlink(output) } catch { /* the operator may already have moved it */ }
    }
    process.stderr.write('未能确认后台管理员创建成功。请检查名称、数据库与输出目录权限；不要覆盖已有的密钥文件。\n'); return 1
  }
}
function usage(): number {
  process.stderr.write('用法：node dist/admin-cli.js admin create --data <实际主数据库> --out <新的私有文件> [--name <管理员姓名>]\n'); return 2
}
