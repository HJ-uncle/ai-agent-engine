# 2048 Office 交付：生产只读取证（2026-11-09）

## 结论与证据边界

本次 5.1M 可由单个 run 内 80 次已保存的模型响应 usage 精确相加复现，不需要假设重复用户提交或把同一响应重复计费。主要成本是长任务不断重新带入增长的上下文，后期每次模型调用输入约 100K。JSONL 内没有重复用户消息、消息 UUID、tool-call ID 或 tool-result ID。工具显示 83 步来自实际 87 个工具调用扣除 4 次内部 plan_update；6 次失败可逐一核对。

这不等于已经证明网络绝无重传：本次没有发现持久化完整 provider 请求体、逐次 HTTP attempt/response 日志或原始 usage 帧。80 是带 usage 的逻辑模型响应数；不能用它排除没有保存的失败/中断请求、gateway 内部重试或网关返回统计的语义差异。保存值是引擎已归一化的 provider usage，`usageEstimated=false`，不是本次重新实测的供应商账单。

生产库以只读方式打开，没有修改。此 session/turn 在 conversations/usage_archive 中没有行，实际会话在 JSONL；大 reasoning 字段外置为 gzip blob，脚本逐个校验 SHA256/字节数后还原。所有分析结果已重算，不能只读 JSONL 的 null 占位符统计 reasoning。

## 定位

- session: `work-home-c14b6b58-5216-459d-9ed7-801b7934faae`
- turn: `4c5d5b90-db96-4233-aca4-55cad32d6670`
- run: `bd88eb85-cfcf-403f-95a0-f98f879b7dc1`（唯一）
- 用户行 13：`做2048的`；完整目标范围 JSONL 13–188 行。
- 北京时间 10:26:08.079 至 10:40:51.712，883.633 秒，即 14 分 43.633 秒。
- 176 行：1 user + 88 assistant + 87 tool。80 assistant 含 usage；8 assistant 是同次响应额外工具调用，无 usage，没有被重复计入。
- 前一轮“项目需要生成 Excel 和 文档 ppt 这些”另有 turn/run，不包含在本报告累计数中。

模型配置（DB 记录更新时间早于事故）：provider=`deepseek`，model=`deepseek-v4.1-flash-1017`，api_format=`auto`，base URL 路径 `/apps/anthropic`，host `token-plan.cn-beijing.maas.aliyuncs.com`，capabilities=`{vision:true,thinking:true,contextWindow:256000}`。现有 factory 会选择 AnthropicAdapter。80 响应 modelId 一致。生产 `root_runs` 中该 run 的 `state.request.thinkingMode` 明确保存为 `"low"`，因此原事故请求档位可确认；chat.ts 将 DeepSeek 的该档位映射为 `reasoning_effort="low"`。本次未保存原始 provider wire 请求，故不能仅由客户端请求档位确认网关接受并实际执行了该参数。

## 精确 token 复算

| 项目 | 数值 |
|---|---:|
| 输入累计 | 5,021,090 |
| 输出累计 | 103,092 |
| 总累计 | 5,124,182 |
| 缓存读取累计 | 163,840 = 80 × 2,048 |
| cacheMissTokens 保存值 | 0 |
| 首次输入 | 6,428 |
| 末次输入/上下文占用 | 107,819 / 256,000 |
| 平均每次输入 | 62,763.625 |

输入占总 token 97.99%，缓存读取占输入 3.263%。输入累计是最后一次上下文的 46.57 倍。这是 80 次请求的累加，不是当前上下文超过 5M。Anthropic 路径的 cacheMissTokens 对应 cache_creation_input_tokens；0 不能解释为所有输入都命中缓存。按标准 Anthropic 语义，普通输入为 5,021,090 − 163,840 = 4,857,250。

已保存本地分项：messagesTokens=2,675,835，toolResultsTokens=1,996,426，systemPromptTokens=139,435，systemToolsTokens=194,345，skillTokens=14,417，userInputTokens=632。**这些是本地估算后分摊，不是 provider 给出的内容分类。** model-context 会计入 reasoningContent，当前 Anthropic 消息转换却不重放这个字段，不能据此说 2.68M 是实际重新发送的思考。末次本地 requestInputTokenEstimate=223,220，远大于 provider-derived input=107,819。

## 时间线及成本

请求编号由目标 turn 中含 usage 的 assistant 顺序定义。时间是该响应保存时间；不能当请求开始时间。

| 阶段 | 请求 | 响应时间（北京时间） | 输入 | 输入占比 | 输出 | 总计 |
|---|---|---|---:|---:|---:|---:|
| 项目代码/Office 技能阅读 | 1–11 | 10:26:17–10:27:12 | 207,792 | 4.14% | 6,394 | 214,186 |
| 项目测试、端口排错、补读 | 12–42 | 10:27:14–10:34:39 | 1,435,543 | 28.59% | 50,458 | 1,486,001 |
| 计划、Excel 创建/追加/重算/检查 | 43–53 | 10:35:19–10:37:35 | 757,100 | 15.08% | 25,521 | 782,621 |
| Word/PPT 创建、检查、修正文档/页脚 | 54–65 | 10:37:54–10:39:01 | 1,069,174 | 21.29% | 9,394 | 1,078,568 |
| PPTX 体积变化引起 ZIP 探查及最终一致性检查 | 66–77 | 10:39:09–10:40:33 | 1,229,979 | 24.50% | 10,130 | 1,240,109 |
| 完成计划、登记交付、最终答复 | 78–80 | 10:40:39–10:40:51 | 321,502 | 6.40% | 1,195 | 322,697 |

