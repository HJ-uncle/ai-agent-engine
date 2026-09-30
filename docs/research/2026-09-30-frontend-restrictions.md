# Aether Code 前端限制清单与来源复核

日期：2026-09-30。审计对象仅为 `D:\dev\aether-code` 当前工作树；不把引擎后端的限制混写为前端限制。前端 HEAD 为 `f3aa70e`，包含既有未提交 D8/D9、全量测试修复和本轮远端令牌改动。本次只读审计产品代码，仅写本清单；未重新运行应用、未调用真实模型或外部服务。

**后续实施更新（优先于下文原阶段的远端只读描述）：** 普通远端聊天、新建、队列、审批回答、停止、压缩、润色、模型/思考选择已开放；模型新增/更新/连接测试/能力检测已接通。设置可填写令牌和远端绝对目录，空目录使用服务端沙箱；已有会话继承服务端目录。请求净化本地上下文、绑定引擎身份且禁止重定向，草稿与会话选择按来源隔离。真实 HTTP + Electron + read_file + 历史恢复 17/17 通过，全部测试及拓扑范围见[总览](D:/dev/ai-agent-engine/docs/research/2026-09-30-restrictions-index-and-remote-fix.md)。

仍未开放删除/截断式重试/回退、改动保留或撤回、安全模式写入、附件上传 UI、直接远端文件编辑/LSP/Git/CodeGraph。附件专用主进程入口已有 20 MiB 限制、逐文件确认与上传登记，但 renderer 接线未获自动审批，不能计作完整功能。原文“只读审计”描述清单形成时的取证方式，不表示后续没有产品代码变更。

最需要区分的是：**保护边界、容量上限、未实现功能和测试缺口是四种不同情况**。前三种在下文分别列出；测试全绿不意味着这些限制消失。数值容量按源码的 1024 进制称为 KiB/MiB。

## 来源判定方法

已用 `git log`、`git blame HEAD`、`git show d642ac9:<path>` 和当前 `git diff` 查证。D0–D6 报告记录实施起点为前端 `d642ac9`。不能按提交标题猜归属：例如 `564f3bd` 标题只提“变更回退”，实际提交包含运行时协议、远端限制和 D0–D6 多项改动。

- **既有**：D0 起点以前已存在。主要提交 `6f211d6`（2026-09-27 初始化）、`237fa81`（搜索排除）、`e4e71cd`（2026-09-28 Git 面板）、`55bbbc3`（mentions）、`562b68e`（2026-09-29 D0 起点前混合改动）。
- **D0–D9 新增**：代码与阶段报告可对应；注明提交或“未提交”。D0–D6 主要落在 `564f3bd`，D7 在 `f3aa70e`；D8/D9 尚为工作树改动，Git 无独立提交可归属，阶段归属由报告佐证。
- **本轮新增**：本轮远端令牌设置、加密存储和错误提示，尚未提交；不算 D0–D9 已完成历史。
- **来源无法确认**：可以确认当前状态，但不能从 Git 或阶段报告证明精确引入阶段；尤其“未实现”没有单一引入提交。

阶段佐证：[D0–D6](D:/dev/ai-agent-engine/docs/research/2026-09-29-d0-d6-implementation-status.md)、[D7](D:/dev/ai-agent-engine/docs/research/2026-09-29-d7-implementation-status.md)、[D8/D9](D:/dev/ai-agent-engine/docs/research/2026-09-29-d8-d9-implementation-status.md)。

## 1. 远端、协议与凭据

