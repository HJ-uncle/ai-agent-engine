# Aether 办公环境诊断

日常办公直接使用内置 `office_document`、`office_inspect` 和 Aether 资源预览，不需要先探测 Python 或外部办公程序。不能因某项能力缺失就改用 WPS、Office COM、LibreOffice、外部浏览器或临时 HTTP 服务。

## 内置能力与边界

| 能力 | 实际支持 | 尚不能证明或完成 |
| --- | --- | --- |
| DOCX | Markdown 创建、唯一文字定点编辑、文字检查 | 与 Word 逐像素相同的分页、保真 PDF 导出 |
| XLSX | 多工作表创建、追加表、单元格编辑、支持公式的内置重算 | 任意 Excel 函数、宏、外链、数据透视计算 |
| PPTX | 标题、要点、表格、备注、文字定点编辑 | 复杂图表、动画、任意母版编辑、保真 PDF 导出 |
| PDF | 可检索中文、段落、列表、分页表格的原生生成与检查 | 任意已有 PDF 文字编辑、DOCX/PPTX 原版式转换 |

失败时保留原文件和原始错误，记录操作、版本、影响及待补能力。使用已支持的内置路径完成其他部分；不要伪装已重算、已导出或已视觉验收。未支持的编辑可基于核实过的源内容创建新版本，不能覆盖旧版假称保留版式。

## 按需读取环境回执

仅排查环境问题时调用 `office_environment({})`。它不接受路径、命令或安装参数，仅在宿主运行时可用；没有权限时不能假设能力存在。

- `python.path/source/version/packages` 是有限隔离探针的诊断结果，不是要求安装或运行 Python。
- `office.com` 是只读注册表信息，ProgID 不证明软件品牌、许可、可用性或转换成功。
- `office.libreOfficePath` 是安装文件候选，不是启动指令。
- `office.conversionVerified` 固定为 `false`；探针不启动外部 Office、不导出、不重算。

探测缓存 2 分钟，多个任务共享一次探测；子进程隐藏窗口，有 3500ms 超时与 32KiB 输出上限。不要重复轮询、逐目录搜软件、借用其他任务或私有应用运行时。

环境变量 `AETHER_OFFICE_PYTHON`、`AETHER_OFFICE_SOFFICE`、`AETHER_OFFICE_RUNTIME_ROOT` 只由部署管理员配置，不接受模型提供的程序路径。不得安装共享依赖、批量结束用户的办公进程或关闭用户文档。所有默认办公交付继续留在 Aether 内。
