import { PluginError, type PluginArtifact, type PluginManifest } from './types.js'
import { pluginProjectPackage, pluginProjectRunner } from './project-runner.js'
import { PLUGIN_CONTRIBUTION_CATALOGUE } from './contributions.js'
import { PLUGIN_CAPABILITY_CATALOGUE } from './capabilities.js'
import { sessionReviewHtml } from './session-review-template.js'
import { PLUGIN_SDK_QUICKSTART, pluginSdkTypes } from './sdk-contract.js'

/** The authoring contract is shared by AI tools, HTTP clients and the project CLI. */
export const PLUGIN_TEMPLATE_PROTOCOL = Object.freeze({
  apiVersion: 1,
  runtime: 'node',
  toolNames: 'stdin.tool 使用 manifest.tools[].name 的本地工具名，不使用 plugin_<id>_<name> 全局名。',
  stdin: '宿主写入一份 UTF-8 JSON {tool,args} 后关闭 stdin（EOF）；入口通过 for await 读取到 EOF，再解析和执行。',
  stdout: '成功时 stdout 只输出一行 JSON {result,artifacts?}，随后退出；不要将日志、Markdown 或 HTML 作为协议输出。',
  errors: '异常写入 stderr，并以非零状态退出；不得将 {error:...}、{success:false,...} 包装为成功 result。stderr 也可用于诊断日志。',
  artifacts: '产物通过 artifacts:[{path,content,encoding?:"utf8"|"base64"}] 返回；path 为安全相对路径，测试仅预览，实际会话由宿主写入工作区并记录回退。',
  files: '标准工程包含 aether-plugin.json、main.mjs、README.md、QUICKSTART.md、aether-sdk.d.ts、examples/cases.json、package.json、scripts/test.mjs；清单是唯一配置来源。只使用 Node 内置库和包内文件，不自动安装依赖。',
  examples: 'examples/cases.json 使用 {cases:[{name,tool,args,expected}]}；expected 精确匹配 result。独立 npm test 验证业务断言，不替代宿主 inputSchema、产物路径/大小校验；通过后仍需引擎 check/test 或管理页测试，再发布。',
  authoring: '先用 plugin_get_template 获取目录与 SDK 摘要，再用 plugin_scaffold({templateId,id,directory}) 一次生成完整本地工程；不要逐页读取和抄写模板。打开开发模式后编辑源码、刷新并验证。基于最接近的模板保留已有核心实现与边界用例；自定义需求必须继续实现，获得脚手架不等于需求完成。实际没有执行的案例不得宣称通过。',
  ui: 'manifest.contributes 支持 pages/navigation/workspaceTabs/services/commands/menus/views/statusBar/settings/editorDecorations/hooks/background；完整位置与严格 schema 见返回的 contributions。tool 页面按 inputSchema 生成表单；native 页面加载包内 {version:1,root:Node} 声明式 JSON 组件树；webview 页面加载包内自包含 HTML，运行于不透明源 iframe。两者只能调用白名单工具与授权 SDK，不开放任意 Electron IPC 或宿主 React/JavaScript 注入。',
  download: '自定义页面使用 await aetherPlugin.download({fileName:"report.json",content:"...",encoding:"utf8"})，encoding 可为 utf8（默认）或 base64。用户点击导出后由宿主显示原生保存对话框，返回 {saved:boolean,bytes?:number}，不返回本机路径。fileName 必须是单文件名，不含路径，解码后最多 16 MiB；图片可在 iframe 本地 Canvas 处理后 base64 导出，无需传给 Node 工具。不要使用被沙箱禁止的 a[download] 或网络上传代替。',
  uiBridge: '页面用 $AE（兼容 aetherPlugin 的原有页面方法）。await $AE.invoke(tool,args) 返回完整调用回执 {result,artifacts,stderr,durationMs,plugin:{id,revision,hash}}；业务结果位于 receipt.result。await $AE.context() 返回扁平 {sessionId:string|null,workspacePath:string|null,engineReady:boolean,pluginId:string,revision:number}。Node 工具共享 $AE 平台能力与 context()，不提供页面专属 invoke/download/navigate/services；独立 npm test 不注入 SDK。上下文由宿主绑定，平台工作区能力自动使用绑定工作区；自定义工具的 root/workspace 参数仍须显式传入。',
  uiTheme: '页面应使用宿主实际提供的 CSS 变量：--bg-app、--bg-surface、--bg-elevated、--bg-input、--bg-hover、--bg-active、--fg、--fg-strong、--fg-muted、--fg-faint、--accent、--accent-hover、--accent-fg、--accent-soft、--border、--border-strong。color-scheme 与 data-appearance 自动随宿主 light/dark 更新。不要猜测 --background、--foreground、--primary 等其他框架变量。',
  limits: '每次 Node 工具调用的整份 JSON 输入默认最多 256 KiB，输出最多 2 MiB，最多 16 个 artifacts 且解码内容合计最多 2 MiB；不能用 inputSchema.maxLength 扩大宿主限制。页面应检查实际 UTF-8 输入大小并显示明确范围，或分批处理。自定义页面 download 是独立的用户保存通道，解码后最大 16 MiB，不等于工具输入限制。',
  background: '每次工具调用启动独立 Node 进程，完成即退出。contributes.services 是应用内服务状态；需要跨页面、关闭窗口和跨引擎重启的周期任务请声明 contributes.background 并请求 background.run。后台由引擎调度并持久化 nextRunAt，间隔至少1000ms，错过多次最多补跑一次，不重叠执行；撤权/停用/卸载会中止并清理。完全退出应用后不执行，下次引擎启动恢复，不是操作系统服务或开机任务。hooks 需 events.subscribe，工具从 args.event 读取宿主事件，不能自行伪造宿主事件。',
  capabilities: '$AE 提供 session、models、ai、agents、skills、workspace、knowledge、mcp、settings；完整方法见工程 aether-sdk.d.ts，快速示例见 QUICKSTART.md。manifest.permissions.requested 声明权限，用户可在插件权限面板单独或批量授权。默认拒绝，撤权阻止后续调用。模型凭据由平台持有，无须插件另配密钥。settings 仅保存此插件的设置；能力声明不能绕过绑定会话、工作区和租户边界。',
} as const)