| 编号 | 当前明确限制 / 证据 | 实际影响 | 可否调整 | 来源 |
|---|---|---|---|---|
| R01 | 远端当前放行显式GET只读routes：health/meta/metrics；models及capability-defs、tools/system-tools/external-skills；conversation sessions/history；chat snapshot/status/runs/stream；changes/todos；security mode/policies；subagent runs/events；command-jobs/output；sessions binding。其他路径/非GET拒绝。[protocol.ts:85](D:/dev/aether-code/src/main/engine/protocol.ts:85) | **已可查看远端会话、改动、运行状态，连接成功仍不等于可执行聊天**。模型新增/修改/删除/测试、审批/停止/撤回等写操作、CodeGraph、工作区文件及诊断执行仍拒绝。HTTP本地409；SSE请求前error。 | 没有解除只读的设置。执行能力需共享工作区/身份合同；不能仅删除allowlist。 | 原窄allowlist为 **D1** `564f3bd`；只读能力扩展为 **本轮新增、未提交**。 |
| R02 | 非回环地址必须有实例 token；仅 `localhost`、`127.0.0.1`、`[::1]` 豁免。URL 只接受 HTTP(S)，拒绝 username/password。[protocol.ts:63](D:/dev/aether-code/src/main/engine/protocol.ts:63) | 裸 LAN 地址在握手前失败；URL 内 Basic Auth 不能用。接受 HTTP 并不等于具备 TLS 自动配置。 | 本轮可在设置→引擎保存 token；仍保留 `AETHER_IDE_REMOTE_INSTANCE_TOKEN` 迁移通道。此规则不应通过写入 URL 绕过。 | 规则 `f3aa70e`；D0身份合同的后续补充。**本轮**改错误提示及设置入口。 |
| R03 | 当前 token 是一份全局加密值，不按 remote URL 分组；存储值优先于环境变量。[host.ts:155](D:/dev/aether-code/src/main/engine/host.ts:155)、[remote-token.ts:6](D:/dev/aether-code/src/main/engine/remote-token.ts:6) | 多远端凭据配置尚未实现；UI已提示更换地址时替换/清除令牌，清除后仍会回退启动环境变量。 | 可手动替换/清除；多连接应做 URL→凭据关联。 | **本轮新增，未提交**。 |
| R04 | 存储和环境token统一去首尾空白，拒绝内部控制字符及HTTP头不支持字符，最多4096字符；safeStorage不可用时拒绝保存/解密。主进程只回传是否配置及来源，不回显秘密。[protocol.ts:77](D:/dev/aether-code/src/main/engine/protocol.ts:77)、[remote-token.ts:19](D:/dev/aether-code/src/main/engine/remote-token.ts:19)、[ipc.ts:137](D:/dev/aether-code/src/main/ipc.ts:137) | 跨OS账户拷贝加密文件可能不可解密。UI输入值仍会暂存renderer内存，但不会通过读取接口重新暴露。读取损坏时UI已提供重新输入/清除恢复。 | 长度可改代码；加密失败需恢复系统密钥存储或显式清除。保存锁避免重复提交，留空保留原值。 | **本轮新增，未提交**。 |
| R05 | manifest 要求有效版本、`sha256:<64hex>` buildId、`protocolVersion=1`、`subagentSchemaVersion=1`、包含 code profile；嵌入模式握手还核对期望 buildId。[protocol.ts:22](D:/dev/aether-code/src/main/engine/protocol.ts:22)、[runtime.ts:47](D:/dev/aether-code/src/main/engine/runtime.ts:47) | 非配套构建或旧引擎被拒；远端并非必须与本地同 buildId，但仍须符合 v1 manifest。 | 属升级合同；引擎和前端联动迁移，不能只提升一个常量。 | **D0 新增**，`564f3bd`。 |
| R06 | 所有桥接引擎请求固定 `X-Aether-Tool-Profile: code`。[tool-profile.ts:2](D:/dev/aether-code/src/main/engine/tool-profile.ts:2) | UI 可见引擎工具不代表 Agent 本轮会拿到整个引擎工具集；没有 profile 选择 UI。 | 可新增显式 profile 能力协商/设置，需评估非 coding 工具权限。 | **既有**，`562b68e`，早于 D0 起点。 |
| R07 | 普通 HTTP 请求固定 120 秒；仅接收 JSON 信封，HTTP成功且 `code=0/200` 才 ok；SSE 使用另一链路。[client.ts:20](D:/dev/aether-code/src/main/engine/client.ts:20) | 不支持桥接任意二进制下载、裸 JSON API或无限时长的普通请求。不能把 120 秒套到所有 SSE 聊天。 | 固定代码，可按路由设预算/下载协议。 | 120秒及严格信封为 **D0** `564f3bd`；基础 HTTP 桥既有。 |
| R08 | 启动 60秒；handshake合并健康/meta/认证探针共用5秒信号；健康轮询5秒、连续3次失败置错，每次健康请求3秒。[host.ts:24](D:/dev/aether-code/src/main/engine/host.ts:24)、[host.ts:243](D:/dev/aether-code/src/main/engine/host.ts:243) | 慢机器/高延迟远端可能被判启动或连接失败；不是可配置UI项。 | 可参数化；必须同步取消和生命周期测试。 | 启动/健康数值 **既有** `6f211d6`；认证握手 **D0** `564f3bd`。 |
| R09 | embedded 绑定 `127.0.0.1`；首选端口12323，可通过设置 preferredPort；端口占用选择可用端口，不 adopt 任意旧实例。[host.ts:197](D:/dev/aether-code/src/main/engine/host.ts:197)、[sdk/process-manager.ts:88](D:/dev/aether-code/src/main/engine/sdk/process-manager.ts:88) | 内置引擎不能直接作为 LAN 服务暴露；设置端口不是请求接管已有服务。 | 端口可配置；远端部署应独立启动引擎。 | 首选端口既有；owned实例/loopback绑定 **D0**。 |
| R10 | embedded ENCRYPTION_KEY 在 safeStorage 不可用时仍允许生成明文 key 文件；已加密文件解密失败则保留并拒绝启动。[secret-store.ts:24](D:/dev/aether-code/src/main/engine/secret-store.ts:24)、[secret-store.ts:43](D:/dev/aether-code/src/main/engine/secret-store.ts:43) | “所有密钥始终 OS 加密”不成立；这与本轮 remote-token 的强制加密策略不同。 | 可改为严格拒绝或明确开发配置，但需考虑已存模型解密/迁移。 | **D0 新增** `564f3bd`。 |

## 2. Renderer / IPC 的边界

