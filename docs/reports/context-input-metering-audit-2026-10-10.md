# 本地上下文输入估算与计费用量审计（2026-10-10）

本报告先记录修改实施前的只读实证，再补入当前 Anthropic 转译复现与 root 单独运行的合成模型请求。离线审计仅访问公开 `/meta`、`/health`、只读桌面 SQLite、会话 JSONL 与源码；转译复现使用假密钥、假地址及内存 SDK 响应，没有网络模型调用。root 的真实合成探针通过正常 safeStorage 只读解密现有配置，使用原配置地址。所有结果均不输出用户正文、工具参数正文、图片像素、凭据、地址秘密或请求头，没有停止用户进程。

**协议核验后的重要纠正：** root 随后只读核验该模型现有端点的协议判定，得到 `declaresAnthropicProtocol=true`（未输出地址）。工厂首先选择 `AnthropicAdapter`，优先于 provider 或模型名称的 DeepSeek 分支。因此下文的 false-vision OpenAI 转译只证明独立 DeepSeek 分支的潜在缺陷，**不代表本截图的真实请求，也不能证明本会话的 7 张原图丢失**。原报告对此的肯定判断已撤回。完整历史估算、`_rawArgs` 重复与档案内累计的数字仍成立。另已确认并修复 Anthropic SDK 0.20 忽略结束帧输入更新的真实漏计问题，修复后合成请求的原始用量与引擎最终计数一致；历史原始结束帧缺失，实际会话残差仍不能全部解释或精确补算。

## 实例与档案

- 公开实例：`http://127.0.0.1:12366`。
- 11:58（北京时间）公开 buildId：`sha256:29d4f94ef5d402d5f16f2e79c77a06606ee44800aa68f41fff7ec737390f303e`。
- instanceId：`57efe260-5238-4ef7-8625-959fd4d8200d`；health 为 `ok`。
- 数据库：`C:/Users/wb.xielin02/AppData/Roaming/aether-code/engine/state/agent.db`，`DatabaseSync(..., { readOnly: true })`。
- 会话档案：`C:/Users/wb.xielin02/AppData/Roaming/aether-code/engine/state/sessions/default/d8686f24-6741-4c09-a2ca-17b76082e620.jsonl`。
- 当前 run：`705e791b-39f8-4783-8cb6-89ff89b6bce8`；turn：`53eded46-ac94-4639-bcb4-9a67e8527ef0`。
- 模型：`deepseek-v4.1-flash`，provider `deepseek`。数据库能力覆盖为 `vision: true`；没有本地 100K 窗口覆盖，这次窗口为 1,000,000。
- 实际工厂协议：现有地址显式声明 Anthropic 兼容协议，优先选择 `AnthropicAdapter`；仅模型/provider 名称不能决定实际 wire。

## 两张截图与真实完成调用

| 当前 turn 调用 | JSONL dbSeq | 完成时间（北京） | provider 输入 | provider 输出 | 调用合计 | turn 累计 |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| 15 | 164 | 11:53:50.419 | 17,674 | 239 | 17,913 | 272,701 |
| 16 | 166 | 11:54:07.681 | 17,731 | 1,801 | 19,532 | 292,233 |
| 17 | 168 | 11:54:11.301 | 17,750 | 78 | 17,828 | 310,061 |
| 18 | 170 | 11:54:31.720 | 17,750 | 2,956 | 20,706 | 330,767 |

上述条目的 `metadata.usageEstimated=false` 与 `metadata.contextUsageEstimated=false`。这里的 provider 输入指适配器接收到并写入档案的已报告计数；尚未捕获该实例原始上游 usage 对象。

截图累计 272.7K → 310.1K 精确对应 272,701 → 310,061，新增 **37,360 = 19,532 + 17,828**。在档案已保存的每次计数范围内，这两次调用没有漏加；这**不等于每次上游最终用量没有漏计**，后续已发现 SDK 结束帧输入修正丢失问题。`usageEstimated=false` 只标识该值来自适配器报告，也不能保证 SDK 保留了上游全部修正。两图展示的 149,738 与 152,533 是后续待完成调用的本地请求估算，并非已完成调用的计费输入。

## 完整历史估算拆分

使用修改前 `estimateModelMessageTokens` 对真实档案相同调用边界复现；未添加任何消息正文到报告。

| 估算项 | dbSeq ≤ 165 | dbSeq ≤ 169 |
| --- | ---: | ---: |
| user（2 条） | 83 | 83 |
| assistant（82 / 84 条） | 41,596 | 44,266 |
| tool（81 / 83 条） | 88,256 | 88,381 |
| 其中 7 张原生 PNG 工具返回 | 47,180 | 47,180 |
| 其中普通 tool 内容 | 41,076 | 41,201 |
| 完整历史估算合计 | 129,935 | 132,730 |
| 截图减历史所得固定系统/工具余量 | 19,803 | 19,803 |
| 截图请求估算 | **149,738** | **152,533** |

