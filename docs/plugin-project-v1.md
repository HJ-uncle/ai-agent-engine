# Aether Tool Plugin v1 工程规范

适用范围：`apiVersion: 1`、`runtime: "node"` 的自包含工具插件。它不是通用插件行业标准，也不是 DeepSeek Harness/Cordis、VS Code 或 MCP 的包协议。其他宿主只有实现本协议或提供适配器后才能安装；纯 Node 可直接执行工具源码与随包用例。

## 工程结构与唯一清单

```text
my-plugin/
├── aether-plugin.json       # 工具声明、参数 Schema、入口
├── main.mjs                 # Node ESM 入口，可拆分多个 tools/*.mjs
├── README.md                # 用途、输入输出、限制、运行方式
├── package.json             # private 项目、Node 版本与 npm test
├── scripts/test.mjs         # 独立测试驱动，仅依赖 Node 内置模块
└── examples/cases.json      # 确定性业务用例和预期结果
```

前三者和示例/测试是官方模板的统一结构。运行时最低要求是根清单和清单指向的 `.mjs` 文件；自包含模块、样式及文档可放进相对目录。推荐把使用许可写入 `LICENSE.md`。包里不携带租户记录、会话、机器绝对路径、凭据或已安装的依赖目录。

`aether-plugin.json` 是分发工程唯一的清单。管理 API 的 `manifest` 是编辑权威，保存时同步包内同名清单，导出时重新生成，避免列表显示一版、ZIP 导入另一版。前端在「工具清单」中编辑它。

```json
{
  "apiVersion": 1,
  "id": "text-helper",
  "name": "文本工具",
  "version": "1.0.0",
  "description": "统计 Unicode 字符数",
  "runtime": "node",
  "tools": [{
    "name": "count",
    "description": "统计文本字符数",
    "inputSchema": {
      "type": "object",
      "properties": {"text": {"type": "string"}},
      "required": ["text"],
      "additionalProperties": false
    },
    "entry": "main.mjs"
  }]
}
```

`id` 使用小写字母、数字和单连字符，首尾字母或数字，最多 48 字符；工具名以小写字母开头，后续可有数字或下划线，最多 32 字符。全局工具名 `plugin_<id>_<tool>` 将 ID 中连字符转为下划线，总长不能超过 64。`version` 是作者版本，建议使用 SemVer；平台 `revision` 是保存次数，二者不同。

路径一律 `/` 分隔的相对路径，禁止目录穿越、绝对路径、链接、大小写冲突和 Windows 保留名。源码最多 100 文件、单文件 1 MiB、合计 8 MiB。参数 Schema 为有界 draft-07 子集；`$ref`、`pattern`、`format` 等限制见 [插件说明](plugins.md)，复杂校验在插件代码中做。

## 运行协议

1. 宿主以 Node 执行工具入口，**写入一个 UTF-8 JSON 请求后关闭 stdin**。
2. 请求为 `{tool,args}`，`tool` 是本地名 `count`，不是全局名，也不会偷偷通过 argv 或环境变量再传一份。
3. 插件读到 EOF，执行并输出最终 JSON：`{result,artifacts?}`。普通日志写 stderr。
4. 错误写 stderr 并设置非零退出码。顶层 `{error:"说明"}` 或 `{error:{code,message}}` 也会被认定失败；不要把缺参数、诊断信息包装为成功结果。
5. `result` 可以是任意业务 JSON；平台不会猜测嵌套 `result.ok=false` 的业务含义。作者必须用预期值断言功能，不能把「进程退出 0」当成功验收。

```js
try {
  let input = ''
  process.stdin.setEncoding('utf8')
  for await (const chunk of process.stdin) input += chunk
  const { tool, args } = JSON.parse(input)
  if (tool !== 'count' || typeof args?.text !== 'string') throw new Error('Invalid count request')
  console.log(JSON.stringify({ result: { count: [...args.text].length } }))
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
```

读取流前设置 UTF-8 解码，可保留跨数据块的中文和 emoji；不要对每个 Buffer 单独隐式转换后拼接。

用例文件：

```json
{"cases":[{"name":"Unicode 字符","tool":"count","args":{"text":"你好🍎"},"expected":{"count":3}}]}
```