| 编号 | 当前状态 / 证据 | 影响 | 可否调整 | 来源 |
|---|---|---|---|---|
| I01 | renderer 通过 preload 暴露的 `window.aether` 调主进程；`engineRequest` 接受 method/path/body，主进程 remote 检查生效，但 embedded 没有同等 API 路由 allowlist。[ipc.ts:84](D:/dev/aether-code/src/main/ipc.ts:84)、[preload/index.ts:36](D:/dev/aether-code/src/preload/index.ts:36) | 桥是通用引擎客户端，不是按每个用户UI动作授权的最小接口。 | 可收敛为按能力的 IPC 合同；需同步大量消费者。 | 通用桥 **既有**；remote校验 **D1**。 |
| I02 | `fsAllowRoot(root)` 可从 renderer 调用；路径白名单不能证明“只有原生目录选择框才能授权”。[ipc.ts:161](D:/dev/aether-code/src/main/ipc.ts:161)、[file-service.ts:93](D:/dev/aether-code/src/main/fs/file-service.ts:93) | 当前白名单更偏正常应用流程防误操作，不能单独作为已被攻陷renderer的强隔离证明；关闭项目亦未见清除所有旧授权根。 | 可将授权绑定原生选择或受控恢复记录，并提供撤销。 | allowRoot接口 **既有** `6f211d6`；realpath强化为后续未提交审计修复。 |
| I03 | PTY create不校验 cwd 白名单，write/resize/dispose按id；LSP dev允许传 serverEntry/nodePath；这些通道没有按调用窗口作统一授权。[ipc.ts:418](D:/dev/aether-code/src/main/ipc.ts:418)、[ipc.ts:442](D:/dev/aether-code/src/main/ipc.ts:442) | 引擎的 safe/standard 模式不覆盖整个本地 IDE 主进程；不能称为全局 OS 沙箱。没有在本轮执行攻击验证。 | 能做主进程参数验证/owner验证；需保留合法用户终端操作。 | PTY/LSP桥 **既有**；packaged LSP路径 **D9**。 |
| I04 | BrowserWindow显式 `sandbox:false`；未见所有 IPC 入口统一校验 sender URL/schema；窗口外链直接 `shell.openExternal(details.url)`。[index.ts:96](D:/dev/aether-code/src/main/index.ts:96)、[index.ts:108](D:/dev/aether-code/src/main/index.ts:108) | 不宜把 Electron 默认 context isolation 等同 Chromium进程沙箱或IPC强授权。 | 需专项加固与真机回归；本轮仅记录可见配置，未判定可利用漏洞。 | **既有** `6f211d6`。 |

## 3. 文件、编辑器与搜索

| 编号 | 明确限制 / 证据 | 实际影响 | 可否调整 | 来源 |
|---|---|---|---|---|
| F01 | 文本只载入前4MiB；`saveDocument`只拒绝binary/loading，**不拒绝truncated**；UI只有警告。[file-service.ts:24](D:/dev/aether-code/src/main/fs/file-service.ts:24)、[DocumentView.tsx:65](D:/dev/aether-code/src/renderer/src/contrib/editor/DocumentView.tsx:65)、[editor-store.ts:293](D:/dev/aether-code/src/renderer/src/core/editor/editor-store.ts:293) | 大文本编辑后保存可把原文件截为已载入内容。属明确的数据完整性缺口；D6引擎edit_file的hash保护不能覆盖它。 | 应先禁止截断文档写回，再做流式/大文件编辑；不是简单调大内存常量。 | **既有** `6f211d6`，blame已核对。 |
| F02 | 普通IDE写文件直接UTF-8写盘，无expectedHash/mtime前置条件；读入移除UTF-8 BOM。[file-service.ts:203](D:/dev/aether-code/src/main/fs/file-service.ts:203)、[file-service.ts:221](D:/dev/aether-code/src/main/fs/file-service.ts:221) | 外部进程修改后保存可能覆盖；BOM不能由普通保存路径原样保留。只支持UTF-8文本，没有编码选择器。 | 需版本检查、冲突对话与编码/EOL元数据。 | **既有** `6f211d6`。 |
| F03 | 二进制判断仅前8192bytes是否含NUL；上限32MiB，整份base64进内存；超过上限不预览。[file-service.ts:67](D:/dev/aether-code/src/main/fs/file-service.ts:67)、[file-service.ts:164](D:/dev/aether-code/src/main/fs/file-service.ts:164) | 无NUL的特殊二进制可能走文本；UTF-16可能走二进制；大视频/图片不能在内部预览。 | 固定代码，宜增加MIME/encoding识别与流式资源URL。 | **既有** `6f211d6`。 |
| F04 | 二进制UI只读；图片/视频/十六进制，默认hex前16KiB。[FilePreview.tsx:24](D:/dev/aether-code/src/renderer/src/contrib/editor/FilePreview.tsx:24)、[preview.ts:36](D:/dev/aether-code/src/renderer/src/core/editor/preview.ts:36) | 不具备PDF/Office页级编辑、二进制编辑或Notebook单元编辑器。 | 新增专门编辑器；附件能被引擎读取不等于前端能编辑。 | 只读预览 **既有**；未实现能力精确来源无法确认。 |
| F05 | 快速文件索引最多20000项；固定跳过node_modules/.git/dist/out/build/release/.vite/coverage，不跟随symlink的isFile/isDirectory分支。[file-service.ts:27](D:/dev/aether-code/src/main/fs/file-service.ts:27) | Ctrl+P和依赖此列表的mentions不能覆盖超额文件和跳过目录；不是资源管理器整树不显示。 | 固定代码；需分页/索引及明确配置，而非默认无限遍历。 | **既有** `6f211d6`。 |
| F06 | 文件/Git/搜索主路径受授权根约束；realpath检查阻止直接链接越界。[file-service.ts:103](D:/dev/aether-code/src/main/fs/file-service.ts:103) | 访问未授权项目须先打开/授权；不能将此与Agent full-access路径范围混为一谈。 | 根可由应用授权；不能用“关掉检查”代替多工作区。 | 根白名单 **既有**；realpath改动为未提交，精确D阶段**来源无法确认**。 |
| F07 | rename/copy不覆盖已存在目标；删除只送系统回收站，失败无永久删除降级。[file-service.ts:294](D:/dev/aether-code/src/main/fs/file-service.ts:294)、[file-service.ts:327](D:/dev/aether-code/src/main/fs/file-service.ts:327) | 重名需更名；回收站不可用就报错。属于显式保护行为。 | 可设计覆盖确认，但不建议移除保护。 | **既有** `6f211d6`。 |
| F08 | 文件操作undo内存栈50项；recent文件20、关闭文件20、viewState50、recent目录50。[file-ops.ts:52](D:/dev/aether-code/src/renderer/src/core/workspace/file-ops.ts:52)、[editor-store.ts:81](D:/dev/aether-code/src/renderer/src/core/editor/editor-store.ts:81)、[recent-files.ts:9](D:/dev/aether-code/src/renderer/src/core/editor/recent-files.ts:9)、[recent-folders.ts:15](D:/dev/aether-code/src/renderer/src/core/workspace/recent-folders.ts:15) | 更早历史会淘汰；不是无限跨重启文件撤销或完整工作区checkpoint。 | 固定代码，容量可改；持久撤销另需协议。 | 当前存在于HEAD；具体阶段**来源无法确认**，非D8/D9改动。 |
| S01 | 搜索结果最多500命中行；每行只显示240字符；替换预览最多500行。[search-service.ts:41](D:/dev/aether-code/src/main/search/search-service.ts:41) | “没有显示”不等于没有匹配；长行只显示开头。 | 常量可调，最好分页。 | **既有** `6f211d6`。 |
| S02 | fallback scan跳过>512KiB或含NUL文件；replace/preview亦跳过。`git grep`路径未施加相同大小过滤。[search-service.ts:155](D:/dev/aether-code/src/main/search/search-service.ts:155)、[search-service.ts:320](D:/dev/aether-code/src/main/search/search-service.ts:320)、[search-service.ts:420](D:/dev/aether-code/src/main/search/search-service.ts:420) | 大文件在Git搜索可见，却可能无法替换；非Git目录搜索不到。不能宣称两策略所有边界完全相同。 | 固定代码，需统一搜索/替换范围及UI提示。 | 容量 **既有** `6f211d6`；路径边界强化为当前未提交修复。 |
| S03 | replaceWorkspace从截断的 `outcome.hits` 提取文件集合，再替换这些文件内全部匹配。[search-service.ts:149](D:/dev/aether-code/src/main/search/search-service.ts:149) | 500命中之外、且未出现在前面结果中的文件不会替换；单文件替换数可超过500。不是严格的“整个工作区所有匹配”。 | 需替换单独全量遍历或分页；不能只修改提示文字。 | 行为 **既有** `6f211d6`（本轮仅加assertAllowed）。 |
| S04 | query先trim；搜索按行处理。空白-only查询无结果；scan跳过.git；git正常遵守ignore，显式include当前会加`--no-exclude-standard`。[search-service.ts:115](D:/dev/aether-code/src/main/search/search-service.ts:115)、[search-service.ts:292](D:/dev/aether-code/src/main/search/search-service.ts:292) | 不能搜索纯空格或依赖跨行表达式；两种策略的ignore语义有差别。files/search excludes可配置，但.git是固定边界。 | UI排除可调；trim/跨行需改实现。 | trim/.git既有；include一致性为未提交审计修复，D阶段来源无法确认。 |
| S05 | Git搜索maxBuffer16MiB；没有与Git服务相同的30秒timeout/用户取消；扫描无AbortSignal。[search-service.ts:320](D:/dev/aether-code/src/main/search/search-service.ts:320) | 结果虽截500条，但子进程会先收集输出；超量可能fallback，昂贵regex/大树无法由该服务取消。 | 需流式、取消和预算；固定代码。 | maxBuffer及执行模式 **既有**。 |

