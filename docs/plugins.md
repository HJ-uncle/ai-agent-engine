# 自定义插件

工程目录、入口协议、跨平台边界和模板创建步骤见 [Aether Tool Plugin v1 工程规范](plugin-project-v1.md)。AI 使用 `plugin_get_template` 发现并理解模板，匹配时直接提交 `plugin_create({templateId,id,name?,description?})`，宿主生成并在批准前封存完整工程，避免模型复录时重写算法；自定义源码 `{manifest,files}` 与模板输入互斥。手动新建与命令行也共用官方模板。模板包含独立的 `npm test`，不依赖 Aether 才能验证业务结果。

Work 导航的「插件」页负责创建、编辑、测试、发布、启停、删除和导入。进入页面读取一次，刷新使用工具栏图标。

已发布启用的插件点击列表行即可打开原生操作页，输入参数并运行，无需先在聊天里 @。输入字段来自固定发布修订的 Schema，编辑入口独立显示。手动调用通过 `/plugins/runtime/apps/:id` 与 `/:id/invoke`，不复用可运行草稿的开发测试接口；结果和文件产物只预览。`manifest.contributes` 还可声明导航、工作区标签、自定义沙箱 HTML 页面和宿主服务，详见 [插件前端贡献协议](plugin-ui-contributions.md)。货币换算模板提供中文字段、币种下拉和用户指定汇率，不内置虚构的实时行情。

`@插件管理` 让 AI 使用同一管理服务创建和修改插件。源码变更、测试运行、发布和安装均通过可恢复的具体操作确认。`@某插件` 将该插件已发布版本的工具加入当前会话；普通会话不会自动加载全部插件工具。

## 原生包

目录或 ZIP 中包含 `aether-plugin.json` 和源码。例如：