export interface PluginTemplateSummary { id: string; name: string; description: string }
export interface PluginTemplate extends PluginTemplateSummary {
  manifest: PluginManifest
  files: Record<string, string>
  protocol: typeof PLUGIN_TEMPLATE_PROTOCOL
  contributions?: typeof PLUGIN_CONTRIBUTION_CATALOGUE
  capabilities?: typeof PLUGIN_CAPABILITY_CATALOGUE
}
interface ExampleCase { name: string; tool: string; args: Record<string, unknown>; expected: unknown; artifacts?: PluginArtifact[] }

function entry(tool: string, body: string): string {
  return [
    '// Read exactly one request. The host closes stdin after writing the JSON.',
    'try {',
    "  let input = ''",
    "  process.stdin.setEncoding('utf8')",
    '  for await (const chunk of process.stdin) input += chunk',
    '  const request = JSON.parse(input)',
    "  if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Error('Invalid request')",
    `  if (request.tool !== ${JSON.stringify(tool)}) throw new Error('Unknown local tool name: ' + request.tool)`,
    '  const args = request.args',
    "  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('args must be an object')",
    ...body.trim().split('\n').map(line => '  ' + line),
    '} catch (error) {',
    '  console.error(error instanceof Error ? error.message : String(error))',
    '  process.exitCode = 1',
    '}',
    '',
  ].join('\n')
}