## 4. Git、PTY 与后台命令展示

| 编号 | 限制 / 证据 | 影响 | 可否调整 | 来源 |
|---|---|---|---|---|
| G01 | 常规Git单次30秒、输出20MiB；`GIT_TERMINAL_PROMPT=0`。[git-service.ts:57](D:/dev/aether-code/src/main/git/git-service.ts:57)、[git-service.ts:239](D:/dev/aether-code/src/main/git/git-service.ts:239) | 慢fetch/push等会失败；GUI中不会打开交互密码提示，需要外部credential helper/SSH agent。clone是独立spawn流程，不能套用此30秒上限。 | 固定代码；可分类超时/取消/凭据管理。 | **既有** `e4e71cd`。 |
| G02 | Windows自动加载SSH私钥直接返回不支持；无SSH_AUTH_SOCK的Unix也拒绝。[ssh-agent.ts:60](D:/dev/aether-code/src/main/git/ssh-agent.ts:60) | Windows须先终端ssh-add/配置系统agent；80个Git IPC全绿不代表SSH认证闭环。 | 需原生凭据/SSH集成。 | **既有** `e4e71cd`。 |
| G03 | 未跟踪文件行数统计最多2MiB；blame超过2MiB返回空。[git-service.ts:61](D:/dev/aether-code/src/main/git/git-service.ts:61)、[git-service.ts:2009](D:/dev/aether-code/src/main/git/git-service.ts:2009) | 大文件统计/行内作者信息不完整，并非Git内容被删除。 | 常量可调或流式计算。 | **既有** `e4e71cd`。 |
| G04 | Git log/incoming默认50、最大500；fileHistory最大200/页。[git-service.ts:1732](D:/dev/aether-code/src/main/git/git-service.ts:1732)、[git-service.ts:1851](D:/dev/aether-code/src/main/git/git-service.ts:1851) | 单次返回有限，需分页；不是总历史上限。 | API参数可在现范围调整，最大值改代码。 | **既有** `e4e71cd`。 |
| G05 | AI提交摘要的diff输入截6000字符。[git-service.ts:992](D:/dev/aether-code/src/main/git/git-service.ts:992) | 大提交生成的信息可能遗漏后半改动；不影响真正commit内容。 | 可改摘要预算/分块，不宜等同完整diff审查。 | **既有** Git功能。 |
| G06 | clone目标撞名最多尝试20次；stderr只留最后4096字符；`GIT_TERMINAL_PROMPT=0`。[git-clone.ts:19](D:/dev/aether-code/src/main/git/git-clone.ts:19)、[git-clone.ts:101](D:/dev/aether-code/src/main/git/git-clone.ts:101)、[git-clone.ts:158](D:/dev/aether-code/src/main/git/git-clone.ts:158) | 目录冲突太多需换名；详细早期错误可能不在UI。 | 常量可调；GUI认证另需实现。 | **既有** `e4e71cd`。 |
| G07 | 自动fetch默认开，3分钟；可设30秒–1小时；连续失败≥3次轮询退避×5。[git-pref.ts:14](D:/dev/aether-code/src/renderer/src/core/git/git-pref.ts:14)、[git-store.ts:641](D:/dev/aether-code/src/renderer/src/core/git/git-store.ts:641) | 不会即时同步所有远端变化。 | 前端偏好可配置（有上下限）。 | **既有** `e4e71cd`。 |
| G08 | GitInlineDiffWidget源码明确“暂不挂载”；HEAD只读虚拟文档宿主缺失。[GitInlineDiffWidget.tsx:12](D:/dev/aether-code/src/renderer/src/contrib/git/GitInlineDiffWidget.tsx:12)、[GitChangesPanel.tsx:1564](D:/dev/aether-code/src/renderer/src/contrib/git/GitChangesPanel.tsx:1564) | 不能把源码组件存在算成用户可用的编辑器行内diff/HEAD文档体验；也没有Agent worktree生命周期。 | 需编辑器扩展点与工作树合同。 | 明确UI缺口既有Git提交；Agent worktree未实现的精确阶段来源无法确认。 |
| T01 | Windows shell实际固定 `powershell.exe -NoLogo`，尽管注释说优先pwsh；非Windows用SHELL或bash `--login`。[pty-service.ts:15](D:/dev/aether-code/src/main/terminal/pty-service.ts:15) | 没有用户shell profile选择UI；Windows不会自动用PowerShell7。 | 改shell配置/探测。 | **既有** `6f211d6`。 |
| T02 | 本地PTY在主进程Map里；退出清理，无跨应用重启attach/restore；宿主env直接继承。[pty-service.ts:13](D:/dev/aether-code/src/main/terminal/pty-service.ts:13)、[index.ts:177](D:/dev/aether-code/src/main/index.ts:177) | PTY标签不是持久Agent后台job；重启不能继续原shell；受ConPTY/宿主能力限制。 | 持久PTY需独立daemon/协议；env可最小化但不能随意破坏用户shell。 | **既有** `6f211d6`。 |
| T03 | xterm无产品级scrollback配置（使用依赖默认）；resize只拒绝非正数。[terminal-store.ts:121](D:/dev/aether-code/src/renderer/src/contrib/terminal/terminal-store.ts:121)、[pty-service.ts:53](D:/dev/aether-code/src/main/terminal/pty-service.ts:53) | 历史输出不是无界日志；会话数量也未见硬上限/资源配额。 | 可加设置、配额及输出归档。 | **既有**。 |
| T04 | 后台command card在renderer保留256KiB输出尾部；引擎日志UI保留500条。[command-job-state.ts:64](D:/dev/aether-code/src/renderer/src/core/engine/command-job-state.ts:64)、[useEngine.ts:19](D:/dev/aether-code/src/renderer/src/core/engine/useEngine.ts:19) | UI不是永久全量日志查看器；不能从尾部截断推断引擎未执行。 | 固定代码，可分页/导出完整日志。 | command尾部 **D7** `f3aa70e`；engine log **既有** `6f211d6`。 |

