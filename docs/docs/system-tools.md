# 内置工具与能力加载

本文按 2026-11-17 的 [注册工厂](../../src/tools/registry-factory.ts)、[模式过滤](../../src/tools/tool-profile.ts)、[默认可见性](../../src/tools/tool-exposure.ts) 和 [模型按需加载](../../src/tools/model-tool-loading.ts) 核对。它是维护者的能力索引；精确参数以运行时工具 schema 为准。

## 注册、展示和授权

“引擎支持”“当前会话已注册”“本次请求向模型展开”是三个层次。Work 使用 general profile，Code 使用 code profile；OSM 是另一项方法论配置。已注册的非核心工具可通过 `load_tools` 展开，不能加载未授权、未启用或不存在的工具。

默认执行集按 profile 精简。管理工具包默认关闭，仅主代理 Work 会话能选择；用户通过结构化 toolkits 字段授权，聊天文字中的标签不授予权限。明确 allowedTools 上限继续生效。`allowedTools: []` 仍保留可信会话计划能力，不应解释为所有管理工具可用。

## 当前工具目录

| 功能 | 当前标准名称 | 说明 |
| --- | --- | --- |
| 文件与检索 | read_file、write_file、edit_file、list_files、delete_file、create_dir、glob、grep | 统一读文件包含类型识别、分页/预览与 OCR 路径；写入和删除受工作区与变更记录约束 |
| 命令 | execute_cmd、command_output、cancel_command | 启动、继续读取和取消真实命令任务；不要用旧 Task 队列身份查询 |
| 代码分析 | codegraph、code_diagnose | 图查询/索引与语言诊断；只读研究子代理不能建立索引 |
| 计划与提问 | plan_update、ask_user | 更新会话计划；提问与操作批准语义分离 |
| 历史 | search_history | 按权限查询历史，不能把摘要当成完整原文 |
| 技能使用 | list_skills、get_skill、run_skill_script | 获取可用技能及执行已绑定脚本；不是技能配置管理 |
| 办公 | office_document、office_inspect、office_environment | 创建/编辑、结构检查和环境能力；Code 只包含其中的 office_inspect |
| 工作台 | workbench_context、workbench_open、workbench_render | 查询状态、打开文件、请求渲染/检查；依赖前端宿主能力 |
| 成果 | deliver_files、report_artifacts | 主代理正式交付与子代理成果报告，使用不同归属 |
| 网络 | web_fetch、http_request | 受网络策略约束；不是浏览器自动化 |
| 子代理启动/复用 | subagent、subagent_start、subagent_directory、subagent_followup | 研究、执行、通用模板；完成后的可恢复上下文可继续使用 |
| 子代理协作 | subagent_send、subagent_wait、subagent_cancel、subagent_participants、subagent_inbox、subagent_request_input、subagent_read_result | 收件与已读分离、批量等待、状态与完整结果 |
| 记忆 | remember、recall、search_memory、list_memories、forget、link_memories | 按当前有效 global/session scope 授权；Code 仅显式启用记忆时扩展 |
| 浏览器 | browser_tabs/open/navigate/snapshot/screenshot/save_screenshot/click/fill/scroll/press_key/wait/console/network/network_request/set_viewport/close | 每个斜线后名称均使用 browser_ 前缀；依赖浏览器桥接和当前拥有的执行身份 |

浏览器目录的具体 schema 来自 [browser-tools.ts](../../src/tools/browser/browser-tools.ts)。截图内联、保存到工作区和成果交付是不同动作；不应把预览等同已写入可交付文件。

## 按需管理和兼容工具

内置管理包包括 Agent（5）、Skill（6）、知识库（11）、自动化（6）、插件（12）、MCP（7）。完整选用、持久化、批准恢复规则见 [会话工具包](../session-toolkits.md)，工具名以 [toolkits.ts](../../src/tools/toolkits.ts) 为准。插件公开接口仅在同级前端的 HTML API 参考维护，此页不重复定义插件接口。

旧 `todo_list/create/update/delete` 和 `task_list/status/cancel` 为按需兼容能力，默认不展开。新计划使用 plan_update；旧 task_cancel 只取消 pending，不负责运行中命令或子代理。

Work 显式选中的知识资源可以授予只读知识工具，不要求启用知识库管理包；写入管理是独立授权。MCP 业务工具来自已允许的服务，名称为 `mcp_<serverId>_<toolName>`，与 mcp_server_* 配置管理工具分开。

## 已移除的旧名称

`run_command` 和 `smart_read` 仅在旧配置归一化时映射为 execute_cmd/read_file，不注册独立工具别名。旧 agent_do_* 映射为 agent_* 管理工具，不能用旧名绕过权限。

install_package、list_packages、get_time、calculate、get_tool_details、get_current_context、glob_search、grep_search 已从公开注册表移除。独立 read_image/get_context 不是当前标准目录；不要按旧示例调用。装包需要使用已授权的命令或相应办公环境能力。

## 子代理与技能边界

内置 research 角色只读，不执行命令/脚本、不写文件、不建立索引；executor 处理实际产物；general 处理混合任务。模板可启动多个实例，不代表只允许三个子代理。默认父会话并发 5，配置最高 16；等待回执不等同任务成功。

普通技能读接口与管理权限分开。OSM off/balanced 隐藏 os-* 方法论技能，methodology/max 才启用；普通办公与项目技能仍由绑定和访问范围决定。技能内容不是身份、工具权限或外部发送授权的替代品。

本次是源码目录核对，未运行所有工具或验证第三方 MCP、宿主浏览器、Office 运行环境。
