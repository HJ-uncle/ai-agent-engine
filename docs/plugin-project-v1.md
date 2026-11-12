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

AI 先调用 `plugin_get_template` 发现模板和理解协议。需求匹配时直接使用 `plugin_create({templateId:"currency-converter",id:"my-currency",name:"货币换算器"})`，由宿主复制完整实现和案例，不需要读取后重新抄写源码。`templateId` 是内置模板 ID，`id` 是新插件 ID，可选 `name` 和 `description` 修改元数据；算法和业务测试保持原字节。准备批准时解析成完整 manifest/files 并封存，批准后不重新读取模板，避免中途模板变化。

只有模板不适用或需要自定义实现时才提交完整 `{manifest,files}`。两种输入互斥，未知模板或混传明确拒绝，不静默回退。已有独立本地工程通过导入流程安装。测试可一次提交 `cases:[{name,tool,args,expected}]`，一组确认后顺序执行同一修订。仅在业务断言通过后发布，不把诊断探针当交付版；保留具体操作审批。

复用模板时保留已验证的核心实现和边界案例，不因改名称或增加展示字段重写计算算法。货币模板使用十进制整数运算，包含 `1.005 × 3 = 3.02`；浮点乘法后加 `Number.EPSILON` 不能替代它。同币种错误汇率、非法输入和超大结果也应实际验证，普通整数用例通过不足以证明金额精度正确。

前端「新建插件」从同一个模板 API 选择基础工程。保存后可测试、发布和导出 ZIP。导出的是明确的保存修订，返回 SHA-256；包中包含完整工程文件，不携带数据库记录。原生 ZIP 可以再次预览、安装和运行。带适配器安装依赖的 Remark 插件当前应使用原 GitHub 来源重装，导出接口会明确拒绝缺依赖的原生伪包。

## 发布后直接操作

已发布并启用的工具插件在插件列表点击即可打开原生操作页，开发配置通过单独的编辑入口进入。操作页按发布清单的 `inputSchema` 生成字段，不运行包内任意 HTML：`title` 为字段标签，`description` 为说明，`enum` 提供选项，`required`、`minimum` 等约束输入。复杂数组/对象可以通过高级 JSON 参数填写。作者应提供中文标题、有限选项和确定性示例，避免用户手写完整协议。

首次打开 `GET /plugins/runtime/apps/:id?revision=N`，可省略 revision 以获取当前发布修订；返回固定 revision/hash、manifest、合法示例和执行许可，不返回源码与本机路径。提交使用 `POST /plugins/runtime/apps/:id/invoke`，必须传 `{revision,tool,args}`，每次重新验证发布、启用和快照内容；更新发布不会替换已打开页面的版本。结果和产物在操作页预览，不写入工作区。安全模式阻止未受约束的插件执行，客户端不能通过请求指定模式来绕过。

手动操作页和 Agent 会话的选用范围分别处理。创建/发布响应返回精确 `toolNameMap`、`globalToolNames`、`selectionId`；全局工具名会把 ID 的连字符换成下划线。发布不会给正在执行的请求自动增加工具，管理流程用 `plugin_test` 验收；用户选择插件标签后，后续请求才能调用该版本的工具。已有本地工程可通过 `plugin_import_preview({type:"local",path})` → `plugin_import_install` 导入，无需把源码再次逐字复录进 `plugin_create`。

## 尚未提供的扩展契约

这一版提供宿主原生操作表单及固定版本调用接口；尚未提供作者自定义 HTML/React 页面、Client slots、持久状态 API、`activate/dispose` 常驻生命周期、后台调度或配置/secret 服务。时间计算模板不能冒充「点击开始、后台到时提醒」的定时器。

交互型插件需要单独定义 Host/Client 入口、可调用权限、配置、状态、事件、清理和重启恢复协议，再实现宿主。独立 HTML 是文件产物；管理页能编辑代码也不等于插件有自己的操作页面。这些能力不能仅靠添加模板伪造。