## 5. LSP

| 编号 | 限制 / 证据 | 影响 | 可否调整 | 来源 |
|---|---|---|---|---|
| L01 | 真正语言服务器客户端仅TS/JS/TSX/JSX；主进程全局一个server，启动新server先停旧server。[ts-client.ts:6](D:/dev/aether-code/src/renderer/src/core/lsp/ts-client.ts:6)、[server.ts:8](D:/dev/aether-code/src/main/lsp/server.ts:8) | 不等于Python/Go/Java等完整多语言LSP；多项目并行会话不是独立服务池。引擎诊断工具属于另一条路径。 | 需provider注册、workspace/session隔离。 | 单TS服务器 **既有**；D8加强生命周期，未扩多语言。 |
| L02 | 普通请求15秒，initialize30秒，shutdown2秒；LSP单帧最大16MiB。[ts-client.ts:7](D:/dev/aether-code/src/renderer/src/core/lsp/ts-client.ts:7)、[ts-client.ts:118](D:/dev/aether-code/src/renderer/src/core/lsp/ts-client.ts:118)、[server.ts:7](D:/dev/aether-code/src/main/lsp/server.ts:7) | 超长请求取消/失败；大文档或大结果不能无界传输。帧上限不等于无终止header总缓冲也已限额。 | 固定代码，可按请求类型配置；应补总缓冲/背压。 | **D8 新增，未提交**；阶段报告+diff确认。 |
| L03 | workspaceEdit支持text edits；create/rename/delete等文件操作返回rejectReason；未注册formatting/code action/code lens等provider。[ts-client.ts:97](D:/dev/aether-code/src/renderer/src/core/lsp/ts-client.ts:97)、[ts-client.ts:101](D:/dev/aether-code/src/renderer/src/core/lsp/ts-client.ts:101) | rename符号不等于任意跨文件资源操作；不能宣传完整LSP协议全集。 | 需实现Monaco文件操作合同、格式化/quick fix等provider。 | workspaceEdit rejection **D8**；缺失provider精确阶段来源无法确认。 |
| L04 | 补全resolve只合并detail/documentation/command，未把resolve阶段新增textEdit/additionalTextEdits回并；直接completion结果有映射。[ts-client.ts:110](D:/dev/aether-code/src/renderer/src/core/lsp/ts-client.ts:110) | 依赖lazy resolve返回自动导入编辑的服务器可能丢编辑；应单独验证，不能仅以“resolve函数存在”判完整。 | 补协议映射与auto-import UI测试。 | **D8 当前实现边界**，未提交。 |
| L05 | server退出清markers并回落Monaco内置TS；没有自动重启守护；stderr被丢弃。[server.ts:30](D:/dev/aether-code/src/main/lsp/server.ts:30)、[ts-client.ts:116](D:/dev/aether-code/src/renderer/src/core/lsp/ts-client.ts:116) | 故障后语言能力可能退化，错误详情不完整；fallback不是重启成功。 | 可增加有界重启与日志。 | 当前生命周期 **D8**。 |