`expected` 精确匹配 `result`；可选 `artifacts` 精确匹配产物数组。默认不把产物预览写入工作区。Node 子进程隔离生命周期与故障，不是操作系统权限沙箱。独立工程测试也会执行作者源码，不授予 Aether 服务或平台凭据。

## 官方模板和脚手架

统一模板来自引擎 `src/plugins/templates.ts`，前端、AI 工具和 CLI 共用：

HTTP 目录为 `GET /plugins/project/templates`，完整工程为 `GET /plugins/project/templates/:id`。导出保存修订使用 `GET /plugins/project/exports/:id?revision=N`，返回 `data.archive`（fileName、base64、sha256、revision）。工程接口使用三段或四段路径，保留所有有效插件 ID（包括 `templates`、`imports`、`project`）在 `GET /plugins/:id` 的访问与管理，不需要改名或迁移。

| 模板 ID | 用途 | 业务验证 |
|---|---|---|
| `json-tool` | 文本规范化和 JSON 返回 | 空白、Unicode、空字符串 |
| `markdown-report` | 生成文档产物 | 报告内容、相对文件路径 |
| `time-calculator` | 确定性 UTC 时间运算 | 跨日、负偏移、闰日 |
| `currency-converter` | 货币换算与原生操作表单，用户提供汇率 | 指定汇率、小数进位、日元取整、零金额 |
| `desktop-timer` | 自定义 HTML、导航、会话工作区标签、宿主服务 | 确定性截止时间、停止；桌面打开期间完成通知 |

在引擎仓库中：

```powershell
npx tsx scripts/plugin-project.ts templates
npx tsx scripts/plugin-project.ts init D:/dev/my-plugin json-tool my-plugin
npx tsx scripts/plugin-project.ts check D:/dev/my-plugin
npx tsx scripts/plugin-project.ts test D:/dev/my-plugin
npx tsx scripts/plugin-project.ts pack D:/dev/my-plugin D:/dev/my-plugin.zip
```

`init` 不覆盖现有目录。`check` 和 `pack` 不执行插件。`test` 逐个执行用例，结果不符合预期则以非零状态退出。ZIP 必须输出到工程目录外，且不覆盖已有文件。

独立工程在 Node 22+ 环境下，不需要 Aether、API key 或下载 npm 依赖：

```powershell
cd D:/dev/my-plugin
npm test
```

该运行证明覆盖纯 Node 业务协议，不表示能安装到任意其他产品，也不替代 Electron 嵌入式宿主验收。

独立 `npm test` 只依赖 Node，验证确定性业务结果、可选产物精确值和基本协议。它不复刻宿主的 JSON Schema、产物路径与大小验证；通过后仍需引擎 `check`、`test` 或管理页测试验证宿主约束。测试超时或运行失败时，驱动会尝试清理本次拥有的进程树并有界等待；清理失败会明确报错，不会无限等待继承的输出管道。主动脱离进程树或直接写文件等副作用仍不属于沙箱保证。

## AI 创建与手动创建

### 桌面批量导入

插件页的「ZIP 文件」支持多选和插件总包。原生总包在 `plugins/` 下放置单插件 ZIP；例如本次交付的 `aether-real-world-plugins.zip` 可直接选择，无需先逐个解压。只展开一层，不递归导入嵌套总包。说明、证据和截图不作为插件安装。

客户端先逐个上传预览，再显示可勾选的紧凑列表；只有选中的有效作业会按顺序安装为草稿，发布仍是独立操作。已存在 ID 不覆盖，同批重复 ID 保留首个有效候选并跳过后续项。单项失败不回滚已成功项，重试沿用原作业；网络异常先核对作业状态，避免重复安装。重新选择、重做预览或退出时释放已知未安装作业的暂存源码。

`POST /plugins/imports/preview-batch` 接受现有 `PluginImportInput`，可附 `maxPlugins:1..20` 表示剩余额度，返回 `{imports:[{fileName,import?,error?}]}`；作业不包含源码 `files`。顶层结构或预算错误拒绝整份上传，合法总包内某个插件失败则保留其错误并继续其他项。安装仍使用 `/plugins/imports/:jobId/install`，单插件原预览接口保持兼容。

桌面每批最多 20 个插件、20 个文件，总上传文件大小不超过 50 MiB，单个 ZIP 不超过 20 MiB。引擎先检查完整 ZIP 目录、路径、类型和字节预算，再按需解压插件条目；外层与所有子包的累计声明展开字节分别不超过 64 MiB，子包目录合计最多 4096 项。

