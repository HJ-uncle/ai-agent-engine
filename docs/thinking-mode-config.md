# 模型思考模式的配置与适配

本文按 2026-11-17 实现核对。思考开关表示请求意图；能否关闭、支持哪些强度、返回哪些推理字段，取决于实际模型和上游协议。不能只凭模型名表格推导所有网关的 wire 参数。

## 请求经过哪些层

`POST /chat` 在 [chat.ts](../src/api/http/routes/chat.ts) 解析 thinkingMode、模型能力、配置中的 thinkingConfig/responseThinkingField 和强度。实际模型适配器在发请求前应用 [thinking.ts](../src/core/llm-adapter/thinking.ts)，所以回退模型和子代理也应按最终模型处理。

[factory.ts](../src/core/llm-adapter/factory.ts) 优先尊重显式 OpenAI/Anthropic 协议，其后识别原生 Ollama，再做 DeepSeek/Qwen 家族路由。[thinking-family.ts](../src/core/llm-adapter/thinking-family.ts) 以模型身份优先于网关域名，避免同一代理域名托管多个家族时误判。

## 明确关闭时的当前处理

| 实际适配通道/家族 | 请求处理 |
| --- | --- |
| Anthropic 常规模型 | `thinking: { type: 'disabled' }` |
| Anthropic 兼容 MiniMax/GLM | 兼容上游固定行为，仍发送 `enable_thinking: true`；关闭意图无法保证模型停止推理 |
| Anthropic 兼容 Kimi | 省略不支持的原生 thinking 开关 |
| 原生 Ollama | `think: false` |
| DeepSeek 官方 api.deepseek.com | `thinking: { type: 'disabled' }` |
| DeepSeek 其他兼容网关 | `enable_thinking: false` 与 `reasoning_effort: 'low'` |
| Qwen/QwQ | `enable_thinking: false` |
| 其他兼容模型 | 不凭空添加通用关闭字段；清除路由默认 effort 和推理字段配置 |

兼容性重试不能静默删除已明确关闭的受保护参数。但上游是否遵守参数仍由提供方决定，不能把前端“关”理解为提供方绝对无内部推理。

## 开启、强度与返回内容

开启时使用路由解析后的家族配置或模型白名单配置。原生 Anthropic 的 thinking budget、兼容网关的 enable_thinking、OpenAI 的 reasoning_effort、Ollama 的 think 并非可互换字段。上下文大小如 num_ctx 也不等同思考强度。

[Anthropic 适配器](../src/core/llm-adapter/anthropic.ts) 会进一步规范兼容家族和 output_config；[OpenAI 适配器](../src/core/llm-adapter/openai.ts) 会合并 thinkingConfig，并处理推理字段、标签与不支持参数的兼容分支。可配置 responseThinkingField 不是所有提供商都返回该字段的保证。

不要把旧文档里的模型示例当能力声明，尤其不能断言 Claude 3.5、所有 DeepSeek R1 网关或任意新型号具有同样的原生思考开关。模型能力与当前上游文档、实际响应应一起核对。

## 验证入口

[thinking-preference.test.ts](../src/core/llm-adapter/__tests__/thinking-preference.test.ts)、[thinking-family.test.ts](../src/core/llm-adapter/__tests__/thinking-family.test.ts)、[resolved-thinking.test.ts](../src/core/llm-adapter/__tests__/resolved-thinking.test.ts) 和 [chat-thinking-family.test.ts](../src/api/http/routes/__tests__/chat-thinking-family.test.ts) 覆盖解析和适配契约。本次未对各商业提供商进行在线兼容性实测。