## 6. 附件、模型、会话与UI

| 编号 | 限制 / 证据 | 影响 | 可否调整 | 来源 |
|---|---|---|---|---|
| A01 | 附件单文件20MiB；须先打开工作区，整份arrayBuffer→IPC→`.aether/attachments`；只接image/text MIME或扩展名白名单。[useAttachments.ts:16](D:/dev/aether-code/src/renderer/src/contrib/chat/useAttachments.ts:16)、[useAttachments.ts:46](D:/dev/aether-code/src/renderer/src/contrib/chat/useAttachments.ts:46)、[useAttachments.ts:162](D:/dev/aether-code/src/renderer/src/contrib/chat/useAttachments.ts:162) | ZIP/audio/video/ipynb等不在扩展名清单时不能按通常类型上传；文件已落盘，不是云附件服务。没有总大小/数量上限。 | 可改白名单和容量；应同步主进程配额与引擎实际格式能力。 | **既有** `6f211d6`。 |
| A02 | 20MiB/type检查仅在renderer hook；主进程copyIntoWorkspace未重复该配额；remove/clear仅移除内存附件项，不删除已落盘文件。[file-service.ts:245](D:/dev/aether-code/src/main/fs/file-service.ts:245)、[useAttachments.ts:210](D:/dev/aether-code/src/renderer/src/contrib/chat/useAttachments.ts:210) | 不能把UI限制当安全边界；未发送/移除附件可能积累磁盘占用。 | 主进程配额、引用计数/清理策略。 | **既有**。 |
| A03 | 粘贴>2000字符或>200行自动附件化；mention候选30项，Ctrl+P候选50项。[useAttachments.ts:19](D:/dev/aether-code/src/renderer/src/contrib/chat/useAttachments.ts:19)、[FileRefPalette.tsx:85](D:/dev/aether-code/src/renderer/src/contrib/chat/FileRefPalette.tsx:85)、[QuickOpen.tsx:15](D:/dev/aether-code/src/renderer/src/workbench/QuickOpen.tsx:15) | 长文本不再保持纯输入文本；模糊匹配候选数量有限。 | 固定代码，无用户设置。 | 粘贴阈值 **既有** `562b68e`；mention **既有** `55bbbc3`。 |
| M01 | 模型表单拒绝10/172.16–31/192.168/127/localhost开头地址；只允许HTTP(S)。[ModelFormDialog.tsx:74](D:/dev/aether-code/src/renderer/src/contrib/models/ModelFormDialog.tsx:74) | **前端不能通过正常表单添加本机/局域网模型网关**。引擎支持Ollama或自托管不等于此UI可配置；本报告不重判引擎后端是否也拒绝。 | 需显式本地provider与网络策略合同；不能仅改提示。 | **既有** `6f211d6`，blame确认。 |
| M02 | 新建必填API key且至少16字符；编辑留空表示不修改；provider/modelId在编辑时disabled。[ModelFormDialog.tsx:87](D:/dev/aether-code/src/renderer/src/contrib/models/ModelFormDialog.tsx:87)、[ModelFormDialog.tsx:222](D:/dev/aether-code/src/renderer/src/contrib/models/ModelFormDialog.tsx:222)、[ModelFormDialog.tsx:241](D:/dev/aether-code/src/renderer/src/contrib/models/ModelFormDialog.tsx:241) | 无鉴权本地模型/短token网关不能正常创建；不能原地改模型身份，须新增替代。 | 按provider区分校验；涉及API合同。 | **既有** `6f211d6`。 |
| M03 | provider下拉为deepseek/openai/anthropic/qwen/custom；表单能力覆盖只暴露vision/thinking；无完整参数、预算/fallback链配置。[models.ts:93](D:/dev/aether-code/src/renderer/src/core/engine/models.ts:93)、[model-form.ts:7](D:/dev/aether-code/src/renderer/src/core/engine/model-form.ts:7) | 底层有能力类型不等于前端有所有配置项；请求模型、子代理模型、utility模型设置不能等同全部推理参数。 | 扩展表单与参数校验。 | provider UI既有；override差量提交 **D1**；其余未实现来源无法确认。 |
| U01 | 安全模式只有safe/standard/full-access；策略列表固定请求第一页200条。[security.ts:54](D:/dev/aether-code/src/renderer/src/core/engine/security.ts:54)、[security.ts:142](D:/dev/aether-code/src/renderer/src/core/engine/security.ts:142) | 无Plan模式/计划审批UI；超过200策略未见翻页展示。 | 模式需引擎协议；策略列表可加分页。 | 三模式/200条 **既有** `6f211d6`；D1补语义提示。 |
| U02 | 设置分区无MCP/OAuth/resources/插件市场/Hooks、Cron/Flow管理页。[AppSettingsView.tsx:40](D:/dev/aether-code/src/renderer/src/contrib/settings/AppSettingsView.tsx:40) | 引擎能力即使存在，用户也无法在当前IDE完成这些生命周期配置。设置页存在CodeGraph不等于通用编排控制台。 | 需要新功能，不是改上限。 | **当前未实现；来源无法确认**，没有删除这些页面的历史证据。 |
| U03 | 专用工具卡主要subagent、execute_cmd、文件变更；其余工具通用展示。[ChatView.tsx:1826](D:/dev/aether-code/src/renderer/src/contrib/chat/ChatView.tsx:1826) | 通用工具输出不是任务板、后台agent邮箱、Monitor、Notebook或浏览器交互面。 | 可逐域建设；无需每个工具都新卡片。 | 基础卡既有；后台command卡 **D7**。 |
| U08 | 当前远端聊天视图以`canExecute = ready && !remoteReadOnly`控制执行；ChangesPanel拒绝远端改动撤回/暂存，显示只读说明。[ChatView.tsx:236](D:/dev/aether-code/src/renderer/src/contrib/chat/ChatView.tsx:236)、[ChangesPanel.tsx:75](D:/dev/aether-code/src/renderer/src/contrib/chat/ChangesPanel.tsx:75)、[ChangesPanel.tsx:314](D:/dev/aether-code/src/renderer/src/contrib/chat/ChangesPanel.tsx:314) | 不会把远端改动快照按本地路径直接暂存到本地Git仓库；历史与状态可看，实际执行仍需共享工作区合同。 | 正确映射后可扩展；不能仅启用按钮。 | **本轮新增，未提交**，与D1的底层拒绝配套。 |
| U04 | 会话支持history/retry/revert，但未见session fork/attach/teleport/from-PR、Agent worktree、Notebook、浏览器、持久REPL专用入口。[SessionHistoryView.tsx:113](D:/dev/aether-code/src/renderer/src/contrib/history/SessionHistoryView.tsx:113)、[ChatView.tsx:236](D:/dev/aether-code/src/renderer/src/contrib/chat/ChatView.tsx:236) | 无法按Claude这些工作流操作；Git面板功能不能替代Agent隔离会话。 | 新协议+UI+恢复测试。 | **当前未实现；来源无法确认**。不能以关键词未出现证明引擎端绝对没有。 |
| U05 | 修改文件diff计算仅前800行/侧，默认渲染400行；ChangesPanel亦slice400。[diff.ts:23](D:/dev/aether-code/src/renderer/src/contrib/chat/diff.ts:23)、[ChangesPanel.tsx:45](D:/dev/aether-code/src/renderer/src/contrib/chat/ChangesPanel.tsx:45) | 后800行的修改可能不在计算结果或统计中；“展开所有”也不能恢复已在计算阶段丢掉的行。影响审查，不改变磁盘文件。 | 需高效diff/分段，不能仅去掉渲染截断。 | **既有** `6f211d6`。 |
| U06 | 最小窗口940×600；侧栏200–640、底面板100–640、聊天宽280–800；单实例锁。[index.ts:87](D:/dev/aether-code/src/main/index.ts:87)、[index.ts:120](D:/dev/aether-code/src/main/index.ts:120)、[layout-state.ts:47](D:/dev/aether-code/src/renderer/src/core/platform/layout-state.ts:47) | 不能当响应式移动端；同userData第二实例会聚焦旧窗口，非真正独立多窗口工程。 | 拖拽可在区间调整；多实例/更窄布局需改代码和引擎归属。 | **既有** `6f211d6`及布局提交，非D0–D9限制。 |
| U07 | 草稿最多100槽、待持久空会话20、本地命令历史50；settings.json仍浅合并；本轮已改为临时文件原子替换且成功后才更新缓存，尚无版本迁移框架。[draft-store.ts:10](D:/dev/aether-code/src/renderer/src/contrib/chat/draft-store.ts:10)、[pending-sessions.ts:18](D:/dev/aether-code/src/renderer/src/contrib/history/pending-sessions.ts:18)、[commands-history.ts:9](D:/dev/aether-code/src/renderer/src/core/platform/commands-history.ts:9)、[settings-store.ts:38](D:/dev/aether-code/src/main/settings-store.ts:38) | 本地UI状态有淘汰和损坏后回退默认的边界；本轮已补同步写失败保护，不等于引擎历史持久化或跨文件断电事务。 | 容量可改；原子落盘已补，仍需版本迁移。 | 多为HEAD既有；精确引入阶段**来源无法确认**。 |

