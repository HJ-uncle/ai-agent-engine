# 真实模型开发对话验收

本脚本与本地假模型回归用例分开：真实启动 Aether Code/Electron，使用实际引擎和已启用模型，以界面操作导入 Skill、配置并测试 stdio MCP、创建/上传/绑定知识库，再通过真实聊天输入框发送三轮开发任务。

先串行构建两个项目，然后在引擎目录运行：

```powershell
node scripts/real-model-acceptance.mjs --check-credentials
node scripts/real-model-acceptance.mjs --run
```

不带参数不启动 Electron，也不调用模型。`--check-credentials` 只以 SQLite `readOnly` 模式查找并在内存解密启用的 `deepseek-v4.1-flash`。`--run` 会实际调用该模型并产生费用；只向供应商发送生成的合成项目与验收资源。执行时不要并发运行其他 Electron 验收。

可用环境变量：

- `AETHER_ACCEPTANCE_IDE_ROOT`：前端路径，默认同级 `aether-code`。
- `AETHER_ACCEPTANCE_SOURCE_DB`：只读来源，默认引擎 `data/agent.db`。
- `AETHER_ACCEPTANCE_MODEL`：默认 `deepseek-v4.1-flash`。
- `AETHER_ACCEPTANCE_SOURCE_KEY`：来源数据库加密密钥；默认读取进程 `ENCRYPTION_KEY` 或当前开发 fallback。不要将它写入脚本或命令参数。
- `AETHER_ACCEPTANCE_TURN_TIMEOUT_MS`：每轮期限，默认 600000 毫秒。

来源数据库不会迁移或更改。测试模型记录保存到 `.e2e-tmp/real-model-*/profile/engine/state/agent.db`，API Key 经过新的随机密钥加密，新密钥由 Electron `safeStorage` 加密保存。系统密钥存储不可用时测试明确失败，不回落到明文。密钥不会进入合成工作区、报告、日志、命令参数或模型上下文。

三轮验收分别要求模型读取资源实现 checkout 模块、编写并执行至少六项 Node 测试、定位并修复脚本随后植入的回归。验收不靠回答里的成功字样：检查持久化工具结果、MCP 调用记录、三份资源独有随机凭证、真实文件内容、独立执行测试和外部算术断言。最后完整关闭/重启 Electron，复核三轮用户消息、工具记录、知识库绑定和文件散列。

每轮有真实模型/根运行身份检查，禁止 fallback 冒充目标模型；失败、等待授权、超时、未执行工具、资源凭证不符、测试失败、修复阶段缺少失败/成功命令证据都会以非零退出结束。脚本不修改产品实现以迎合模型输出。

输出目录会保留 `report.json`、每轮脱敏历史/工具日志、界面截图、独立测试结果、重启结果和合成代码，供人工复核。脚本创建完成与语法检查通过不代表真实验收通过；只有 `--run` 最终报告 `status: passed` 才算本轮通过。
