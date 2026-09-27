## 1. 后端：价格配置持久化

- [x] 1.1 创建 `src/core/deepseek/pricing.ts` —— `getPriceForModel(model, now)` 纯函数 + 默认价格快照
- [x] 1.2 实现价格配置文件读写（`~/.agent-engine/deepseek-prices.json`），启动时若不存在则写入默认值
- [x] 1.3 在 `deepseek.ts` 路由中新增 `GET /api/deepseek/prices` 和 `PUT /api/deepseek/prices`

## 2. 后端：余额查询 + 模型列表代理

- [x] 2.1 在 `deepseek.ts` 路由新增 `GET /api/deepseek/balance`，代理调用 DeepSeek `/user/balance`
- [x] 2.2 在 `deepseek.ts` 路由新增 `GET /api/deepseek/models`，带 5 分钟内存缓存 + fallback 内置列表

## 3. 后端：错误码分级处理

- [x] 3.1 创建 `src/core/llm-adapter/deepseek-errors.ts`，定义 `DeepSeekInsufficientBalanceError` / `DeepSeekRateLimitError` / `DeepSeekServiceUnavailableError` / `DeepSeekInvalidParamError`
- [x] 3.2 在 `DeepSeekAdapter.complete` / `stream` 中捕获 HTTP 错误并映射到上述 Error 子类
- [x] 3.3 实现 429 指数退避重试逻辑（1s/2s/4s，最多 3 次）
- [x] 3.4 实现 422 参数降级：解析错误体 → 移除问题参数 → 重试一次（记录日志，由调用方处理）

## 4. 前端：DeepSeek 设置页

- [x] 4.1 创建 `multi-agent-console/src/components/settings/DeepSeekSettings.tsx`：
  - 价格配置表格（deepseek-chat / deepseek-reasoner 两行，每行 6 个输入框 + 截止时间 DatePicker）
  - 余额查询面板（一键刷新按钮 + 余额显示 + 低余额警告）
  - 模型列表（只读展示，触发一次拉取）
- [x] 4.2 在 `SettingsModal.tsx` 中新增 DeepSeek Tab（图标 🐋，key: `deepseek`）

## 5. 前端：ChatArea 价格动态化

- [x] 5.1 在前端 API client 中新增 `getPrices()` / `savePrices()` / `getBalance()` / `getModels()` 方法
- [x] 5.2 在 `App.tsx` 启动时拉取有效价格并存入 store（`setDeepSeekPrices`）
- [x] 5.3 将 `ChatArea.tsx` 中硬编码的 `¥0.4/M` 改为读取 store 中的有效价格差，拉取失败时隐藏估算

## 6. 前端：错误处理 UI

- [x] 6.1 识别 `DeepSeekInsufficientBalanceError` → 弹出带充值链接的 Modal
- [x] 6.2 识别 `DeepSeekRateLimitError` → Toast "请求过于频繁，请稍后重试"
- [x] 6.3 识别 `DeepSeekServiceUnavailableError` → Toast + 错误提示
- [x] 6.4 后端通过 SSE content 中的 `__DS_ERR__` 标记透传错误类型，前端 useChat.ts 解析并清理内容

## 7. 验收

- [ ] 7.1 折扣截止时间到期后，ChatArea 节省金额估算自动切换到原价差价
- [ ] 7.2 余额 < 阈值时设置页显示橙色警告
- [ ] 7.3 模型列表拉取失败时 fallback 到内置列表（`fallback: true`）
- [ ] 7.4 模拟 402 响应，确认前端弹出充值 Modal
- [ ] 7.5 模拟 429 响应，确认 Adapter 自动重试 3 次后抛错