## 7. 打包与分发

| 编号 | 限制 / 证据 | 影响 | 可否调整 | 来源 |
|---|---|---|---|---|
| P01 | staging脚本只支持Windows x64，要求独立Node≥22，target固定win32-x64；lock v2/v3、安装依赖与lock一致、拒绝链接依赖；源变更后必须先重建引擎。[prepare-engine-runtime.mjs:11](D:/dev/aether-code/scripts/prepare-engine-runtime.mjs:11)、[prepare-engine-runtime.mjs:44](D:/dev/aether-code/scripts/prepare-engine-runtime.mjs:44) | 当前只有Windows x64具备配套引擎分发链；package里mac/linux脚本不代表已具备可用内置runtime。 | 各平台独立准备/原生依赖验证，不能复用win资源。 | **D9 新增，未提交**，阶段报告明确。 |
| P02 | packaged只从resources/engine/<platform>运行，忽略开发AETHER_IDE_ENGINE_ENTRY；缺Node/manifest/skills拒绝启动。[runtime-location.ts:10](D:/dev/aether-code/src/main/engine/runtime-location.ts:10)、[runtime.ts:47](D:/dev/aether-code/src/main/engine/runtime.ts:47) | 安装包不能依赖同级源码“碰巧可用”；替换引擎须成套资源。 | 属正确分发约束；可设计受验签的runtime升级，不应临时回退开发路径。 | packaged路径规则 **D0**；独立Node/skills **D9**。 |
| P03 | bundled技能只copyMissing，不覆盖userData同名文件；source/target符号链接拒绝。[packaged-runtime.ts:5](D:/dev/aether-code/src/main/engine/packaged-runtime.ts:5) | 升级内置技能后，旧用户副本不会自动更新；没有三方merge/版本迁移。 | 需技能版本和用户修改判断。 | **D9 新增，未提交**。 |
| P04 | extraResources只配win32-x64；mac notarize=false；publish是example.com占位，appId/author仍模板值。[electron-builder.yml:1](D:/dev/aether-code/electron-builder.yml:1)、[electron-builder.yml:44](D:/dev/aether-code/electron-builder.yml:44)、[package.json:7](D:/dev/aether-code/package.json:7) | 未形成正式跨平台发布/自动更新/签名公证闭环。生成NSIS不等于安装升级卸载都验收。 | 发布前完善身份、签名、更新渠道与对应测试。 | win资源 **D9**；模板元数据/占位更新 **既有** `6f211d6`。 |
| P05 | 模型迁移只迁必要模型配置；前端固定30秒/64KiB执行结果上限，失败保留原DB/key，不迁历史。[runtime.ts:73](D:/dev/aether-code/src/main/engine/runtime.ts:73) | 开发旧会话不会自动带到新state；迁移不是全产品数据升级系统。 | 可独立做版本化迁移；不能移除失败保留行为。 | **D0 新增** `564f3bd`，D9调整运行时环境。 |

