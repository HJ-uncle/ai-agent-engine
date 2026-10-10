# 知识库 43 格式真实 API 验收（r6）

候选：r6 隔离实例 `http://127.0.0.1:12509`；构建：`sha256:5e2febfc607595563d8b19fe98ba8145175f5c690292c8fb58b32fb53478aa96`。

证据目录：`test-projects/longrun-20261009/runs/recovery-20261009202544319/proofs/format-live-attempt2/`。原始 HTTP 证据为 `http.jsonl`，真格式清单和 SHA-256 为 `fixtures/manifest.json`，独立断言源码为 `assertions.test.mjs`。

- 43 个扩展分别使用真实格式 payload：31 个文本/代码、XLSX、OLE BIFF8 XLS、DOCX、固定 commit 的 Word97 DOC、可选文本 PDF、PNG/JPEG/GIF/WebP/BMP/TIFF。
- 真实 multipart 上传、提取正文、读取、限定知识库搜索、跨库隔离、文档更新后旧索引撤销、新索引命中、删除后业务 404/列表/搜索清除、知识库更新/删除及级联删除均通过。
- 独立 Node TAP：advertised scope **46/46，exit 0**；全流程共 547 条原始请求，业务错误 0。
- 另外上传了无文本层的 image-only `scan-only.pdf`。当前实现 `PDFParse.getText()` 只返回页面分隔空白，跳过了 OCR；独立扫描断言 **0/1，exit 1**，失败证据保留。不能宣称扫描 PDF 已支持 OCR。

现有依赖已能完成修复：`pdf-parse` 的 `getScreenshot({ first: 1, desiredWidth: 1600, imageBuffer: true, imageDataUrl: false })` 加现有 `tesseract.js` 实测得到英文 oracle 与中文文本（置信度约 94）。修复时需按真实正文判定空文本（页面分隔符不应算正文），再对前 N 页截图 OCR。
