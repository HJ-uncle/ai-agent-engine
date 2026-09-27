## Why

DeepSeek 的限时折扣价格会随时变动，当前代码中硬编码了价格常量，无法在折扣期结束后自动恢复原价，也无法让用户手动配置；此外系统缺乏余额监控、动态模型列表和对 DeepSeek 特有错误码（402 余额不足、429 限流）的针对性处理，导致用户在 Agent 执行中途出现不明错误。

## What Changes

- **新增 DeepSeek 设置页**（`settings/DeepSeekSettings.tsx`）：在 SettingsModal 中新增 🐋 DeepSeek 标签页，包含：
  - 每个模型的**原价 / 折扣价 / 折扣截止时间**配置表单（可手动修改）
  - **余额查询面板**：一键拉取账户剩余余额，低余额时显示橙色警告
  - 实时显示当前有效价格（折扣期 vs 原价）
- **后端：DeepSeek 代理路由扩展**（`src/api/http/routes/deepseek.ts`）：
  - `GET /api/deepseek/balance` — 代理调用 DeepSeek `/user/balance`
  - `GET /api/deepseek/models` — 代理调用 DeepSeek `/models`，返回最新可用模型列表
  - `GET /api/deepseek/prices` — 返回当前有效价格（自动判断折扣是否过期）
  - `PUT /api/deepseek/prices` — 持久化用户自定义价格配置
- **错误码特殊处理**（`DeepSeekAdapter`）：
  - 402 → 抛出 `DeepSeekInsufficientBalanceError`，携带充值链接
  - 429 → 指数退避自动重试（最多 3 次）
  - 503 → 标记服务不可用，返回可重试标志
  - 422 → 记录参数错误日志，fallback 去除不支持的参数
- **ChatArea.tsx 成本估算动态化**：从配置读取有效价格，不再硬编码 `¥0.4/M`
- **ModelSettings.tsx 模型下拉框动态化**：可从 `/api/deepseek/models` 拉取最新模型列表填充选项

## Capabilities

### New Capabilities

- `deepseek-pricing`: 动态价格配置与自动切换（折扣期 / 原价），包含每模型的 input/output/cacheHit 三档价格及截止时间
- `deepseek-balance`: 余额查询 API 代理 + 前端显示 + 低余额警告
- `deepseek-models`: 动态模型列表拉取与缓存
- `deepseek-error-handling`: DeepSeek 特有错误码（402/429/503/422）的分级处理策略

### Modified Capabilities

- `deepseek-optimized-channel`: ChatArea 的 KV Cache 节省估算由硬编码改为读取动态价格配置

## Impact

- **后端**: `src/api/http/routes/deepseek.ts`、`src/core/llm-adapter/deepseek.ts`
- **前端**: `multi-agent-console/src/components/settings/DeepSeekSettings.tsx`（新建）、`SettingsModal.tsx`（新增 Tab）、`ChatArea.tsx`（价格读取动态化）
- **存储**: 价格配置持久化到 `~/.agent-engine/deepseek-prices.json`（或 localStorage 前端侧）
- **API**: 新增 3 个 `/api/deepseek/*` 路由
- **依赖**: 无新增依赖
