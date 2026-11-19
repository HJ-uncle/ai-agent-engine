import { randomBytes } from 'node:crypto'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { instanceTokenState } from './auth/instance-token.js'

const usage = `用法：node dist/admin-cli.js token <status|show|generate>
  或：node dist/admin-cli.js admin create --data <主数据库> --out <新私有文件> [--name <姓名>]
  status    输出 not-set（未设）、empty（设置为空）或 configured（已配置），不显示值。
  show      明文输出本次独立启动配置中的实例令牌。
  generate  输出一个 32 字节随机候选值，不读取配置、不保存、不轮换。
请在与服务相同的目录和启动环境中运行。此命令不读取运行中进程或桌面临时令牌。\n`

async function readStartupToken(): Promise<{ desktop: true } | { desktop: false; value: string | undefined }> {
  // Use main's .env parser, including its rule that an inherited empty value is authoritative.
  await import('./env.js')
  if (process.env.AETHER_DESKTOP_OWNED === '1') return { desktop: true }

  // Configuration diagnostics may contain fragments of a malformed secret file. The CLI
  // runs in its own process: disable logs and the pretty-printer before loading the reader.
  process.env.LOG_LEVEL = 'silent'
  process.env.NODE_ENV = 'production'
  const { loadAetherConfig, loadManagedConfig, applyAetherConfigToEnv } = await import('./core/aether-config.js')
  applyAetherConfigToEnv(loadAetherConfig())
  // AETHER_INSTANCE_TOKEN is a TRUSTED_STARTUP_KEY: the server skips it during DB hydration.
  applyAetherConfigToEnv(loadManagedConfig(), true)
  return { desktop: false, value: process.env.AETHER_INSTANCE_TOKEN }
}

export async function runAdminCli(args: readonly string[]): Promise<number> {
  if ((args.length === 1 || (args.length === 2 && args[0] === 'token')) && ['-h', '--help', 'help'].includes(args.at(-1)!)) {
    process.stdout.write(usage)
    return 0
  }
  const [group, action] = args
  if (group === 'admin' && action === 'create') return (await import('./admin-provision.js')).createManagementOwner(args.slice(2))
  if (args.length !== 2 || group !== 'token' || !['status', 'show', 'generate'].includes(action)) {
    process.stderr.write(usage) // Arguments may contain an accidentally pasted credential.
    return 2
  }
  try {
    if (action === 'generate') {
      process.stdout.write(randomBytes(32).toString('hex') + '\n')
      return 0
    }
    const config = await readStartupToken()
    if (config.desktop) {
      process.stderr.write('此命令仅用于独立部署。桌面内置引擎的临时令牌由桌面管理。\n')
      return 1
    }
    const state = instanceTokenState(config.value)
    if (action === 'status') {
      process.stdout.write(state + '\n')
      return 0
    }
    if (state !== 'configured' || config.value === undefined) {
      process.stderr.write(state === 'empty' ? '实例令牌已设置为空，无法显示。\n' : '未设置实例令牌。\n')
      return 1
    }
    // Never allow configuration input to emit terminal controls or extra output lines.
    if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(config.value)) {
      process.stderr.write('实例令牌含有不能安全显示的控制字符；请在服务启动配置中更换。\n')
      return 1
    }
    process.stdout.write(config.value + '\n')
    return 0
  } catch {
    process.stderr.write('无法处理本地实例令牌，请检查此引擎的启动目录和配置。\n')
    return 1
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = await runAdminCli(process.argv.slice(2))
}
