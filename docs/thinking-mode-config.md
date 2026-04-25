# 思考模式配置对照表 (Thinking Mode Configuration Mapping)

本平台支持为不同的模型提供自定义的思考模式（Thinking Mode）配置参数。在通过 LLM Adapter 发起请求时，这些参数将自动注入到发送给模型提供商的请求中。

## 1. OpenAI 兼容平台

| 模型名称 (Model ID) | 提供商 (Provider) | 思考配置参数 (Thinking Config) | 说明 |
|-------------------|------------------|-------------------------------|------|
| `deepseek-reasoner` | openai/custom | `{ "reasoning_effort": "high" }` | 部分平台支持配置推理的 effort。 |
| `o1-preview` / `o3-mini` | openai | `{ "reasoning_effort": "high" }` | OpenAI 原生 o1/o3 模型支持的推理等级控制。 |
| `o1` / `o3` | openai | `{ "reasoning_effort": "high" }` | OpenAI o1/o3 系列完整模型。 |
| `deepseek-r1` | openai/custom | `{ "reasoning_effort": "high" }` | DeepSeek R1 系列模型。 |

*注：OpenAI 兼容模型的响应会从 `reasoning_content` (DeepSeek) 字段或默认的思考字段解析推理内容。可以通过配置 `response_thinking_field` 覆盖。*

## 2. Anthropic 平台

| 模型名称 (Model ID) | 提供商 (Provider) | 思考配置参数 (Thinking Config) | 说明 |
|-------------------|------------------|-------------------------------|------|
| `claude-3-7-sonnet-20250219` | anthropic | `{ "thinking": { "type": "enabled", "budget_tokens": 2048 } }` | Claude 3.7 Sonnet 原生支持思考块（Thinking block），需要设置 budget_tokens。 |
| `claude-3-5-sonnet-20241022` | anthropic | `{ "thinking": { "type": "enabled", "budget_tokens": 2048 } }` | Claude 3.5 Sonnet 也支持思考模式。 |
| `claude-opus-4-20250514` | anthropic | `{ "thinking": { "type": "enabled", "budget_tokens": 4096 } }` | Claude Opus 4 支持更高预算的思考模式。 |

*注：Anthropic 模型的推理内容将从 `type: "thinking"` 块中提取，或者基于 `response_thinking_field` 的配置。*

## 3. Ollama 平台

| 模型名称 (Model ID) | 提供商 (Provider) | 思考配置参数 (Thinking Config) | 说明 |
|-------------------|------------------|-------------------------------|------|
| `deepseek-r1:7b` | ollama | `{ "num_ctx": 8192 }` | Ollama 支持通过 options 注入参数。可以在 `thinkingConfig` 中增加对长上下文或特定 option 的支持。 |
| `deepseek-r1:8b` | ollama | `{ "num_ctx": 8192 }` | DeepSeek R1 8B 量化版本。 |
| `deepseek-r1:14b` | ollama | `{ "num_ctx": 16384 }` | 更大参数版本，需要更大的上下文窗口。 |
| `qwq:32b` | ollama | `{ "num_ctx": 16384 }` | QwQ 32B 推理模型。 |

## 4. 模型白名单配置

模型白名单存储在 `model_whitelists` 表中，每条记录包含以下字段：

| 字段 | 类型 | 说明 |
|------|------|------|
| `provider` | string | 模型提供商（openai, anthropic, ollama 等） |
| `modelId` | string | 模型 ID |
| `thinkingMode` | integer | 是否支持思考模式（0=关闭, 1=开启） |
| `thinkingConfig` | string | JSON 字符串，思考模式配置参数 |
| `responseThinkingField` | string | 响应中提取思考内容的字段名 |

## 配置格式示例

在向模型白名单写入数据时，可使用以下格式：

```json
{
  "provider": "anthropic",
  "modelId": "claude-3-7-sonnet-20250219",
  "thinkingMode": 1,
  "thinkingConfig": "{\"thinking\": {\"type\": \"enabled\", \"budget_tokens\": 2048}}",
  "responseThinkingField": "thinking"
}
```

## 前端集成

前端通过 Chat 接口的 `thinkingMode` 参数控制是否启用思考模式：

```json
{
  "message": "请分析这段代码",
  "sessionId": "test-session",
  "thinkingMode": true
}
```

当 `thinkingMode` 为 `true` 时，引擎会自动根据当前使用的模型查找对应的 `thinkingConfig` 并注入到 LLM 请求中。

SSE 响应中会包含 `thinking` 事件：
```
data: {"thinking":"正在分析代码结构..."}
```

## 模型管理 API

通过 `/api/v1/models` 接口可以管理模型配置，包括：
- 查看已配置的模型列表（API Key 脱敏显示）
- 添加新的模型配置（自动加密存储 API Key）
- 测试模型连接
- 更新/删除模型配置

模型配置中的 API Key 使用 AES-256-GCM 加密存储，密钥由 `ENCRYPTION_KEY` 环境变量提供。