两次均满足 `完整历史估算 + 19,803 = 截图请求估算`，差额 **2,795** 也精确吻合。19,803 是从同一次请求静态部分推导的余量，不是对最终 wire 工具 schema 的独立测量。

所有邻近历史的 `assistant.reasoningContent` 均为空；移除 reasoning 后估算变化为 **0**。本例不能归因于旧思考文本膨胀。

## 已确认的估算缺陷与独立路由隐患

### 1. 独立 DeepSeek / Qwen 分支的视觉覆盖隐患（不代表本截图实际路由）

旧版本 `src/core/llm-adapter/deepseek.ts` 在实例上直接声明 `supportsVision=false`；`factory.ts` 的 DeepSeek / Qwen 专有分支只传 provider 专有配置，没有传通用 `capabilities.vision`。在实际进入这些分支时，数据库 `vision:true` 没有改变旧 DeepSeek 实例的视觉能力。本会话的显式 Anthropic 端点优先于这些分支，故该缺陷不能用于断言本会话已丢图。

`openai.ts` 的图片工具转译先写图片文字摘要，只有 `supportsVision=true` 才添加原生 `image_url`。不能仅凭这一通用分支推断旧 DeepSeek 实例已发送原图。

对两个历史边界调用 OpenAI 转译器并截获假 SDK 请求，结果如下；SDK 完成返回来自内存替身，无网络请求。这是独立分支的反事实复现，尚未复现本会话实际 Anthropic wire：

| 转译结果（vision=false，独立旧 DeepSeek 分支） | dbSeq ≤ 165 | dbSeq ≤ 169 |
| --- | ---: | ---: |
| 输入消息数 | 165 | 169 |
| wire 消息数 | 165 | 169 |
| wire 工具调用数 | 81 | 83 |
| 原生 image_url 数 | **0** | **0** |
| 图片工具文字摘要数 | 7 | 7 |
| wire 历史文本字符数（含工具参数） | 146,311 | 150,432 |
| `estimateProviderRequestInput({ messages })` | 68,165 | 69,719 |

该反事实转译中工具调用与结果匹配，孤立结果与无效调用均为 0，图片被转成文字摘要。实际 `AnthropicAdapter` 对图片工具结果有原生 `image` 块转译路径；是否全部抵达上游，必须依据实际请求核验。撤回“本会话 7 张原图没有传给模型”的结论，不以 OpenAI 分支实验推断 Anthropic 路由，也不能通过 UI 数值校准掩盖未解释差异。

### 补充：实际协议的历史消息转译复现（完全离线）

使用当前 `AnthropicAdapter.complete` 读取同一原始 JSONL 两个边界；只使用假密钥、假地址，SDK `messages.create` 替换为内存返回。额外禁止 `fetch` 和 HTTP(S) 请求，实际网络尝试为 **0**。没有读数据库、密钥文件或 Local State，没有写入原 JSONL。请求对象只在内存中分析，输出报告的所有叶子均为数字。

| 当前 Anthropic 转译结果 | dbSeq ≤ 165 | dbSeq ≤ 169 |
| --- | ---: | ---: |
| 原档案消息数 | 165 | 169 |
| 合并相邻角色后的 wire 消息数 | 161 | 165 |
| 原生 `image` 块 | **7** | **7** |
| 图像 base64 字符数（仅统计，不输出像素） | 3,869,260 | 3,869,260 |
| `tool_use` / `tool_result` 块 | 81 / 81 | 83 / 83 |
| 孤立调用 / 孤立结果 / 重复 ID / 先结果后调用 | 0 / 0 / 0 / 0 | 0 / 0 / 0 / 0 |
| 普通文本字符数（文字块、文字结果及工具参数 JSON） | 148,151 | 152,272 |
| wire 消息 JSON 字符数（包含原生图像编码） | 4,053,140 | 4,057,752 |
| 替换原生像素数据后的 wire 消息 JSON 字符数 | 184,034 | 188,646 |
| 当前 `estimateModelHistoryTokens`（已去 `_rawArgs`） | 113,188 | 114,689 |
| 当前 `estimateRequestInput(history, undefined, [])` | 113,192 | 114,693 |
| 当前原生 `estimateProviderRequestInput({ messages })` | **114,639** | **116,183** |

图片编码字符数不是 token 数；原生估算将图像按图像预算计入，未将 3.87M base64 字符当作普通文本。两个边界各调用一次内存 SDK，没有实际模型请求。角色合并减少了 4 条消息，没有删除工具结果或图像块。