## 8. 测试证据与优先级

已有日志记录前端261/261、Git服务80方法和平台IPC11项通过。它们是已覆盖场景证据，**本清单发现的边界没有因此被逐项动态验证**。尤其应补：截断文本拒绝保存、外部修改冲突、BOM/编码、>500结果替换、>800行diff、LSP completion resolve自动导入、真实SSH、远端token存储/切换/握手，以及安装升级卸载。完整LSP provider UI、附件/mentions组合、所有设置页面仍非全路径验收。

优先处理：

1. **数据完整性**：F01截断文件写回；F02外部修改/BOM；S03全局替换范围；U05大文件diff审查完整性。
2. **用户被拦截的剩余路径**：M01/M02本地网关与无key模型；R01远端工作区执行与模型写管理。本轮remote token设置及只读会话扩展已落地，不重复计作未修。
3. **能力边界**：LSP补全resolve/file operations；Git SSH；MCP/插件/Hook/工作树/会话控制UI。
4. **分发与长期维护**：P01–P05跨平台、签名更新、技能/数据迁移，以及renderer/IPC集中授权。

## 9. 本轮并发改动复核

清单收尾时已再次读取 `protocol.ts`、`host.ts`、`remote-token.ts`、`ipc.ts`、`EngineSettingsView.tsx`、`ChatView.tsx`、`ChangesPanel.tsx` 和 README 当前版本。两项旧结论已过时：

1. **“只能通过主进程环境变量配置远端token”已过时**：当前有设置输入、safeStorage存储、配置状态读取、环境变量回退、保存锁、读取失败恢复及“保存并重启”。UI和README说明跨账户迁移、全局token和环境fallback边界。
2. **“远端只能看引擎/模型/工具信息”已过时**：当前显式开放会话历史/快照/流、改动、待办、子代理和command-job状态、只读安全策略等。修改/工作区执行仍拒绝；聊天与改动面板已显示真实只读能力并禁用相关动作。

token修复、只读可观察能力扩展和共享工作区执行是三项不同工作。本清单不把已完成的前两项再次列为待修；R01保留的是共享工作区执行的真实剩余边界。本轮新增代码的动态测试以主代理的最新结果为准，本审计未另跑应用。

本文件没有修改产品代码。D8/D9及全量审计变更尚未提交，Git只能证明相对HEAD差异；在没有对应阶段日志时，已标“来源无法确认”，没有强行归咎于D0–D9。后续产品改动需按编号更新状态和行号，本报告不自动代表未来版本。

## 10. 同日最终修订

主代理后续修复了联合保存和远端文件解释问题：令牌修改与连接设置通过专用 `settings:save-engine` 通道同步处理；settings 临时文件替换成功才更新缓存，写失败回滚旧密文字节。原 U07 中“没有原子写入”的描述已经修订，跨文件断电事务与完整版本迁移仍不在已实现范围。

远端只读状态现已覆盖历史消息重试/删除/回退、审批、根/子任务/命令停止、压缩、附件拖放/粘贴和模型执行设置。附件、Markdown 本地路径、工具路径及 diff 链接不再将远端文件名映射成本地文件。复制、导出、快照与状态查看保持可用。令牌设置在较窄面板中允许控件换行；引擎状态与长鉴权错误分行显示。

新增令牌 UI 的 7 项在本轮完整测试中通过（实际 Electron UI/IPC、安全存储和合成 HTTP 服务），含真实文件写失败回滚。该服务位于回环地址，不能据此声称跨机器远端已验收。现场另确认 `10.219.14.186` 是当前机器 LAN 地址；同机 LAN 实际引擎验证与跨机器边界见 [总览](D:/dev/ai-agent-engine/docs/research/2026-09-30-restrictions-index-and-remote-fix.md)。

只读修复阶段最终定向 58/58 通过；同时修复 Windows 路径别名造成重复 LSP 诊断，并改正虚拟滚动和预览用例的视口隔离。全量首轮 269/271 与中间定向 57/58 的失败记录保留在总览中，没有改写成全绿。用户随后要求继续开放实际远端聊天，相关新修改与验证另计。
