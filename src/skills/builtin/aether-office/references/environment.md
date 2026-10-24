# 办公运行环境与转换证据

## 先读统一回执

调用 `office_environment`，参数为 `{}`。它不接受路径、命令或安装参数。仅宿主运行时可探测；隔离或受限运行时返回缺项，不会偷偷使用宿主。没有工具权限时不能假设能力存在。

- `python.path/source/version`：在标准安装目录、可信 PATH 或管理员配置根内实际找到且执行过隔离探针的解释器。`probe-failed` 表示探测超时或失败，不能当作可用。
- `python.packages`：固定办公模块能否导入及版本。探针使用 `-I -B`，不加载当前目录、`PYTHONPATH`、用户 site-packages，也不写 pycache；因此 `--user` 包可能不在这个解释器的证据范围。该回执不能证明整台机器不存在其他 Python。
- `office.com`：只读注册表发现的 Office/WPS ProgID、注册视图与服务程序是否存在。`Word.Application` / `Excel.Application` / `PowerPoint.Application` 也可能由 WPS 注册，不能根据名字猜品牌或许可。
- `office.libreOfficePath`：可信目录中的 soffice 文件候选。不得把 WPS 可执行文件当作 soffice，给它套 `--headless --convert-to` 参数。
- `office.conversionVerified` 固定为 `false`：探针不会启动 COM/Office、导出文件或完成公式重算。`registryStatus=unavailable` 只是无法读取，不能据此断言未安装。

单次结果缓存 2 分钟，多个任务共享同一次探测。解释器和注册表子进程均隐藏窗口，有 3500ms 超时和 32KiB 输出上限；不重复轮询，也不要逐目录搜索其他任务或私有软件依赖。

## 能力边界

| 能力 | 可做什么 | 不证明什么 |
| --- | --- | --- |
| office_document | 原生 DOCX/XLSX 创建、定点编辑、结构检查、版本保护 | Word/PPT 原版式渲染、任意 Excel 公式计算 |
| python-docx / python-pptx | 创建和编辑 DOCX/PPTX | 源格式分页、导出、视觉正确 |
| openpyxl | 读写 XLSX 及公式文本 | 公式已重算；空缓存不是 0 |
| reportlab | 新建 PDF | 与既有 DOCX/PPTX 的原版式相同 |
| PyMuPDF / pypdf / Pillow | 按库实际能力检查、处理 PDF/图片 | 新绘 PDF 等于源 PPT/DOCX 真正导出 |
| Office/WPS COM、LibreOffice | 可尝试的源格式转换或重算候选 | 注册/文件存在等于本次转换成功 |

源格式视觉验收必须从交付的那份 DOCX/PPTX/XLSX 实际导出/渲染，记录源文件版本、转换方法、输出页数/尺寸，并检查生成结果。自己重绘近似 PDF 不能标为源 PPT 已渲染。缺转换器或自动化失败时仍交付已成功生成的原文件，明确剩余未验证项。

## 独立依赖与有界进程

原生 `office_document` 不需要 pip。确需额外库时，在本角色的工作区创建独立 venv，通过该 venv 的完整解释器路径运行与安装，并使用固定版本；包安装是任务操作，不是环境探针。不要执行全局、`--user` 或共享 venv 的安装/升级/卸载，不借用其他角色、其他任务或 Codex 私有运行时。无可用解释器或安装不在任务权限内时报告缺项。

所有环境检查、COM 激活、重算、导出和关闭命令都必须显式传有限 `timeoutMs`。短探测上限 15000ms；普通单文档转换通常上限 60000ms，确需更久时基于文档规模给出有限期限。输出写到本任务路径并给出阶段回执，不能让无输出的 `execute_cmd` 无限等待。

超时后只取消当前任务持有的 command job，检查部分产物并记录失败；不要反复执行相同失败命令。不可按进程名称批量 kill Office/WPS，不可关闭用户文档。COM 可能附着已有实例；只关闭自己打开的文档，除非能证明应用由本任务独占创建，否则不调用应用 `Quit`。已导出的文件先核验，退出 COM 失败作为清理问题记录，不能把它等同于导出失败。

管理员可配置 `AETHER_OFFICE_PYTHON`、`AETHER_OFFICE_SOFFICE` 与 `AETHER_OFFICE_RUNTIME_ROOT`。配置只由部署环境提供；模型不能通过工具参数指定任意程序。无效的显式 Python 路径不会回退到其他解释器；管理员根必须是本地可信安装目录，不能指向任务目录或私有应用缓存。
