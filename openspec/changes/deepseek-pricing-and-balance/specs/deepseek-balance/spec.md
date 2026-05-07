## ADDED Requirements

### Requirement: DeepSeek 余额查询 API 代理

（见 deepseek-pricing/spec.md 中"余额查询 API 代理"章节，本文件作为独立能力存档。）

系统 SHALL 提供后端代理端点用于查询 DeepSeek 账户余额，前端通过代理获取余额而不直接暴露 API Key。

#### Scenario: 余额正常显示

- **WHEN** `GET /api/deepseek/balance` 调用成功
- **THEN** 返回 `{ balance: number, currency: string, updatedAt: string }`

#### Scenario: 低余额阈值警告

- **WHEN** 余额 < 用户配置的警告阈值（默认 10 元）
- **THEN** 响应中包含 `lowBalance: true` 字段，前端展示橙色警告
