## Context

DeepSeek 已集成到 agent-engine 的 `DeepSeekAdapter` 中，KV Cache / Reasoning Token 等专有指标已在后端解析并透传到前端展示。但目前存在三个主要缺口：
1. ChatArea.tsx 中成本估算硬编码了 `¥0.4/M` 的差价，在折扣期结束后无法自动更正
2. 没有余额查询能力，Agent 多轮调用过程中可能因余额不足（402）导致中途中断，UI 无有意义的错误提示
3. DeepSeek 特有错误码（402/429/503/422）被通用错误处理吞掉，用户看不到有针对性的提示

当前后端已有 `src/api/http/routes/deepseek.ts`，包含 FIM 和 JSON-mode 测试路由；前端设置模态框（`SettingsModal.tsx`）已有多个标签页模式，可直接扩展。

## Goals / Non-Goals

**Goals:**
- 价格配置可在 UI 手动修改，包含原价/折扣价/截止时间三字段，截止时间到期自动回原价
- 余额查询通过后端代理（避免在前端暴露 API Key），展示在设置页，低余额显示警告
- 动态模型列表：`GET /api/deepseek/models` 代理后缓存 5 分钟，可在 ModelSettings 选择器使用
- 错误码分级：402 弹出余额不足卡片带充值链接；429 自动指数退避重试；503 返回可重试标志；422 降级去除不支持参数后重试
- ChatArea KV Cache 节省估算改为读取运行时有效价格（考虑折扣状态）

**Non-Goals:**
- 不爬取 DeepSeek 官网自动同步价格（不可靠，保留人工维护）
- 不实现消费账单明细（只做余额查询）
- 不改变 DeepSeek 以外模型（OpenAI/Claude）的价格逻辑

## Decisions

### D1: 价格配置存储位置 — 前后端各一份

**决定**: 前端 localStorage 存一份（`deepseek:prices`），后端配置文件存一份（`~/.agent-engine/deepseek-prices.json`）；`GET /api/deepseek/prices` 读文件，`PUT /api/deepseek/prices` 写文件；前端设置页加载时拉一次 API，之后以本地状态为准，保存时同步写入两侧。

**备选方案**: 仅前端 localStorage — 被否，因为后端的 `DeepSeekAdapter` 也需要知道有效价格来计算 `savedYuan` 日志输出；仅后端文件 — 被否，设置页 UX 需要响应式更新。

**理由**: 两端独立存储，API 保存时双写，读取时优先服务端（首次加载）。

---

### D2: 余额查询 — 后端代理而非前端直连

**决定**: 新增 `GET /api/deepseek/balance`，后端用已配置的 `DEEPSEEK_API_KEY` 调用 `https://api.deepseek.com/user/balance`，前端无需知道 Key。

**理由**: 前端直连会在 Network Tab 暴露 Bearer Token；后端代理已经有 Key，成本低。

---

### D3: 错误处理 — 在 DeepSeekAdapter 层而非 HTTP 路由层

**决定**: `DeepSeekAdapter.complete` / `stream` 捕获 OpenAI SDK 抛出的 HTTP 错误，按状态码映射到自定义 Error 子类：
- `DeepSeekInsufficientBalanceError` (402)
- `DeepSeekRateLimitError` (429) — 含 `retryAfter`
- `DeepSeekServiceUnavailableError` (503) — 含 `retryable: true`
- `DeepSeekInvalidParamError` (422) — 含 `problematicParam`，尝试移除后重试

前端 `useChat.ts` 识别这些错误类型，分发到对应 Toast/Modal 组件。

**理由**: 错误语义在业务层（Adapter）比在 HTTP 层更清晰；OpenAI SDK 已把 HTTP 错误包装成 `APIError`，只需在此基础上细分。

---

### D4: 模型列表缓存 — 内存 + TTL 5 分钟

**决定**: `GET /api/deepseek/models` 路由使用简单内存缓存（`Map<string, {data, expiry}>`），TTL 5 分钟。不用 Redis，不持久化。

**理由**: 模型列表几乎不变，5 分钟足够；Redis 过重；持久化意义不大（重启后拉一次即可）。

---

### D5: 折扣截止时间的有效价格计算 — 纯前端 + 后端各自判断

**决定**: `getPriceForModel(model, now)` 纯函数，接收价格配置和当前时间，返回有效价格。前端调用此函数渲染估算；后端 `GET /api/deepseek/prices` 也调用同一逻辑返回有效价格（TypeScript 共享 util 函数）。

```
discountUntil && now < new Date(discountUntil)
  ? discountPrice
  : normalPrice
```

## Risks / Trade-offs

- **[风险] 价格配置文件不存在时启动失败** → 迁移：首次启动时写入默认配置文件（内置 2026-05-07 快照价格）
- **[风险] DeepSeek `/user/balance` API 响应格式变化** → 代理层做宽松解析，字段缺失时返回 `null` 而非抛错
- **[风险] 429 自动重试可能放大费用** → 默认最多重试 3 次，退避间隔 1s/2s/4s，并在日志中记录重试次数
- **[取舍] 前后端双写增加一致性风险** → 保存时先写后端，成功后再写 localStorage；失败时 Toast 提示但不回滚前端状态（可接受）

## Migration Plan

1. 后端先部署新路由和价格配置文件默认生成逻辑
2. 前端合并 DeepSeekSettings Tab（不影响已有标签页）
3. ChatArea.tsx 改为读取 API 价格（加载失败时 fallback 到 0，不显示估算）
4. 发布后用户首次打开设置页 → DeepSeek Tab → 确认/修改价格 → 保存

无需数据库迁移，无 breaking change。

## Open Questions

- 无。