AI 先调用 `plugin_get_template` 发现模板和理解协议。需求匹配时直接使用 `plugin_create({templateId:"currency-converter",id:"my-currency",name:"货币换算器"})`，由宿主复制完整实现和案例，不需要读取后重新抄写源码。`templateId` 是内置模板 ID，`id` 是新插件 ID，可选 `name` 和 `description` 修改元数据；算法和业务测试保持原字节。准备批准时解析成完整 manifest/files 并封存，批准后不重新读取模板，避免中途模板变化。

只有模板不适用或需要自定义实现时才提交完整 `{manifest,files}`。两种输入互斥，未知模板或混传明确拒绝，不静默回退。已有独立本地工程通过导入流程安装。测试可一次提交 `cases:[{name,tool,args,expected}]`，一组确认后顺序执行同一修订。仅在业务断言通过后发布，不把诊断探针当交付版；保留具体操作审批。

大工程通过管理工具读取时不会把整份源码塞进一个回执。`plugin_get_template` 和 `plugin_get` 在结果超过当前工具输出预算时返回目录；使用 `section:"manifest"` 读取清单、`section:"files"` 读取文件表、`section:"file",file:"ui/index.html"` 读取源码、`section:"protocol",protocol:"uiBridge"` 读取单项协议。每页包含 `content`、`offset`、`nextOffset`、`totalChars`、`revision`；拼接全部 `content`，直到 `nextOffset:null`。后续页携带同一 `revision` 和返回的 `nextOffset`，版本变化时从头读取。`format:"json"` 的内容在拼接后解析；`format:"text"` 是原文。`maxChars` 是期望的原文长度，实际会按 JSON 转义后的回执大小缩小，不能突破调用预算。

局部修改显式使用 `plugin_update({id,expectedRevision,fileMode:"merge",files:{"ui/index.html":"完整新源码"}})`。未列出的文件保留；可省略 `manifest` 沿用当前清单，也可提供完整新清单；`deleteFiles` 显式列出要删除的已有文件。宿主在审批前把增量合并为完整且已校验的源码快照，批准后只执行该快照；期间修订或更新时间发生变化则拒绝，不会将修改套到另一版工程。默认 `fileMode:"replace"` 仍要求完整 `manifest/files`，未提交文件会移除，不能把只读目录或截断内容当成完整工程。

创建和编辑的审批展示插件名称、版本，以及真实新增、修改、删除文件的 UTF-8 字节数与 SHA-256；不在确认文字中重复整份源码。文件表超出展示预算时明确给出全部变更数量、已显示条目和省略数量。完整源码仍封存在同一待批准操作内，确认展示不改变执行内容。导入审批继续保留真实来源、固定导入作业和依赖安装要求。

`plugin_create`、`plugin_update`、`plugin_import_install`、`plugin_publish`、`plugin_set_enabled` 的写入结果只返回紧凑元数据，不回显源码、输入 Schema 或整个修订历史。回执包含当前修订与 hash、启用和发布状态，以及可容纳的准确工具映射。工具映射超过本次输出预算时返回 `toolNamesComplete:false` 和 `read` 指针，通过 `plugin_get` 的 `section:"metadata"` 分页取得完整映射；源码仍通过 `section:"file"` 读取。已完成的写入不会因为回执缩小而重新执行。

`examples/cases.json` 中的参数必须是可直接运行的字面 JSON，不能依赖测试脚本私有的 `$sample` 占位替换；`expected` 是完整业务 `result`，不是字段子集。预期失败的非法输入用例放在独立测试脚本中，不能冒充客户端可直接执行的成功示例。独立测试、宿主参数验证、实际客户端操作和落盘导出应分别验收。

复用模板时保留已验证的核心实现和边界案例，不因改名称或增加展示字段重写计算算法。货币模板使用十进制整数运算，包含 `1.005 × 3 = 3.02`；浮点乘法后加 `Number.EPSILON` 不能替代它。同币种错误汇率、非法输入和超大结果也应实际验证，普通整数用例通过不足以证明金额精度正确。

前端「新建插件」从同一个模板 API 选择基础工程。保存后可测试、发布和导出 ZIP。导出的是明确的保存修订，返回 SHA-256；包中包含完整工程文件，不携带数据库记录。原生 ZIP 可以再次预览、安装和运行。带适配器安装依赖的 Remark 插件当前应使用原 GitHub 来源重装，导出接口会明确拒绝缺依赖的原生伪包。