第一次实际 office_document 在请求 44（JSONL 116 行，10:36:30）；之前已有 43 次模型响应，其中多次生成长大纲/测试清单。请求 66–77 中 10 次 execute_cmd 和 2 次 list_files 连续追查 PPTX 从约 271KB 变成 59.5KB，最终证实 STORE→deflate 压缩方式变化。这一段本身约 1.24M token；是否完全可省不能从事后结果推断，但明显可通过一次结构/压缩核验批处理缩短。

## 失败与重复

| 请求/JSONL 工具结果行 | 失败 | 该请求总 token |
|---|---|---:|
| 18 / 65 | 命令包含 Remove-Item，被必须使用 delete_file 的策略拒绝 | 43,662 |
| 26 / 81 | 指向 5173 的冒烟测试读取不到 DOM，textContent null | 46,206 |
| 27 / 83 | 调整命令引号后重复得到同一个 DOM 错误 | 46,567 |
| 35 / 99 | delete_file 尚未 load_tools；加载后请求 37 成功 | 51,251 |
| 44 / 117 | Excel 创建混入不兼容顶层字段，OFFICE_INVALID_ARGUMENTS | 69,551 |
| 66 / 161 | ZIP 检查 node -e 读取未提供 argv 路径 | 99,434 |

6 个失败工具对应模型响应合计 input=340,558、output=16,113、total=356,671（总量 6.96%）。这不是精确“可避免成本”：修复步骤与后续历史重放另外发生，而成功替代路径仍有成本。没有持久化证据支持存在 provider HTTP 失败重试。

全参数规范化后完全相同的工具调用只有两组：command_output（请求14、29，cursor=0 重读同一 job）、delete_file（请求35、37，首次未执行）。全内容相同的工具输出只有两组：上述 command_output 与两个失败测试。冗余副本共 1,892 字节，占所有已保存工具输出 202,809 字节的 0.93%；没有大规模同消息重复插入迹象。

重复读取相同路径（参数不同，不能视为完全冗余）：app.js 请求5/38，smoke.mjs 请求10/40；Excel inspect 请求51/52 是分页；Word inspect 请求57/60/61 为初读与修订后局部核对；PPT inspect 请求62/63/65 为分页与页脚修改后核对。详细参数指纹/字节数见 tool-detail-stats.json。

reasoning 合计 185,746 字符；完整段落无重复消息。>=100字符、空白规范化后完全相同段落有3组，冗余2,039字符（1.10%），主要反复列46项测试；这个数字只衡量完全相同文本，不涵盖语义重复推演。最长 reasoning 请求20=17,396字符、31=17,301、23=16,089、44=14,517、41=13,651、43=13,335。它们说明大量重新规划/核对，但当前 Anthropic 路径不会将独立 reasoningContent 字段发送为下一次历史。

## 大内容来源

最大工具参数：失败 Excel 创建请求44=14,569 UTF-8字节（10,487字符）；Word 创建54=10,910字节；Excel追加46=7,183字节；PPT创建56=5,695字节。`_rawArgs` 保存于回放数据，但当前 adapter 构建 input 只用 parsed args，没有把 raw 和 parsed 同时发给模型。

最大已保存工具结果：Excel inspect51=11,478字节/8,000字符，Word inspect57=11,136字节，PPT inspect62=9,262字节，engine.test.mjs read9=8,704字节，app.js read5=8,466字节，smoke.mjs read10=8,448字节。早期源码阅读单份不算巨大，但在后续70余次迭代内长期保留。这比完全相同工具调用发生两次的影响大得多。

若按持久化顺序将每份工具内容在后续所有80逻辑请求中保留，可得到 202,809 原始字节、10,181,193 累积重放字节，约50.2倍。**这只是明确假设的历史重放模型，不是抓包测量，不能把字节直接折算成供应商 token 或账单。**

## 复核材料

- `forensic-session.mjs`：仅本地只读 JSONL、gzip blobs、只读 SQLite；不读凭据、不访问模型。
- `forensic-summary.json`：精确计数、去重、usage 累加、首末请求。
- `request-usage.json`：全部80逻辑请求、JSONL行号、时间和usage。
- `stage-and-content-stats.json`：阶段、失败请求成本、最大内容、重复统计。
- `tool-detail-stats.json` / `tool-timeline.json` / `row-timeline.json`：可复核的工具与行号索引。

生产来源：`C:/Users/wb.xielin02/AppData/Roaming/Aether Code/engine/state/sessions/default/work-home-c14b6b58-5216-459d-9ed7-801b7934faae.jsonl`，同 state 下 `blobs/`，`agent.db` 只读配置。未发现本 session 的持久化原始请求日志；app logs 只有 native-processes.jsonl，当前 engine logger stdout 经桌面内存日志总线转发。
