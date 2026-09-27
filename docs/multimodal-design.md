# 多模态输入设计文档

## 概述

Agent Engine 支持图片和文件附件的多模态输入。为避免将大体积 base64 数据存储进对话历史（导致 Token 预算爆炸），采用「上传 → 引用 → 工具调用 → 视觉注入」的流水线架构。

---

## 架构流程

```
用户上传文件
    │
    ▼
POST /api/v1/workspace/file   (multipart, max 100MB)
    │  → 文件保存到 workspace/{tenant}/{session}/filename
    │
    ▼
POST /api/v1/chat
    {
      "message": "分析这张图",
      "attachments": [{ "name": "screenshot.png", "content": "", "type": "image/png" }]
    }
    │
    ▼  chat.ts 处理
    │  图片附件 → 提示文本: "[用户上传了以下图片...请使用 read_image 工具读取后回答]"
    │  文件附件 → 提示文本: "[用户上传了以下文件...请使用 read_file 工具读取后回答]"
    │  displayContent → 存入 DB (含 workspace_image / workspace_file 类型，供 UI 渲染卡片)
    │
    ▼  ReAct 循环
    AI 调用 read_image("screenshot.png")
    │
    ▼  read_image 工具
    │  读取文件 → 返回 JSON { success, filename, mimeType, size, dataUrl: "data:image/png;base64,..." }
    │
    ▼  openai.ts LLM adapter
    │  检测到 tool result 含 dataUrl
    │  → 添加 { role: "tool", content: 'Image "screenshot.png" loaded...' }
    │  → 注入  { role: "user", content: [{ type: "image_url", image_url: { url: dataUrl } }] }
    │
    ▼
    AI 看到真实图片像素，进行 OCR / 内容分析
```

---

## 消息存储策略

### 用户消息（存入 DB 的 displayContent）

```json
[
  { "type": "text", "text": "分析这张图" },
  { "type": "workspace_image", "name": "screenshot.png", "sessionId": "xxx" }
]
```

- `workspace_image` / `workspace_file` 只存文件名和 sessionId，**不存 base64**
- UI 读取后渲染为文件卡片（名称 + 大小 + 日期）
- 刷新页面后卡片正常显示，不会变成 JSON 乱码

### LLM 接收的消息（由 openai.ts 转换）

`contentToMultimodal()` 函数负责将 `workspace_image` / `workspace_file` 转换为 AI 指令文本：

```
[用户上传了以下图片到工作区，请调用 read_image 工具读取后再回答，文件名如下：]
- screenshot.png
```

这确保 AI 每次都能从当前消息中看到明确的文件名，不会混淆历史对话中的文件。

---

## Tool Result 处理（openai.ts）

```typescript
// 检测 read_image tool result
if (parsed?.dataUrl && typeof parsed.dataUrl === 'string') {
  result.push({ role: 'tool', content: 'Image "filename" loaded successfully.' })
  result.push({
    role: 'user',
    content: [{ type: 'image_url', image_url: { url: parsed.dataUrl } }]
  })
}
```

**原因**：OpenAI API 的 `tool` 角色消息不支持 `image_url` 类型，必须通过额外注入一条 `user` 消息才能让视觉模型看到图片。

---

## Token 预算保护

- `applyTokenWindow`（`history.ts`）只做**滑动窗口**（丢弃最旧消息），不截断单条消息内容
- `rowToMessage` 读取历史时，`tool` 角色消息**保持字符串格式**，不自动 JSON.parse（防止 JSON 文件内容变成 `[object Object]`）
- 图片 base64 只在 `read_image` 工具调用时注入，不常驻历史，每轮对话结束后自动消失于下一轮的上下文窗口外

---

## 文件类型区分

| 前端 part 类型 | 说明 | AI 使用的工具 |
|---|---|---|
| `workspace_image` | 图片附件（.png/.jpg/.gif/.webp 等）| `read_image` |
| `workspace_file` | 文档附件（.json/.txt/.md/.pdf 等）| `read_file` |
| `file`（旧格式）| 含完整内容，已废弃 | 跳过，不传给 LLM |