function template(summary: PluginTemplateSummary, manifest: PluginManifest, source: string, cases: ExampleCase[], notes: string): PluginTemplate {
  const readme = `# ${manifest.name}\n\n${summary.description}\n\n${notes}\n\n## 工程文件\n\n- aether-plugin.json：apiVersion 1 清单。\n- main.mjs：Node ESM 工具入口。\n- examples/cases.json：确定性输入与 expected 结果，可选 artifacts 精确断言。\n- package.json、scripts/test.mjs：只依赖 Node 内置库的独立测试，不需要 npm install。\n\n## 协议\n\n${Object.values(PLUGIN_TEMPLATE_PROTOCOL).filter(value => typeof value === 'string').join('\n\n')}\n\n## 本地验证与交付\n\n独立工程可用 Node 22+ 在任何目录运行：\n\n\`\`\`powershell\ncd ./my-plugin\nnpm test\n\`\`\`\n\n在引擎仓库执行（路径按实际工程替换；ZIP 输出在工程之外）：\n\n\`\`\`powershell\nnpx tsx scripts/plugin-project.ts check ./my-plugin\nnpx tsx scripts/plugin-project.ts test ./my-plugin\nnpx tsx scripts/plugin-project.ts pack ./my-plugin ./my-plugin.zip\n\`\`\`\n\nAI 可先调用 plugin_get_template 发现模板并理解协议。需求匹配时使用 plugin_scaffold({templateId:模板ID,id:新插件ID,name?,description?})，宿主直接生成并验证完整工程，无需逐文件读取或复录源码；自定义需求在脚手架基础上实现、测试后再发布。只有模板不适用时才提交完整 manifest/files；已有本地工程通过导入流程安装。再用 plugin_test 验证，并按产品批准流程发布。多用例优先通过 plugin_test 的 cases 一次测试，不并行触发多个确认；必须检查业务 result，不得发布只打印诊断日志的版本。手动创建可使用项目 CLI 初始化或在插件管理页选择模板。\n`
  return { ...summary, manifest, files: { 'aether-plugin.json': JSON.stringify(manifest, null, 2) + '\n', 'main.mjs': source,
    'README.md': readme, 'examples/cases.json': JSON.stringify({ cases }, null, 2) + '\n', 'package.json': pluginProjectPackage(manifest), 'scripts/test.mjs': pluginProjectRunner }, protocol: PLUGIN_TEMPLATE_PROTOCOL, contributions: PLUGIN_CONTRIBUTION_CATALOGUE, capabilities: PLUGIN_CAPABILITY_CATALOGUE }
}