### 批量导入预览

`POST /plugins/imports/preview-batch` 接收一个既有 `PluginImportInput`，另可传 `maxPlugins:1..20`（默认 20），表示本次允许创建的最大插件数量。前端逐文件提交，不能把多个 Base64 ZIP 拼进同一个请求。响应为 `data.imports:[{fileName,import?,error?}]`，其中 `import` 是不含 `files` 的完整导入作业摘要；子包失败独立显示，已经成功的子包仍可继续安装。原 `/plugins/imports/preview` 的单包响应保持不变。

普通 Native 或显式 Remark 包返回一项。根目录没有 `aether-plugin.json` 且包含 `plugins/<文件名>.zip` 的原生交付总包只拆一层；根清单存在时始终按普通插件处理。总包可同时携带根目录 `.md`/`.txt` 说明、`manifest.json`、`evidence/**/*.json` 和 `screenshots/**/*.(png|jpg|jpeg|webp)`；这些辅助文件只检查 ZIP 目录元数据，不解压、不安装。未知文件、危险路径、链接、重复路径、损坏外包和不符合预算的总包直接拒绝。

HTTP JSON 上限 32 MiB，单份二进制 ZIP 上限 20 MiB，最多 20 个插件。外层声明解压总量与所有子 ZIP 累计声明解压总量各不得超过 64 MiB，子 ZIP 累计条目数最多 4096。数量与累计预算在创建首个作业前校验；解压还有实际输出大小和 CRC 校验。请求取消后停止后续预览，并清理本次已准备作业的暂存源码。每个作业继续使用现有租户隔离的查询、取消和安装接口；批量预览本身不安装、执行或发布插件。

## 发布后直接操作

已发布并启用的工具插件在插件列表点击即可打开原生操作页，开发配置通过单独的编辑入口进入。原生操作页按发布清单的 `inputSchema` 生成字段：`title` 为字段标签，`description` 为说明，`enum` 提供选项，`required`、`minimum` 等约束输入。复杂数组/对象可以通过高级 JSON 参数填写。作者应提供中文标题、有限选项和确定性示例，避免用户手写完整协议。需要自定义页面时通过 `manifest.contributes.pages` 声明包内 `.html`，由独立沙箱 iframe 与受限 bridge 承载，详见 [插件前端贡献协议](plugin-ui-contributions.md)。

首次打开 `GET /plugins/runtime/apps/:id?revision=N`，可省略 revision 以获取当前发布修订；返回固定 revision/hash、manifest、合法示例和执行许可，不返回源码与本机路径。提交使用 `POST /plugins/runtime/apps/:id/invoke`，必须传 `{revision,tool,args}`，每次重新验证发布、启用和快照内容；更新发布不会替换已打开页面的版本。结果和产物在操作页预览，不写入工作区。安全模式阻止未受约束的插件执行，客户端不能通过请求指定模式来绕过。

手动操作页和 Agent 会话的选用范围分别处理。创建/发布响应返回精确 `toolNameMap`、`globalToolNames`、`selectionId`；全局工具名会把 ID 的连字符换成下划线。发布不会给正在执行的请求自动增加工具，管理流程用 `plugin_test` 验收；用户选择插件标签后，后续请求才能调用该版本的工具。已有本地工程可通过 `plugin_import_preview({type:"local",path})` → `plugin_import_install` 导入，无需把源码再次逐字复录进 `plugin_create`。

## 尚未提供的扩展契约

这一版提供宿主原生操作表单、固定版本调用、自定义沙箱 HTML、导航/工作区标签及宿主服务状态。`desktop-timer` 模板展示页面关闭后由宿主继续计时、完成通知的流程；它要求桌面应用保持打开，停用/升级/连接切换会清理计时。

目前不提供作者任意宿主 React 导入、持久状态 API、插件自定义 `activate/dispose` 常驻 Node 生命周期、跨重启服务恢复、关闭应用后的后台调度或配置/secret 服务。独立 HTML 文件产物不等同于 `contributes.pages` 的应用内页面，时间计算模板也不等同于计时服务。能力目录、页面 bridge 与生命周期限制由模板 API 同源返回，作者不得宣称未提供的能力。
