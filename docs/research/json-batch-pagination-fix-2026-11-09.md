# JSON 批量读取超限修复

## 原因

截图中的 `package.json` 并非不存在、权限不足或损坏。此前新增的批量读取只让 `TextHandler` 进入按输出额度分页的分支，JSON 由独立 `JsonHandler` 返回整份压缩内容，超过单项额度后被 `FILE_BATCH_REQUIRES_SINGLE_READ` 拒绝。再次把同一文件放入批次仍没有续页游标，造成失败后再单读的额外回合。这是批量接口对 JSON 的兼容遗漏。

生产历史与只读复现一致：四文件批输出 5,911 字符、package.json 项失败；package.json + README 尾页批输出 1,110 字符、package.json 再失败；单文件输出 7,235 字符成功。源文件 package.json 为 8,249 字节，整体输出限额为 8,000 字符，批次中每项分得的额度更小。体积单位不能混同。

相关生产 run：`9431989f-708c-4f76-8c0d-10518d71d603`，第 2、4、5 个模型响应涉及上述调用。合计输入 42,237、输出 174 tokens；其中包含其他成功读取，不能把全部用量都归为浪费。

## 修改

`src/tools/file/super-file-tool.ts` 将批量 JSON/CSV 的 auto/full 读取接入现有 `readTextPage`，按原始 UTF-8 源文返回 `numberedContent`、真实行/列范围、完整文件哈希和续页游标。CSV 同样由独立格式处理器承接，具有相同分支遗漏，一并修复。

JSON/CSV 后续可以在批次内继续，也可按回执的 `start_line/start_column` 单独续读。完整性字段准确区分当前页与全文；JSON 源文片段不假装是可独立解析的完整对象。旧单文件无范围 auto/full/summary 展示及 exact 字节读取保留；DOCX/XLSX 等二进制文档不走文本源分页。工具说明和相邻契约测试同步。

## 实际文件验证

在独立测试状态中，以安全只读工具访问 `D:/web/wuzu-client` 的 AGENTS.md、CONTEXT.md、README.md、package.json，不修改生产会话或源项目。

| 场景 | 修复前 | 修复后 |
|---|---|---|
| 四文件批读 | package.json 超限失败 | 全部成功；package.json 返回 1–21 行，下页从 22 行开始 |
| package.json + README 尾页 | package.json 再次超限失败 | 全部成功；package.json 返回 1–40 行，附续页游标 |
| 单独默认读取 package.json | 成功，7,235 字符 | 保持成功，7,235 字符 |

另从四文件首批开始，按游标仅续读未完成文件，5 个工具批次还原全部源行：36、119、67、197 行。逐行内容完全一致；四文件读取前后 SHA-256 相同。这里是直接工具调用验证，不是 5 次真实模型 API 测试。

## 验证与证据

- 新增 JSON/CSV 专项 18 项；初始 JSON 回归测试先复现 9 项失败，修复后全部通过。
- 最终定向回归 **19 文件、315/315 通过**，包括文件工具、批次 ReAct/协议及工具定义。
- TypeScript 与引擎构建通过。构建指纹：`sha256:125c85c86687e1d903217778989d9c3566512f3e2bfa8536d4a0c65776dccc36`。
- 未调用模型、未重启当前 Aether。现有前端已支持编号源文及续页范围，不需为本次引擎修复再改显示逻辑。
- 大文件依旧受共同输出预算约束，成功分页并不代表一次取回全文。

证据：

- `.e2e-tmp/read-batch-json-before-20261109/production-trace.json`
- `.e2e-tmp/read-batch-json-before-20261109/before-reproduction.json`
- `.e2e-tmp/read-batch-json-before-20261109/after-reproduction.json`
- `.e2e-tmp/json-batch-final-tests.json`
- `.e2e-tmp/json-batch-typecheck.log`、`.e2e-tmp/json-batch-build.log`
