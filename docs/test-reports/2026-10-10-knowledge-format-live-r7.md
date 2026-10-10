# 知识库 43 格式真实 API 验收（r7）

候选：r7 隔离实例 `http://127.0.0.1:12509`；构建：`sha256:f135a73591f83d7246fe5e3e256b38724a07f8fe4f09b0cb56aff9c9ea10f112`。

证据目录：`test-projects/longrun-20261009/runs/recovery-20261009202544319-r7/proofs/format-live-r7/`。原始 HTTP 证据为 `http.jsonl`，真格式清单和 SHA-256 为 `fixtures/manifest.json`，独立断言源码为 `assertions.test.mjs`。

- 43 个扩展分别使用真实格式 payload：31 个文本/代码、XLSX、OLE BIFF8 XLS、DOCX、固定 commit 的 Word97 DOC、可选文本 PDF、PNG/JPEG/GIF/WebP/BMP/TIFF。
- 真实 multipart 上传、提取正文、读取、限定知识库搜索、跨库隔离、文档更新后旧索引撤销、新索引命中、删除后业务 404/列表/搜索清除、知识库更新/删除及级联删除均通过。
- 独立 Node TAP：advertised scope **46/46，exit 0**；scan-only PDF OCR **1/1，exit 0**；全流程共 547 条原始请求，业务错误 0。
- r6 的扫描 PDF 缺陷已在 r7 修复后通过；完整 feature evidence 的 `fullClaimPassed=true`。