const templates: PluginTemplate[] = [
  template({ id: 'json-tool', name: '基础 JSON 工具', description: '接收 JSON 参数、规范化文本并返回确定性 JSON 结果。' }, {
    apiVersion: 1, id: 'my-json-tool', name: '文本整理工具', version: '1.0.0', description: '将连续空白合并为一个空格，并统计字符数。', runtime: 'node',
    tools: [{ name: 'normalize_text', description: '整理文本中的空白并统计 Unicode 字符数。', entry: 'main.mjs',
      inputSchema: { type: 'object', properties: { text: { type: 'string', title: '文本', maxLength: 10000 } }, required: ['text'], additionalProperties: false } }],
  }, entry('normalize_text', String.raw`
if (typeof args.text !== 'string') throw new Error('text must be a string')
const text = args.text.trim().replace(/\s+/gu, ' ')
const result = { text, characters: Array.from(text).length }
process.stdout.write(JSON.stringify({ result }) + '\n')
`), [
    { name: '合并空白', tool: 'normalize_text', args: { text: '  Hello\n Aether  ' }, expected: { text: 'Hello Aether', characters: 12 } },
    { name: 'Unicode 字符', tool: 'normalize_text', args: { text: '  你好  🌟 ' }, expected: { text: '你好 🌟', characters: 4 } },
    { name: '空文本', tool: 'normalize_text', args: { text: ' \t ' }, expected: { text: '', characters: 0 } },
  ], '这是无副作用的基础工具。修改工具名时，同时修改清单、入口分派和案例的 tool；不要导出一个无人调用的 default function。'),

  template({ id: 'markdown-report', name: 'Markdown 报告', description: '生成 Markdown 报告，通过标准产物通道交付文件。' }, {
    apiVersion: 1, id: 'my-report', name: '报告生成工具', version: '1.0.0', description: '根据标题、摘要和要点生成 Markdown 报告产物。', runtime: 'node',
    tools: [{ name: 'create_report', description: '生成 reports/<slug>.md 报告，返回产物而不直接写文件。', entry: 'main.mjs',
      inputSchema: { type: 'object', properties: { title: { type: 'string', title: '标题', minLength: 1, maxLength: 200 }, summary: { type: 'string', title: '摘要', maxLength: 10000 },
        points: { type: 'array', title: '要点', items: { type: 'string', maxLength: 2000 }, maxItems: 100 }, slug: { type: 'string', title: '文件名', minLength: 1, maxLength: 48, description: '小写字母、数字与连字符组成的文件名，入口进一步校验。' } },
      required: ['title', 'summary', 'points', 'slug'], additionalProperties: false } }],
  }, entry('create_report', String.raw`
if (typeof args.title !== 'string' || !args.title.trim()) throw new Error('title is required')
if (typeof args.summary !== 'string' || !Array.isArray(args.points) || args.points.some(point => typeof point !== 'string')) throw new Error('Invalid report content')
if (typeof args.slug !== 'string' || !/^[a-z0-9][a-z0-9-]{0,47}$/.test(args.slug)) throw new Error('Invalid report slug')
const title = args.title.trim().replace(/[\r\n]+/g, ' ')
const path = 'reports/' + args.slug + '.md'
const content = ['# ' + title, '', args.summary, '', '## 要点', '', ...args.points.map(point => '- ' + point), ''].join('\n')
const result = { path, title, pointCount: args.points.length }
process.stdout.write(JSON.stringify({ result, artifacts: [{ path, content, encoding: 'utf8' }] }) + '\n')
`), [
    { name: '生成周报', tool: 'create_report', args: { title: '周报', summary: '本周完成基础功能。', points: ['实现插件', '验证产物'], slug: 'weekly' },
      expected: { path: 'reports/weekly.md', title: '周报', pointCount: 2 },
      artifacts: [{ path: 'reports/weekly.md', content: '# 周报\n\n本周完成基础功能。\n\n## 要点\n\n- 实现插件\n- 验证产物\n', encoding: 'utf8' }] },
    { name: '空要点', tool: 'create_report', args: { title: '记录', summary: '', points: [], slug: 'notes' },
      expected: { path: 'reports/notes.md', title: '记录', pointCount: 0 },
      artifacts: [{ path: 'reports/notes.md', content: '# 记录\n\n\n\n## 要点\n\n', encoding: 'utf8' }] },
  ], '入口只返回 artifacts，不调用 fs 写入工作区。plugin_test 和项目 CLI test 仅预览产物；会话调用时宿主负责文件写入与回退。Markdown 文件是附件产物，不是自定义应用页面。'),

  template({ id: 'time-calculator', name: '时间计算', description: '以明确的 UTC 时间计算偏移，可在原生操作页使用；不提供后台提醒。' }, {
    apiVersion: 1, id: 'my-time-tool', name: '时间计算工具', version: '1.0.0', description: '对指定 UTC 时间增加或减少分钟；只进行本次计算，不安排提醒。', runtime: 'node',
    tools: [{ name: 'add_minutes', description: '对 ISO UTC 时间增加分钟，支持负数；不启动定时器或后台任务。', entry: 'main.mjs',
      inputSchema: { type: 'object', properties: { at: { type: 'string', title: '开始时间（UTC）', minLength: 20, maxLength: 24, description: 'ISO UTC时间，例如2026-11-11T08:00:00Z，或带三位毫秒；入口校验日历合法性。' },
        minutes: { type: 'integer', title: '偏移分钟', minimum: -5256000, maximum: 5256000 } }, required: ['at', 'minutes'], additionalProperties: false } }],
  }, entry('add_minutes', String.raw`
if (typeof args.at !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(args.at)) throw new Error('at must be an ISO UTC time ending in Z')
if (!Number.isSafeInteger(args.minutes) || Math.abs(args.minutes) > 5256000) throw new Error('minutes must be an integer within the supported range')
const at = new Date(args.at)
const canonical = args.at.length === 20 ? args.at.slice(0, -1) + '.000Z' : args.at
if (!Number.isFinite(at.getTime()) || at.toISOString() !== canonical) throw new Error('Invalid calendar time')
const shifted = new Date(at.getTime() + args.minutes * 60000)
if (!Number.isFinite(shifted.getTime())) throw new Error('Time is outside the supported range')
const result = { atUtc: at.toISOString(), shiftedUtc: shifted.toISOString(), minutes: args.minutes }
process.stdout.write(JSON.stringify({ result }) + '\n')
`), [
    { name: '增加九十分钟', tool: 'add_minutes', args: { at: '2026-11-11T08:00:00Z', minutes: 90 },
      expected: { atUtc: '2026-11-11T08:00:00.000Z', shiftedUtc: '2026-11-11T09:30:00.000Z', minutes: 90 } },
    { name: '跨日减少分钟', tool: 'add_minutes', args: { at: '2026-01-01T00:15:00.000Z', minutes: -30 },
      expected: { atUtc: '2026-01-01T00:15:00.000Z', shiftedUtc: '2025-12-31T23:45:00.000Z', minutes: -30 } },
    { name: '跨入闰日', tool: 'add_minutes', args: { at: '2028-02-28T23:30:00Z', minutes: 90 },
      expected: { atUtc: '2028-02-28T23:30:00.000Z', shiftedUtc: '2028-02-29T01:00:00.000Z', minutes: 90 } },
  ], '必须提供 at，不读取当前系统时间，确保测试可复现。输入时区固定为 UTC（Z），避免本地时区和夏令时歧义。本模板不提供闹钟、倒计时页面、后台提醒、持久状态或定时任务。'),
  template({ id: 'currency-converter', name: '货币换算', description: '可直接操作的金额、币种与汇率表单；汇率由用户提供，不编造实时行情。' }, {
    apiVersion: 1, id: 'my-currency-converter', name: '货币换算器', version: '1.0.0', description: '选择币种并输入金额和汇率，计算换算金额。汇率由用户提供，不读取实时行情。', runtime: 'node',
    tools: [{ name: 'convert', description: '按用户提供的汇率换算金额，按目标货币的小数位四舍五入；JPY、KRW 为零位，其余两位。', entry: 'main.mjs',
      inputSchema: { type: 'object', properties: {
        amount: { type: 'number', title: '金额', description: '待换算金额。', minimum: 0, maximum: 1e12 },
        from: { type: 'string', title: '源币种', enum: ['USD', 'CNY', 'EUR', 'JPY', 'GBP', 'HKD', 'SGD', 'AUD', 'CAD', 'CHF', 'KRW'] },
        to: { type: 'string', title: '目标币种', enum: ['USD', 'CNY', 'EUR', 'JPY', 'GBP', 'HKD', 'SGD', 'AUD', 'CAD', 'CHF', 'KRW'] },
        rate: { type: 'number', title: '汇率', description: '1 单位源币种可兑换的目标币种数量。请提供自己的汇率；示例不是实时行情。', exclusiveMinimum: 0, maximum: 1e6 },
      }, required: ['amount', 'from', 'to', 'rate'], additionalProperties: false } }],
  }, entry('convert', String.raw`
const codes = ['USD','CNY','EUR','JPY','GBP','HKD','SGD','AUD','CAD','CHF','KRW']
if (!codes.includes(args.from) || !codes.includes(args.to)) throw new Error('请选择支持的币种')
if (!Number.isFinite(args.amount) || args.amount < 0 || args.amount > 1e12) throw new Error('金额超出支持范围')
if (!Number.isFinite(args.rate) || args.rate <= 0 || args.rate > 1e6) throw new Error('请提供有效的正数汇率')
if (args.from === args.to && args.rate !== 1) throw new Error('相同币种的汇率必须为 1')
// Parse the decimal JSON numbers, then round the product with integer arithmetic.
function decimal(value) {
  const [mantissa, exponent = '0'] = String(value).toLowerCase().split('e')
  const [integer, fraction = ''] = mantissa.split('.')
  const scale = fraction.length - Number(exponent)
  const coefficient = BigInt(integer + fraction)
  return scale < 0 ? { coefficient: coefficient * 10n ** BigInt(-scale), scale: 0 } : { coefficient, scale }
}
const amount = decimal(args.amount), rate = decimal(args.rate)
const places = ['JPY', 'KRW'].includes(args.to) ? 0 : 2
const numerator = amount.coefficient * rate.coefficient * 10n ** BigInt(places)
const denominator = 10n ** BigInt(amount.scale + rate.scale)
const minor = (2n * numerator + denominator) / (2n * denominator)
if (minor > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('换算金额超出可安全表示的范围')
const digits = minor.toString().padStart(places + 1, '0')
const text = places ? digits.slice(0, -places) + '.' + digits.slice(-places) : digits
const converted = Number(text), restored = decimal(converted)
if (restored.coefficient * 10n ** BigInt(places) !== minor * 10n ** BigInt(restored.scale)) throw new Error('换算金额无法以数字安全表示，请减小金额或汇率')
const result = { amount: args.amount, from: args.from, to: args.to, rate: args.rate, converted, formatted: text + ' ' + args.to, rateSource: 'provided', note: '汇率由用户提供，未获取实时行情。' }
process.stdout.write(JSON.stringify({ result }) + '\n')
`), [
    { name: '指定汇率', tool: 'convert', args: { amount: 100, from: 'USD', to: 'CNY', rate: 7.28 }, expected: { amount: 100, from: 'USD', to: 'CNY', rate: 7.28, converted: 728, formatted: '728.00 CNY', rateSource: 'provided', note: '汇率由用户提供，未获取实时行情。' } },
    { name: '小数进位', tool: 'convert', args: { amount: 1.005, from: 'USD', to: 'CNY', rate: 1 }, expected: { amount: 1.005, from: 'USD', to: 'CNY', rate: 1, converted: 1.01, formatted: '1.01 CNY', rateSource: 'provided', note: '汇率由用户提供，未获取实时行情。' } },
    { name: '乘法后的小数进位', tool: 'convert', args: { amount: 1.005, from: 'USD', to: 'CNY', rate: 3 }, expected: { amount: 1.005, from: 'USD', to: 'CNY', rate: 3, converted: 3.02, formatted: '3.02 CNY', rateSource: 'provided', note: '汇率由用户提供，未获取实时行情。' } },
    { name: '日元取整', tool: 'convert', args: { amount: 1, from: 'USD', to: 'JPY', rate: 152.5 }, expected: { amount: 1, from: 'USD', to: 'JPY', rate: 152.5, converted: 153, formatted: '153 JPY', rateSource: 'provided', note: '汇率由用户提供，未获取实时行情。' } },
    { name: '零金额', tool: 'convert', args: { amount: 0, from: 'USD', to: 'CNY', rate: 7.28 }, expected: { amount: 0, from: 'USD', to: 'CNY', rate: 7.28, converted: 0, formatted: '0.00 CNY', rateSource: 'provided', note: '汇率由用户提供，未获取实时行情。' } },
  ], '发布后从插件列表打开即可操作。title 是原生字段标签，enum 提供币种选项，required 标记必填。汇率必须明确由用户提供，不把示例数字说成实时汇率；联网汇率需要额外实现真实数据源、时间和失败处理。\n\n请保留本模板的十进制整数乘法与四舍五入算法、同币种汇率必须为1的校验，以及安全金额范围校验。浮点乘法后加 Number.EPSILON 不能保证金额精度，例如 1.005 × 3 必须得到 3.02。复用模板并保留全部业务案例；如增加反向汇率或展示文本，不要替换已验证的计算核心。还需实际验证同币种rate=2、金额1e12且rate=1e6会报错，不要把错误结果包装成成功。'),
]