该实验确认：**当前实际协议的转译路径保留了 7 张原图和全部工具配对**。它重放的是原始历史，并没有捕获截图当时压缩、投影或选择后的最终消息列表，也缺少当时的系统提示词和工具 schema，所以这些历史估算仍不能直接当作当时真实上游输入，更不能据此断言网关丢弃了历史。

可复查脚本：`.tmp/anthropic-wire-history-audit.ts`；数字报告：`docs/reports/context-input-metering-anthropic-wire-2026-10-10.json`。执行方式：`node node_modules/tsx/dist/cli.mjs .tmp/anthropic-wire-history-audit.ts`。

### 2. 估算重复计入工具调用内部 `_rawArgs`

旧 `modelMessageInput` 将整个 `toolCall` 放入估算，包括 `id/name/args/_rawArgs`。OpenAI wire 使用工具名、ID 和 `JSON.stringify(args)`；Anthropic 使用工具名、ID 和 `input: args`。两者均不发送内部 `_rawArgs`，因此重复估算结论不受上述协议纠正影响。

| 相同历史、仅工具调用字段白名单化 | dbSeq ≤ 165 | dbSeq ≤ 169 |
| --- | ---: | ---: |
| 旧完整历史估算 | 129,935 | 132,730 |
| 只保留 `id/name/args` 后 | 113,188 | 114,689 |
| 内部字段重复估算 | **16,747** | **18,041** |

对应 81 / 83 个持久化工具调用都有 `_rawArgs`。最大两个重复贡献为 dbSeq 12 的 `write_file`（7,804）和 dbSeq 156 的 `edit_file`（4,858）。报告没有保存其参数正文。

## 尚不能下结论的差异

本会话当时 129 个 assistant usage 条目均没有 `cacheHitTokens`、`cacheMissTokens` 或 `reasoningTokens`。因此不存在可由档案直接核验的 `hit + miss > prompt` 证据，也不能证明网关把缓存未命中计数错误当作总输入。

68,165 / 69,719 是独立 false-vision OpenAI 分支的估算，**不是本会话实际 wire 的测量**，不能再据此量化本截图的剩余差异。`_rawArgs` 重复解释了本地估算的一部分，但完整本地估算与已报告输入差异仍未完全解释。不能仅凭近邻报告比例进行 UI 校准，也不能猜测网关裁剪了历史。

继续核实须严格按工厂真实协议保留实际请求形状摘要、字符数、原生图片数与原始 usage 数字计数字段；不记录 API key、地址中的秘密或请求头。root 首次合成小输入探针误用 OpenAI 协议，真实请求返回 HTTP 404、无 usage；这次失败不能解释输入计数。后续探针已按现有 Anthropic 协议执行，下节记录其真实数值。

### 补充：root 已运行的真实 Anthropic 合成对照

root 通过正常 Windows safeStorage 解密现有配置，按工厂同协议分支使用当前 Anthropic adapter，分别发送一组全新合成开发记录；没有发送原会话、用户源文件、图像或工具。每组最多一次真实 SDK 调用，输出预算 256、thinking off、超时 45 秒，没有自动重试或模型回退。

| 真实合成对照 | 小输入 | 大输入 |
| --- | ---: | ---: |
| 合成记录字符数 | 20,000 | 160,000 |
| wire JSON 字符数 | 20,586 | 161,322 |
| wire 消息 JSON 字符数 | 20,141 | 160,877 |
| 当前历史侧输入估算 | 6,151 | 48,372 |
| 当前 wire 侧输入估算 | 6,148 | 48,369 |
| 原始 `message_start` 输入 | 5,081 | 40,081 |
| 原始最终 usage 输入 | **6,390** | **50,273** |
| 原始最终 usage 输出 | 49 | 45 |
| cache creation / cache read / cached tokens | 0 / 0 / 0 | 0 / 0 / 0 |
| 真实 SDK 调用数 | 1 | 1 |
| head / middle / tail 哨兵准确 | 1 / 1 / 1 | 1 / 1 / 1 |

原始 usage 在开始帧和最终帧报告不同输入数字，不能相加；最终计数分别为 6,390 与 50,273。合成文本扩大 8 倍时最终报告输入约扩大 7.87 倍，三个位置哨兵均能回忆，说明现有协议可完成请求、计数会随长度增长、该合成输入没有明显整段裁剪。该对照**没有重放实际会话，不能消除实际会话约 17K 已报告输入与本地估算的残差，也不能据此校准 UI 或证明图像处理无误**。

清洗后的原始数字结果：`.tmp/local-provider-usage-small-anthropic.jsonl`、`.tmp/local-provider-usage-large-anthropic.jsonl`。首次误用 OpenAI 协议的 HTTP 404 请求是此前独立失败记录，不计入上述两次成功对照。

## 已确认并修复：SDK 0.20 丢失结束帧的输入与缓存修正