```json
{
  "apiVersion": 1,
  "id": "text-helper",
  "name": "文本助手",
  "version": "1.0.0",
  "description": "统计文本长度",
  "runtime": "node",
  "tools": [{
    "name": "count",
    "description": "统计 Unicode 字符数量",
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

`main.mjs`：

```js
let input = ''
process.stdin.setEncoding('utf8')
for await (const chunk of process.stdin) input += chunk
const { args } = JSON.parse(input)
console.log(JSON.stringify({ result: { count: [...args.text].length } }))
```

每次调用启动独立 Node 进程，输入为一行 JSON `{tool,args}`。stdout 最后一行必须为 JSON；前面的普通日志不作为结果。建议返回 `{result,artifacts?}`，也接受普通 JSON。模块仅有 `export default` 不会被调用。

宿主写入后关闭 stdin，`tool` 是清单中的本地工具名。流读取前设置 UTF-8 解码，保留跨数据块的中文与 emoji。异常应输出 stderr 并非零退出；没有 `result` 的顶层 `{error:"说明"}` 或 `{error:{code?,message:"说明"}}` 被当作失败。任意业务 `result` 不会被猜测为成功或失败，必须断言结果。`plugin_test` 支持 `cases:[{name,tool,args,expected}]` 批量验收同一修订，避免逐个工具触发确认。Electron 嵌入式宿主启动插件时会显式保留 Node 运行模式。

`inputSchema` 在保存与执行前校验，采用有界的 JSON Schema draft-07 子集，不改变传入参数。本期不支持 `$ref`（包括本地引用）、`pattern`、`patternProperties`、`format`、`uniqueItems:true` 和异步校验；这些复杂校验可在插件子进程内实现。Schema 上限为 64 KiB，并限制深度、节点和组合分支。

产物为 `{path,content,encoding?:"utf8"|"base64"}` 数组。路径使用工作区相对路径，产物通过引擎现有文件变更账本写入，可回退；不会覆盖已有文件。测试按钮只返回产物预览，不将其写入工作区。插件直接使用 Node 文件 API 或网络产生的副作用不属于这条产物协议，也不能由聊天回退自动撤销。

## 生命周期与存储

- 创建和编辑保存草稿，新建不可变 revision。
- 发布验证当前 revision、封存内容哈希并启用，旧发布版保留。
- 安装、启用、当前会话选用分别管理。导入成功首先得到未启用草稿，仍需测试和发布。
- 会话工具包 ID 为 `plugin-<id>--r<revision>`；同一会话只能选择同一插件的一个版本。更新发布不会替换正在执行任务的代码。
- 停用阻止后续调用，删除移除插件源码和版本，不删除工作区产物。
- 插件位于 `dirname(DATA_DIR)/plugins/tenant-<hash>/`。源码、快照、依赖、导入作业都落磁盘；SQLite 不存插件源码。运行进程和并发计数为内存状态。
- 自包含原生插件可从详情导出固定修订 ZIP，再在另一实例导入。带适配器依赖的插件仍使用原 GitHub 来源重装，当前不会导出缺依赖的原生包。

## 导入范围

原生格式支持本地目录、ZIP/base64、GitHub 仓库及子目录。GitHub 导入解析 ref 并固定 commit，再检查归档路径、符号链接、大小、文件数和清单。预览不运行代码。

另外支持 **Remark 插件适配**：将仓库 JavaScript 源码封存于 vendor 目录，用独立进程中的 unified/remark 管线执行 `process_markdown`，返回 Markdown 和 AST。依赖安装仅发生在安装阶段，禁用 npm 生命周期脚本，依赖树与 lockfile 随 revision 校验。不是任意 GitHub 仓库、VS Code 扩展、Cordis bundle 或 MCP 服务都能直接导入。

导入作业有持久 ID，支持查询和取消。安装成功后的重复提交返回原安装记录；安装阶段失败可以重试。预览失败会返回可查询的失败作业 ID。

## 执行边界

独立进程用于隔离故障和限制生命周期，**不是操作系统沙箱**，插件代码仍以运行引擎的用户权限执行。因此安全模式拒绝未受约束的插件执行。默认限制包含 4 个并发进程/租户、60 秒、256 KiB 输入、2 MiB stdout、256 KiB stderr、128 MiB V8 堆；这些不是操作系统级总内存配额。

插件不继承 API key、NODE_OPTIONS、代理凭据等完整环境。原生插件不自动安装 npm 依赖，目前没有插件 secret 配置页、通用 MCP/Cordis 执行适配、市场自动更新或关闭应用后的后台调度。受支持格式和限制必须以实际运行回执为准。

## API 与验证

手动页面与 AI 共用 PluginService。`/api/v1/plugins` 提供 CRUD，`/:id/publish` 发布，`/:id/test` 测试；`/plugins/imports/preview`、`/:jobId/install`、查询与取消组成导入流程。会话目录由 `/api/v1/toolkits` 返回。

本地无认证部署支持本机用户管理；启用认证的远端部署要求 `admin` 或 `plugin-manager`。结构化工具包选择是授权入口，历史文本中出现 `@` 标签不授予工具。

定向回归：

```powershell
npm run typecheck
npx vitest run src/plugins/__tests__ src/api/http/routes/__tests__/session-toolkits-chat.test.ts src/storage/session/toolkits.test.ts
npm run build
```

真实实验脚本（会产生模型费用或联网安装，须明确授权）：

- `scripts/plugin-ai-acceptance.mjs --run`：本项目实际模型会话创建 5 个插件，其中 2 个各迭代 3 次，再通过选中插件的真实 AI 会话调用。
- `scripts/plugin-github-acceptance.ts`：3 个 GitHub Remark 插件导入、运行及重新加载验证。
- `scripts/plugin-adversarial-acceptance.ts`：2 个复杂原生插件经 ZIP/目录导入，验证精确产物、CSV、并发、回退及负例。

所有脚本使用独立 `PLUGIN_ACCEPTANCE_ROOT`，不删除真实数据，不重启当前 Aether。实验结果及失败记录位于各次执行目录，不应把脚本存在当作实验通过。

### 普通需求创建验收

`node scripts/plugin-natural-ai-acceptance.mjs --run` 单独验证用户只描述需求时的创建体验：模型收到“创建并发布时间助手，支持时长表达式转秒及两个 ISO 时间相差秒，做好测试”的普通请求，不额外注入插件协议、源码、schema、调用顺序或失败修复提示。模型可自行读取产品提供的模板、编写、测试和发布；批准只针对此次隔离任务创建的同一个插件。

脚本从当前桌面配置只读获取已配置模型，在独立目录、随机端口与独立实例令牌下启动 `electron.exe`，明确使用 `ELECTRON_RUN_AS_NODE=1`，并保存宿主运行时证明。总体运行上限为 18 分钟；凭据桥和会话请求另有限时，退出时关闭本次隔离进程。没有 `--run` 时不会创建目录、读取凭据或启动进程；实验应与桌面 E2E 串行进行。

`node scripts/plugin-natural-ai-acceptance.mjs --run --currency` 使用原句「请帮我创建一个自定义插件：做一个可操作的货币换算器」。独立检查真实 AI 调用及正式操作 API 的 728、1800、0、3.02，以及同币种错误汇率、超大结果和数值分位往返不一致的拒绝；任一失败整轮失败。证据区分模板列表、详情读取和宿主 `templateId` 创建，记录调用者是否提交源码、核心文件哈希及模型自测是否提供 `expected`，不把仅执行成功算作独立业务断言。

验收区分创建/发布与功能正确性、模板详情实际读取、批量测试实际执行三种结果。模型只做单次测试时，批量覆盖记录为 `missing`，不会据此把已通过的业务功能判为失败，也不会声称批量测试已通过。随后使用真实 AI 会话调用两个已发布工具，再由宿主执行保留样例，独立断言 6 个业务结果，包括反向和零时间差；保留样例必须匹配实际调用已验证的同一个输出字段。脱敏的模型调用、批准记录、源码、测试回执和 `report.json` 保存在本次独立验收目录。