const timer = template({ id: 'desktop-timer', name: '桌面计时器', description: '自定义插件页面、导航、会话标签与服务托盘的完整示例。' }, {
  apiVersion: 1, id: 'my-desktop-timer', name: '计时器', version: '1.0.0', description: '在应用打开期间倒计时，完成后显示服务通知。', runtime: 'node',
  tools: [
    { name: 'start_timer', description: '校验倒计时并返回宿主需要保留的截止时间。', entry: 'main.mjs', inputSchema: { type: 'object', properties: { seconds: { type: 'integer', title: '秒数', minimum: 1, maximum: 86400 }, now: { type: 'integer', minimum: 0, maximum: 8640000000000000 } }, required: ['seconds', 'now'], additionalProperties: false } },
    { name: 'stop_timer', description: '停止当前倒计时。', entry: 'main.mjs', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  ],
  contributes: {
    pages: [{ id: 'timer', title: '计时器', kind: 'webview', entry: 'ui/index.html', tools: [] }],
    navigation: [{ id: 'timer', title: '计时器', page: 'timer', icon: 'clock-outline', order: 80 }],
    workspaceTabs: [{ id: 'timer', title: '计时器', page: 'timer', icon: 'clock-outline', scope: 'session', when: { session: true } }],
    services: [{ id: 'countdown', title: '计时器', tool: 'start_timer', stopTool: 'stop_timer', page: 'timer' }],
  },
}, String.raw`try {
  let raw = ''; for await (const chunk of process.stdin) raw += chunk
  const { tool, args } = JSON.parse(raw)
  if (tool === 'stop_timer') console.log(JSON.stringify({ result: { status: 'stopped', detail: '已停止' } }))
  else if (tool === 'start_timer') {
    if (!Number.isSafeInteger(args.seconds) || args.seconds < 1 || args.seconds > 86400 || !Number.isSafeInteger(args.now) || args.now < 0) throw new Error('计时参数无效')
    console.log(JSON.stringify({ result: { status: 'running', detail: args.seconds + ' 秒倒计时', completesAt: args.now + args.seconds * 1000 } }))
  } else throw new Error('Unknown tool')
} catch (error) { console.error(error.message); process.exitCode = 1 }
`, [
  { name: '开始一分钟', tool: 'start_timer', args: { seconds: 60, now: 1000 }, expected: { status: 'running', detail: '60 秒倒计时', completesAt: 61000 } },
  { name: '停止', tool: 'stop_timer', args: {}, expected: { status: 'stopped', detail: '已停止' } },
], '这是可运行的自定义 HTML 页面与宿主服务示例。页面可用 $AE 或兼容的 window.aetherPlugin 服务桥；服务由宿主保留而不是依赖页面挂载。应用退出、切换引擎、停用插件或替换发布版本会结束本次服务，不提供跨重启系统提醒。')
timer.files['ui/index.html'] = String.raw`<style>
body{padding:28px;box-sizing:border-box;background:Canvas;color:CanvasText}main{max-width:560px;margin:auto}h1{font-size:24px;letter-spacing:-.4px;margin:0 0 8px}p{opacity:.65;margin:0 0 28px}form{display:flex;gap:10px;align-items:end}label{display:flex;flex-direction:column;gap:7px;flex:1}input,button{min-height:34px;border:1px solid color-mix(in srgb,CanvasText 18%,transparent);border-radius:7px;padding:0 12px;background:Canvas;color:CanvasText}button[type=submit]{background:Highlight;color:HighlightText;border-color:transparent}output{display:block;font-size:42px;font-variant-numeric:tabular-nums;margin:32px 0 10px}small{opacity:.65}button:disabled{opacity:.45}@media(max-width:420px){form{flex-wrap:wrap}}
</style><main><h1>计时器</h1><p>应用打开期间计时。离开此页面，计时仍会继续。</p><form id="timer"><label>秒数<input id="seconds" type="number" min="1" max="86400" value="60" required></label><button type="submit">开始</button><button id="stop" type="button">停止</button></form><output id="state" aria-live="polite">就绪</output><small id="detail"></small></main><script>
const state=document.getElementById('state'), detail=document.getElementById('detail'), start=document.querySelector('[type=submit]'), stop=document.getElementById('stop');
const labels={idle:'就绪',waiting:'正在启动…',running:'计时中',completed:'时间到',stopped:'已停止',error:'未能完成'};
function render(services){const service=services.find(item=>item.id.includes(':countdown'));if(!service)return;state.textContent=labels[service.status]||service.status;detail.textContent=service.detail||'';stop.disabled=!['running','waiting'].includes(service.status)}
aetherPlugin.services.subscribe(render);aetherPlugin.services.get().then(render).catch(error=>{detail.textContent=error.message});
document.getElementById('timer').addEventListener('submit',async event=>{event.preventDefault();start.disabled=true;try{render(await aetherPlugin.services.start('countdown',{seconds:Number(document.getElementById('seconds').value),now:Date.now()}))}catch(error){state.textContent='未能启动';detail.textContent=error.message}finally{start.disabled=false}});
stop.addEventListener('click',async()=>{try{render(await aetherPlugin.services.stop('countdown'))}catch(error){detail.textContent=error.message}});
</script>`
templates.push(timer)

const review = template({ id: 'session-review', name: '会话 AI 分析', description: '完整 SDK 脚手架：当前会话消息、单选多选、平台模型分析、设置和报告导出。' }, {
  apiVersion: 1, id: 'my-session-review', name: '会话质量校验', version: '1.0.0', description: '直接选择当前会话消息并调用平台已配置模型分析，无需再次填写密钥。', runtime: 'node',
  permissions: { requested: ['session.read', 'models.read', 'ai.run', 'settings.read', 'settings.write'] },
  tools: [{ name: 'prepare_review', description: '整理待分析文本，实际 AI 分析通过页面的 $AE.ai.stream 实时显示。', entry: 'main.mjs', inputSchema: { type: 'object', properties: { text: { type: 'string', maxLength: 10000 } }, required: ['text'], additionalProperties: false } }],
  contributes: { pages: [{ id: 'review', title: '会话质量校验', kind: 'webview', entry: 'ui/index.html', tools: [] }],
    workspaceTabs: [{ id: 'review', title: '会话校验', page: 'review', icon: 'check-circle-outline', scope: 'session', when: { session: true } }] },
}, entry('prepare_review', `if (typeof args.text !== 'string') throw new Error('text is required')
const result = { text: args.text.trim() }
process.stdout.write(JSON.stringify({ result }) + '\\n')`), [
  { name: '保留分析内容', tool: 'prepare_review', args: { text: '  用户需求与助手交付  ' }, expected: { text: '用户需求与助手交付' } },
], '开发模式直接打开工程目录，修改 ui/index.html 后刷新。用户授权后页面调用 $AE.session.messages / models.list / ai.stream，边生成边显示并支持停止；设置保存在插件自身作用域。Node 案例仅验证文本预处理，AI 与页面必须在客户端额外验收。')
review.files['ui/index.html'] = sessionReviewHtml
templates.push(review)

for (const item of templates) {
  item.files['aether-sdk.d.ts'] = pluginSdkTypes
  item.files['QUICKSTART.md'] = Object.entries(PLUGIN_SDK_QUICKSTART).map(([name, value]) => `## ${name}\n\n${value}`).join('\n\n') + '\n'
}

export function listPluginTemplates(): PluginTemplateSummary[] {
  return templates.map(({ id, name, description }) => ({ id, name, description }))
}

export function getPluginTemplate(id: string): PluginTemplate {
  const found = templates.find(item => item.id === id)
  if (!found) throw new PluginError('PLUGIN_TEMPLATE_NOT_FOUND', '插件模板不存在', 404)
  return structuredClone(found)
}