`node_modules/@anthropic-ai/sdk/lib/MessageStream.js:364` 的 `message_delta` 分支只更新 `snapshot.usage.output_tokens`，不更新该帧可能携带的 `input_tokens`、`cache_read_input_tokens` 或 `cache_creation_input_tokens`。该 SDK 的 `finalMessage().usage` 因而可能保留开始帧的旧输入数字。

旧引擎的请求观察器直接读取原始 SSE usage，能拿到结束帧修正；adapter 最终 chunk 则使用 SDK 的 `finalMessage().usage`，得到开始帧旧计数。**同一次请求在观察器账本与最终聊天/上下文用量线路中出现不同计数**，这是真实实现缺陷，而不是界面四舍五入或可通过估算比例消除的差异。

root 的离线真实 SDK 重放复现了以下输入计数；样本来自修复前真实合成请求的开始帧与结束帧：

| 修复前真实 SDK 重放 | 小输入样本 | 大输入样本 |
| --- | ---: | ---: |
| 原始开始帧输入 | 5,081 | 40,081 |
| 原始结束帧输入 | **6,390** | **50,273** |
| 旧 SDK / adapter 最终输入 | **5,081** | **40,081** |
| 直接读原始结束帧的观察器输入 | 6,390 | 50,273 |
| SDK / adapter 漏掉的输入修正 | **1,309** | **10,192** |

对应回归样本已写入 `src/core/llm-adapter/__tests__/anthropic-usage-stream.test.ts`，通过真实 SDK 和受控 SSE 内存响应覆盖输入修正、缓存修正、稀疏帧缺失字段、显式零值与流中用量通知。本报告不引用尚在收敛的测试总数；完整回归与构建结果由 root 最终验收报告记录。

当前修复位于 `src/core/llm-adapter/request-attempt.ts` 的 `anthropicUsageSnapshot` / `anthropicUsageFromSnapshot` 及 `src/core/llm-adapter/anthropic.ts` 的流式处理：独立合并原始 usage 稀疏快照，每帧通知用量，最终 chunk 使用同一个快照结算。缺失字段保留此前报告值，显式 `0` 正确覆盖，重复快照不累加；未知字段保持缺失并标识账本下限，不能伪造为已知零。观察器与聊天最终用量由同一原始计数来源生成。

Anthropic 协议的上下文总输入为 `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`；OpenAI 协议的 `prompt_tokens` 本身包含缓存命中，不重复相加。客户端待发送请求的本地估算与已完成调用的供应商用量仍是不同指标；修复供应商计数丢失不意味着二者必须相等。

root 重新使用同一配置地址发送两组全新合成文本，修复后的原始数字与引擎标准化终值如下：

| 修复后真实网络对照 | 小输入 | 大输入 |
| --- | ---: | ---: |
| 合成字符数 | 20,000 | 160,000 |
| 原始结束帧输入 / 输出 | **6,384 / 45** | **50,295 / 46** |
| 引擎最终 `promptTokens` / `completionTokens` | **6,384 / 45** | **50,295 / 46** |
| cache creation / cache read / cached tokens | 0 / 0 / 0 | 0 / 0 / 0 |
| 终值与最后原始报告一致 | 1 | 1 |
| head / middle / tail 哨兵正确 | 1 / 1 / 1 | 1 / 1 / 1 |
| 真实调用数 | 1 | 1 |

共两次真实调用，没有重试；数值证据为 `.tmp/local-provider-usage-anthropic-fixed.jsonl`。每轮使用全新随机合成记录，修复前后的最终输入数字有小幅变化是正常样本差异，不能当成同一请求的账单调整。

原会话 JSONL 没有保存原始 `message_delta` 输入和缓存修正，无法用这两个合成样本按比例重算历史账单。该 SDK 缺陷解释了一种实际漏计来源，**不证明已经解释截图全部残差，也不支持对历史 17K 计数套用 1.25 倍或其他经验校准**。

## 正常配置入口（字段说明）

`src/storage/sqlite/models.ts` 的 `ModelsStore.getModels(tenantId)` 按 tenant 与未删除记录读取，并通过已有加密模块解密配置；失败时返回空 API key。`src/core/llm-adapter/resolve-model.ts` 提供 `resolveModelConfig` / `createAdapterFromResolved`。

models 字段：`id, tenant_id, provider, model_id, api_key, base_url, display_name, is_enabled, version, created_at, updated_at, deleted_at, capabilities`。本报告未读取输出 `api_key` 或 `base_url` 值。

root 正在实现能力覆盖透传与内部字段估算去重。报告代理仅运行离线历史转译；没有修改引擎实现、运行 UI 或构建。真实模型探针由 root 单独审查、打包并执行，结果以上述清洗数字为依据。
