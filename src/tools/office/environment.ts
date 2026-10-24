import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { AgentContext, Tool } from '../../core/agent-context/index.js'
import { throwIfAborted } from '../../core/utils/abort.js'
import { getWorkspaceRuntimeMode } from '../../runtime/workspace-runtime.js'

const CACHE_MS = 120_000
const PROBE_TIMEOUT_MS = 3500
const MAX_OUTPUT_BYTES = 32 * 1024
const MODULES = [
  ['docx', 'python-docx'], ['pptx', 'python-pptx'], ['openpyxl', 'openpyxl'],
  ['reportlab', 'reportlab'], ['pymupdf', 'PyMuPDF'], ['pypdf', 'pypdf'], ['PIL', 'Pillow'],
] as const
const PYTHON_PROBE = `import sys,json,importlib,importlib.metadata,contextlib,os
packages=[]
for module,distribution in ${JSON.stringify(MODULES)}:
    item={'module':module,'distribution':distribution,'available':False}
    try:
        with open(os.devnull,'w') as sink,contextlib.redirect_stdout(sink),contextlib.redirect_stderr(sink): importlib.import_module(module)
        item['available']=True
        try: item['version']=importlib.metadata.version(distribution)
        except importlib.metadata.PackageNotFoundError: item['version']='unknown'
    except Exception as error: item['error']=type(error).__name__
    packages.append(item)
print(json.dumps({'version':sys.version.split()[0],'packages':packages}))`

// Read registrations only. Creating a COM object would start Office/WPS, may
// steal focus and can attach to a user's existing document session.
const COM_PROBE = `$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); $items=@();
foreach($view in @([Microsoft.Win32.RegistryView]::Registry64,[Microsoft.Win32.RegistryView]::Registry32)) {
  $root=[Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::ClassesRoot,$view)
  try { foreach($name in @('Word.Application','Excel.Application','PowerPoint.Application','KWps.Application','Ket.Application','KWpp.Application')) {
    $key=$root.OpenSubKey($name+'\\CLSID'); if($null -eq $key){continue}
    try {$clsid=[string]$key.GetValue('')} finally {$key.Dispose()}
    if($clsid -notmatch '^\\{[0-9a-fA-F-]{36}\\}$'){continue}
    $server=$root.OpenSubKey('CLSID\\'+$clsid+'\\LocalServer32'); if($null -eq $server){continue}
    try {$value=[Environment]::ExpandEnvironmentVariables([string]$server.GetValue(''))} finally {$server.Dispose()}
    $exe=''; if($value -match '^"([^"]+\\.exe)"'){$exe=$Matches[1]} elseif($value -match '^(.+?\\.exe)(?:\\s|$)'){$exe=$Matches[1]}
    $exists=$exe -and -not $exe.StartsWith('\\\\') -and $exe -notmatch '[\\x00-\\x1f\\x7f]' -and [IO.File]::Exists($exe)
    $items+=@{progId=$name;view=[string]$view;serverPath=$exe;serverExists=[bool]$exists}
  }} finally {$root.Dispose()}
}; ConvertTo-Json -InputObject @($items) -Compress`

interface PythonPackage { module: string; distribution: string; available: boolean; version?: string; error?: string }
interface PythonEvidence { path: string; source: 'configured' | 'standard-installation' | 'trusted-path'; status: 'available' | 'probe-failed'; version?: string; packages?: PythonPackage[]; reason?: string }
interface OfficeRegistration { progId: string; view: string; serverPath: string; serverExists: boolean }
export interface OfficeEnvironment {
  schemaVersion: 1
  checkedAt: number
  expiresAt: number
  runtime: string
  status: 'checked' | 'unavailable'
  python: PythonEvidence | null
  office: { com: OfficeRegistration[]; registryStatus: 'checked' | 'unavailable' | 'not-applicable'; libreOfficePath: string | null; conversionVerified: false }
  limitations: string[]
}
interface ProbeOptions { cwd: string; env: NodeJS.ProcessEnv; timeout: number; maxBuffer: number; windowsHide: true }
export interface OfficeEnvironmentPorts {
  environment(): NodeJS.ProcessEnv
  platform: NodeJS.Platform
  now(): number
  realpath(value: string): Promise<string>
  isFile(value: string): Promise<boolean>
  directories(value: string): Promise<string[]>
  run(binary: string, args: string[], options: ProbeOptions): Promise<string>
}
const ports: OfficeEnvironmentPorts = {
  environment: () => process.env, platform: process.platform, now: Date.now,
  realpath: value => fs.realpath(value),
  isFile: async value => { try { return (await fs.stat(value)).isFile() } catch { return false } },
  directories: async value => {
    const result: string[] = []
    try {
      const directory = await fs.opendir(value)
      let scanned = 0
      try { for await (const entry of directory) { if (entry.isDirectory()) result.push(entry.name); if (++scanned >= 32) break } }
      finally { await directory.close().catch(() => {}) }
    } catch { /* Missing standard installations are an ordinary capability result. */ }
    return result
  },
  run: (binary, args, options) => new Promise((resolve, reject) => {
    execFile(binary, args, { ...options, encoding: 'utf8' }, (error, stdout) => error ? reject(error) : resolve(stdout))
  }),
}
const envValue = (env: NodeJS.ProcessEnv, key: string): string => env[Object.keys(env).find(item => item.toLowerCase() === key.toLowerCase()) ?? key] ?? ''
const forbidden = (value: string): boolean => /^[\\/]{2}/.test(value) || /[\x00-\x1f\x7f]/.test(value)
  || /(?:^|[\\/])(?:\.ae|\.aether|\.e2e-tmp|\.git|node_modules|codex-runtimes|\.codex|WindowsApps)(?:[\\/]|$)/i.test(value)
