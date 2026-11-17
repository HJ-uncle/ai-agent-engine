## ADDED Requirements

<!-- documentation-status: historical -->
> 历史资料：保留原有调研、设计或验收条件，不代表当前版本全部行为或本轮测试结果。现行操作与源码入口见[文档首页](../../../../../docs/README.md)；文档状态见[全量清单](../../../../../docs/documentation-inventory.md)。状态标注：2026-11-17。


### Requirement: useXAgentChat Hook
系统 SHALL 封装 `useXAgentChat` hook，内部使用 `@ant-design/x-sdk` 的 `useXAgent`，对外暴露与现有 store 兼容的接口。

#### Scenario: 发送消息并接收流
- **WHEN** 调用 `useXAgentChat.send(content, sessionId)`
- **THEN** hook 内部通过 `useXAgent` 的 request 发起请求，并将每个 chunk 写入 Zustand store

#### Scenario: 取消流式请求
- **WHEN** 用户点击取消按钮
- **THEN** `useXAgentChat.cancel()` 终止当前请求，store 中的消息标记为 done

#### Scenario: 多 session 隔离
- **WHEN** 用户在 session A 发送消息，同时切换到 session B
- **THEN** session A 的 chunks 仍然写入 session A 的 messageMap，session B 不受影响

### Requirement: 标准化 SSE 帧解析
`useXAgentChat` SHALL 统一解析所有 SSE 帧类型：`content`、`card`、`thinking`、`toolStart`、`toolEnd`、`usage`。

#### Scenario: content 帧
- **WHEN** 收到 `{"content": "..."}` 帧
- **THEN** 调用 `appendStreamChunk` 追加内容

#### Scenario: card 帧
- **WHEN** 收到 `{"card": {...}}` 帧
- **THEN** 调用 `appendStreamCard` 更新消息的卡片数据

#### Scenario: usage 帧
- **WHEN** 收到 `{"usage": {...}}` 帧（最后一帧）
- **THEN** 调用 `finishStreaming` 并传入 usage 数据
