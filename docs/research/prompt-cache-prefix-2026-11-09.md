# 缓存命中率实测（2026-11-09）

## 结论

截图的输入和缓存数字与持久化供应商 usage 一致，命中率确实约 9.74%。独立真实 Work 会话复现了固定短前缀命中：既有历史和工具定义均不变，但 system 中每次更新的毫秒级时间切断了后续历史的前缀复用。完全相同请求的对照命中率为 98.63%，说明该连接有能力缓存更长输入。

本轮完成诊断和取证，新增隔离评测观察器，没有修改生产请求组装、现有用户会话、凭据或前端统计。

## 截图对应的真实记录

- 会话：`work-home-ccff29ea-f637-4794-9e45-08898087ccaa`
- run：`69f2049f-35a2-4f9e-9019-0650ee900dfc`
- turn：`ca79c785-ecf4-4671-aa13-eedd5df2fb85`
- 来源：用户 profile 中 `engine/state/sessions/default/<sessionId>.jsonl`，第 224–282 行，28 个不同 usage 消息，全部 `usageEstimated=false`。
- 北京时间 18:39:21–18:43:20；累计输入 1,053,454，输出 37,956，总量 1,091,410，缓存读取 102,656。
- 缓存读取：首次 1,024，中间 26 次均为 3,840，最后 1,792；输入从 9,609 增长到 62,765。
- 分类累计：system 124,332、history 310,847、toolResults 504,055、builtin 106,919、skill 6,407，与截图一致。分类是本地估算分摊，不能据其数值变化判断原始内容变化。

## 隔离真实模型测试

使用已配置的 `deepseek-v4.1-flash-1017`，协议实际为 Anthropic。通过真实 Work HTTP 路由执行合成任务：读取 input.txt、替换一个词、另存 output.txt、计算并报告 SHA-256。使用独立数据库和目录，文件内容及 hash 均验证成功。

第二次基线测试（修正观察器以识别 Anthropic 顶层 system）：

| 请求 | 完整输入 | 缓存读取 | 历史消息数 | 旧历史保持原样 | 工具定义保持原样 |
|---|---:|---:|---:|---|---|
| 1 | 9,226 | 256 | 1 | — | — |
| 2 | 9,502 | 3,584 | 3 | 是 | 是 |
| 3 | 9,900 | 3,584 | 5 | 是 | 是 |
| 4 | 10,333 | 3,584 | 7 | 是 | 是 |

相邻请求的 system 第一处差异均在第 10,833 个字符之后的 `clock.currentTime`：`10:49:31.738Z → 10:49:33.318Z → 10:49:35.412Z → 10:49:37.125Z`。字符偏移不是供应商 token 数。不同任务初始提示和缓存块边界不同，因此该测试为 3,584，而截图为 3,840。

第三次测试增加一次完全相同请求的重放对照：

| 第 3 个请求 | 完整输入 | 缓存读取 | 未缓存输入 | 命中率 |
|---|---:|---:|---:|---:|
| 正常首次发送 | 9,863 | 3,584 | 6,279 | 36.34% |
| 请求体完全相同的重放 | 9,863 | 9,728 | 135 | 98.63% |

对照请求只读取模型响应，不执行重放返回的工具调用，不修改会话历史。三次会话各 4 次请求，加 1 次重放，共 13 次真实提供方请求；首轮观察器漏读 Anthropic 顶层 system，故只采用后两轮做前缀定位。98.63% 是完全相同输入的对照结果，不是优化后所有真实任务的保证值。

## 为什么会失效

1. `src/core/runtime-capabilities.ts:25` 每次创建新 Date，`:59` 把完整 currentTime 写入运行环境。
2. `src/core/agent-loop/react.ts:745` 重建 requestEnvironment，`:746–756` 把它放入 systemPrompt，位于整个对话历史之前。
3. 因而即使历史严格只追加，也会在 system 的时间位置出现早期差异，后面的历史和工具结果无法沿同一前缀继续命中。
4. 其他可能改变前缀的来源包括工具加载后的 registryVersion、计划 revision/updatedAt、交付和恢复提示、跨轮记忆/RAG/团队摘要。
5. 历史本身也存在有意投影：重复只读结果合并、旧长写入参数归档、自动压缩。该次短测试没有这些历史变化，不能把它们当作这次复现的原因。

## 统计口径

当前连接走 Anthropic，完整输入为 `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`，不能把其中的 `input_tokens` 单独当完整输入。流式开头可能带估算占位，最终计量以结束 usage 覆盖为准，不能把多帧相加。

`cacheMissTokens=0` 来自 `cache_creation_input_tokens=0` 的内部映射，不代表全部输入命中。前端本次没有遗漏缓存量，也没有触发“缓存超过输入”封顶。父子代理有各自用量口径；截图本次无子代理明细，不能以子代理漏记解释低命中。

## 优化方向

优先让静态 system 和工具定义稳定，把每次更新的时间、环境、计划和恢复状态放到历史之后的请求尾部，同时仍更新真实权限和时间。随后逐项评估旧历史投影的节省量与缓存损失，保留必要压缩。不能通过冻结时间或权限来制造命中率，也不需要通过改 UI 数字掩盖失效。

## 证据与复现

证据目录：`D:/dev/ai-agent-engine/.tmp/cache-investigation-20261109/`。

- `wire-baseline-v2.json`：相邻请求 system/tools/history 哈希、首个差异位置、原始 usage。
- `wire-control.json`：完全相同请求重放的原始 usage。
- `cache-baseline-v2-2026-11-09T10-49-28-679Z-9ef41a/evidence.json`
- `cache-control-2026-11-09T10-50-40-792Z-353eed/evidence.json`

观察器：`scripts/evals/cache-prefix-observer.mjs`，只记录结构、哈希、受限运行环境差异和 usage，不记录请求头或完整提示。对照重放必须显式指定。

```powershell
$env:AETHER_CACHE_EVIDENCE = 'D:\dev\ai-agent-engine\.tmp\cache-investigation-next\wire.json'
$env:AETHER_CACHE_REPLAY_INDEX = '3'
node --import ./scripts/evals/cache-prefix-observer.mjs --import tsx scripts/evals/work-prompt-compression-eval.ts --label cache-probe --cases files --output .tmp/cache-investigation-next --timeout-ms 180000 --max-attempts 12 --max-input-tokens 300000
```

评测的 max-attempts 限制路由产生的请求；可选重放额外增加且最多增加一次请求。复现需要本机已有模型连接及相应 Windows 用户的凭据解密权限。