const boundedText = (value: unknown, limit: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= limit
const notes = [
  'Python 探测使用 -I -B：不读取工作目录、PYTHONPATH 或用户 site-packages；库可导入不等于已验证文档转换。',
  'python-docx/python-pptx/openpyxl 可读写相应格式，但不提供 Office 原版式渲染；openpyxl 不计算 Excel 公式。',
  'reportlab 可新建 PDF；PyMuPDF 可检查和渲染 PDF。重新绘制 PDF 不等于从原 DOCX/PPTX 导出。',
  'COM 注册或 LibreOffice 文件存在只是转换候选；本工具不启动 Office、不导出、不安装依赖，conversionVerified 始终为 false。',
  '缺依赖时仅在当前角色工作区建立独立 venv，或报告平台缺项；不要修改全局/--user 环境，也不要借用其他任务或 Codex 私有运行时。',
]

/** One bounded probe is shared by simultaneous sessions; no model arguments choose executables. */
export class OfficeEnvironmentService {
  private cached?: { key: string; value: OfficeEnvironment }
  private pending?: { key: string; value: Promise<OfficeEnvironment> }
  constructor(private readonly port: OfficeEnvironmentPorts = ports) {}

  async inspect(signal?: AbortSignal): Promise<OfficeEnvironment> {
    throwIfAborted(signal)
    const env = { ...this.port.environment() }
    const keys = ['AUTH_ENABLED', 'AETHER_WORKSPACE_RUNTIME', 'AETHER_OFFICE_RUNTIME_ROOT', 'AETHER_OFFICE_PYTHON',
      'AETHER_OFFICE_SOFFICE', 'PATH', 'ProgramFiles', 'ProgramFiles(x86)', 'LOCALAPPDATA', 'SystemRoot', 'TEMP', 'TMP']
    const key = createHash('sha256').update(JSON.stringify([this.port.platform, ...keys.map(name => envValue(env, name))])).digest('hex')
    if (this.cached?.key === key && this.cached.value.expiresAt > this.port.now()) return structuredClone(this.cached.value)
    let pending = this.pending
    if (!pending) {
      const value = this.probe(env).then(value => { this.cached = { key, value }; return value })
      pending = { key, value }; this.pending = pending
      void value.finally(() => { if (this.pending === pending) this.pending = undefined }).catch(() => {})
    }
    // An environment change waits for the prior bounded probe instead of
    // multiplying diagnostic processes. It never reuses that result as current.
    if (pending.key !== key) { await this.wait(pending.value, signal); return this.inspect(signal) }
    return structuredClone(await this.wait(pending.value, signal))
  }

  private wait(value: Promise<OfficeEnvironment>, signal?: AbortSignal): Promise<OfficeEnvironment> {
    if (!signal) return value
    return new Promise((resolve, reject) => {
      const aborted = () => reject(signal.reason ?? new Error('Office environment observation cancelled'))
      signal.addEventListener('abort', aborted, { once: true })
      value.then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted)).catch(() => {})
      if (signal.aborted) aborted()
    })
  }

  private async probe(env: NodeJS.ProcessEnv): Promise<OfficeEnvironment> {
    const checkedAt = this.port.now()
    const result: OfficeEnvironment = { schemaVersion: 1, checkedAt, expiresAt: checkedAt + CACHE_MS,
      runtime: 'unavailable', status: 'unavailable', python: null,
      office: { com: [], registryStatus: this.port.platform === 'win32' ? 'unavailable' : 'not-applicable', libreOfficePath: null, conversionVerified: false }, limitations: [...notes] }
    try { result.runtime = getWorkspaceRuntimeMode(env) } catch { result.limitations.unshift('工作区执行运行时配置无效，未探测宿主程序。'); return result }
    if (result.runtime !== 'host') { result.limitations.unshift('当前使用隔离/受限运行时，未探测宿主；容器办公能力需由该运行时提供。'); return result }
    const p = this.port.platform === 'win32' ? path.win32 : path.posix
    const absolute = (value: string) => !!value && p.isAbsolute(value) && !forbidden(value)
    const samePath = (left: string, right: string) => this.port.platform === 'win32'
      ? p.normalize(left).toLowerCase() === p.normalize(right).toLowerCase() : p.normalize(left) === p.normalize(right)
    const standard = this.port.platform === 'win32'
      ? [envValue(env, 'ProgramFiles'), envValue(env, 'ProgramFiles(x86)'),
        ...[envValue(env, 'LOCALAPPDATA')].filter(Boolean).flatMap(root => [p.join(root, 'Python'), p.join(root, 'Programs', 'Python')])]
      : ['/usr/bin', '/usr/local/bin', '/usr/lib/libreoffice', '/opt/homebrew', '/opt/local', '/Library/Frameworks/Python.framework']
    const configuredRoot = envValue(env, 'AETHER_OFFICE_RUNTIME_ROOT')
    const roots: string[] = []
    for (const root of [...standard, configuredRoot].filter(absolute).slice(0, 8)) {
      try { const real = await this.port.realpath(root); if (absolute(real) && samePath(root, real)) roots.push(real) } catch { /* Not installed. */ }
    }
    const within = (candidate: string, root: string): boolean => {
      const relative = p.relative(root, candidate)
      return !p.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + p.sep)
    }
    const trusted = async (candidate: string): Promise<string | null> => {
      if (!absolute(candidate) || !roots.some(root => within(candidate, root))) return null
      try { const real = await this.port.realpath(candidate)
        return absolute(real) && roots.some(root => within(real, root)) && await this.port.isFile(real) ? real : null
      } catch { return null }
    }
    const candidates: Array<{ path: string; source: PythonEvidence['source'] }> = []
    const configuredPython = envValue(env, 'AETHER_OFFICE_PYTHON')
    if (configuredPython) candidates.push({ path: configuredPython, source: 'configured' })
    else {
      for (const directory of envValue(env, 'PATH').split(p.delimiter).slice(0, 64)) {
        if (!absolute(directory) || !roots.some(root => within(directory, root))) continue
        for (const name of this.port.platform === 'win32' ? ['python.exe', 'python3.exe'] : ['python3', 'python'])
          candidates.push({ path: p.join(directory, name), source: 'trusted-path' })
      }
      if (this.port.platform === 'win32') for (const root of roots.slice(0, 5)) {
        candidates.push({ path: p.join(root, 'python.exe'), source: 'standard-installation' })
        for (const name of (await this.port.directories(root)).filter(name => /^python(?:core)?[-\d.]/i.test(name)).slice(0, 12).reverse())
          candidates.push({ path: p.join(root, name, 'python.exe'), source: 'standard-installation' })
      }
    }
    let python: { path: string; source: PythonEvidence['source'] } | undefined
    for (const candidate of candidates.slice(0, 80)) {
      if (!/^python(?:[\d.]*)?(?:\.exe)?$/i.test(p.basename(candidate.path))) continue
      const safe = await trusted(candidate.path)
      if (safe) { python = { ...candidate, path: safe }; break }
    }
    if (configuredPython && !python) result.limitations.unshift('配置的 Python 不在受信任安装目录，或文件不可用；未回退到其他解释器。可由管理员配置 AETHER_OFFICE_RUNTIME_ROOT。')
    const soffice = envValue(env, 'AETHER_OFFICE_SOFFICE')
    const officeCandidates = soffice ? [soffice] : this.port.platform === 'win32'
      ? standard.slice(0, 2).filter(Boolean).map(root => p.join(root, 'LibreOffice', 'program', 'soffice.exe'))
      : ['/usr/bin/soffice', '/usr/local/bin/soffice', '/usr/lib/libreoffice/program/soffice', '/opt/homebrew/bin/soffice']
    for (const candidate of officeCandidates) {
      if (!/^soffice(?:\.exe)?$/i.test(p.basename(candidate))) continue
      result.office.libreOfficePath = await trusted(candidate)
      if (result.office.libreOfficePath) break
    }
    const run = (binary: string, args: string[]) => this.port.run(binary, args, { cwd: p.dirname(binary),
      env: { SystemRoot: envValue(env, 'SystemRoot'), WINDIR: envValue(env, 'SystemRoot'), PATH: p.dirname(binary),
        TEMP: envValue(env, 'TEMP'), TMP: envValue(env, 'TMP'), PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1' },
      timeout: PROBE_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES, windowsHide: true })
    await Promise.all([
      (async () => {
        if (!python) return
        result.python = { ...python, status: 'probe-failed' }
        try {
          const output = await run(python.path, ['-I', '-B', '-c', PYTHON_PROBE])
          if (Buffer.byteLength(output) > MAX_OUTPUT_BYTES) throw new Error('Oversized probe')
          const parsed = JSON.parse(output) as { version?: unknown; packages?: unknown }
          if (!boundedText(parsed.version, 64) || !Array.isArray(parsed.packages) || parsed.packages.length !== MODULES.length) throw new Error('Invalid probe')
          const packages = parsed.packages.map((item, index): PythonPackage => {
            if (!item || item.module !== MODULES[index][0] || item.distribution !== MODULES[index][1] || typeof item.available !== 'boolean'
              || item.version !== undefined && !boundedText(item.version, 64) || item.error !== undefined && !boundedText(item.error, 80)) throw new Error('Invalid package evidence')
            return { module: item.module, distribution: item.distribution, available: item.available,
              ...(item.version ? { version: item.version } : {}), ...(item.error ? { error: item.error } : {}) }
          })
          result.python = { ...python, status: 'available', version: parsed.version, packages }
        } catch { result.python.reason = '解释器探测超时或失败；未执行安装，也未改用其他任务的运行时。' }
      })(),
      (async () => {
        if (this.port.platform !== 'win32') return
        const systemRoot = envValue(env, 'SystemRoot')
        if (!absolute(systemRoot)) return
        const binary = p.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
        try {
          if (!await this.port.isFile(binary) || !samePath(await this.port.realpath(binary), binary)) return
          const output = await run(binary, ['-NoProfile', '-NonInteractive', '-Command', COM_PROBE])
          if (Buffer.byteLength(output) > MAX_OUTPUT_BYTES) return
          const items: unknown = JSON.parse(output)
          if (!Array.isArray(items) || items.length > 12) return
          result.office.com = items.filter((item): item is OfficeRegistration => item && typeof item === 'object'
            && ['Word.Application', 'Excel.Application', 'PowerPoint.Application', 'KWps.Application', 'Ket.Application', 'KWpp.Application'].includes(item.progId)
            && ['Registry32', 'Registry64'].includes(item.view) && typeof item.serverPath === 'string' && item.serverPath.length <= 1024
            && !/[\x00-\x1f\x7f]/.test(item.serverPath) && typeof item.serverExists === 'boolean')
          result.office.registryStatus = 'checked'
        } catch { /* Registry access is optional; missing evidence is not proof that Office is absent. */ }
      })(),
    ])
    result.status = 'checked'
    if (!result.python) result.limitations.unshift('未发现受信任的 Python；这不等于本机完全没有 Python。不要逐目录搜索其他任务或私有应用依赖。')
    return result
  }
}

const environmentService = new OfficeEnvironmentService()
export const officeEnvironmentTool: Tool = {
  name: 'office_environment', displayName: '办公运行环境',
  description: '只读查询办公运行环境：受信任的 Python 路径、可导入办公库及版本、Office/WPS COM 注册与 LibreOffice 候选。结果缓存 2 分钟，多任务共享一次有界探测；不启动 Office 窗口、不安装依赖、不导出文件。已安装/已注册不等于真实转换已验证；PyMuPDF/reportlab 不能替代原 DOCX/PPTX 渲染。仅宿主运行时可探测；不读取其他任务、任意项目目录或 Codex 私有依赖。',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  async execute(args: unknown, ctx: AgentContext) {
    if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).length) return {
      success: false, error: 'OFFICE_ENVIRONMENT_INVALID_ARGUMENTS', output: 'office_environment 仅接受空对象；不能指定可执行文件或安装参数。',
    }
    const environment = await environmentService.inspect(ctx.signal)
    return { success: true, output: JSON.stringify(environment), metadata: { readonly: true, fileMutationApplied: false, checkedAt: environment.checkedAt } }
  },
}
