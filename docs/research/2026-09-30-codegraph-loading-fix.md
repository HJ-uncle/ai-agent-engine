# CodeGraph 加载失败修复

用户截图报错：`codegraph 模块加载异常：CodeGraph.openSync 不可用`，调用为 `action=status`、项目路径 `D:\dev\aether-code`。这是代码图组件加载缺陷；截图中列目录和读文件继续成功，不能把它解释为整轮任务、远端连接或 Code OSS 编辑器失败。

## 根因与之前漏检原因

开发引擎与前端随包运行时均使用 `@colbymchenry/codegraph@1.6.0`。其 `npm-sdk.js` 使用 `module.exports = require(resolveLibrary())` 转出平台包。原生 Node ESM `await import()` 得到 `default` / `module.exports`，没有静态可推断的顶层 `CodeGraph`；真正的类在 `module.default.CodeGraph`，其中 `openSync` 正常存在。

引擎只读取 `module.CodeGraph`，所以即使包安装完整，也会在任何查询前报错。开发和打包的旧 dist 已分别复现。编译仅使用 tsc，没有打包器转换问题。

之前 `scripts/verify-engine-runtime.mjs` 检查的是 `require(package).CodeGraph`。该路径能成功，绕过了产品实际使用的 ESM loader，因此 `codegraph:true` 没有证明聊天工具可用。这是此前验收缺口。

## 修改

- 共享 loader 兼容命名导出与 `default.CodeGraph`，验证 openSync/isInitialized/init/recreate 四个实际所需方法；工具、HTTP 路由和系统提示词探测共享修复。
- 删除错误的“必须使用 named import”注释；真正接口缺失时提示更新配套运行时，不再猜测用户包未安装或要求修改连接令牌。
- 随包自检调用同一份引擎 ESM loader，并在临时项目真正初始化、索引 TypeScript、查询符号、关闭及重新打开数据库。

## 验证

引擎类型检查及构建通过，buildId：`sha256:70b9739bb0abec855348f24c59dc7e1e495ae60e91eba946981ac7c54118fe41`。

| 验证层 | 结果 | 范围 |
|---|---|---|
| 模块导出契约 | 7/7 通过 | 命名/CJS namespace、缺失 API、错误 module 对象 |
| 真实 SDK 集成 | 3/3 通过 | 不 mock：工具和 HTTP、建索引、符号/文件/调用/影响查询、关闭重开、重建 |
| 编译后原生 Node 24.20.0 | 14/14 通过 | 原生 ESM、全部 agent action、真实回环 HTTP、提示词索引发现、持久化/重建 |
| Aether 开发用 Electron Node 22.22.1 | 14/14 通过 | 同一编译后入口与上述真实操作，不经过 Vitest 的模块转换 |
| 更新后的随包运行时 | 自检通过，随后原生探针 14/14 通过 | 使用自身 Node 24.20.0、依赖与 dist，真实创建索引/全部图查询/HTTP 重建 |

前端 `resources/engine/win32-x64` 已由正式 prepare 脚本更新为上述 buildId（414 个依赖包、18,709 个文件）。加强后的 verify 使用实际引擎 ESM loader，初始化、索引、符号查询和数据库重开均通过。未重装或关闭用户运行中的应用。

追加随包原生探针首次返回 Windows 访问冲突退出码 `-1073741819`，无输出且未生成结果 JSON，不能计作通过。增加检查点日志后，在随包目录及首次相同的引擎工作目录各复跑 14/14 通过，未复现；尚不能归因为工作目录或本次加载器修复。首次残留的唯一测试目录经精确路径/非链接/无相关进程校验后清理，失败记录保留。

测试仅创建带唯一前缀的临时项目；清理前校验路径、非链接和索引进程状态。没有建立、删除或重建用户项目索引，没有调用真实模型，没有停止用户当前引擎。没有修改前端交互代码，也没有将本轮定向验证冒充全项目测试。

沙箱首次构建因 tsx 调用 Windows 用户信息接口失败（uv_os_get_passwd/ENOMEM）；正常用户环境构建成功。仓库缺少 ESLint 配置，未将 ESLint 称为通过；类型检查、构建和 diff 检查均通过。

证据：

- [10 项回归日志](./2026-09-30-codegraph-tests.txt)
- [构建日志](./2026-09-30-codegraph-build-native.txt)
- [原生 Node 结果](./2026-09-30-codegraph-native-node-result.json)
- [Electron Node 结果](./2026-09-30-codegraph-electron-node-result.json)
- [原生验收脚本](./2026-09-30-codegraph-native-probe.mjs)
- [随包更新与真实自检](./2026-09-30-codegraph-packaged-prepare.txt)
- [随包原生验收](./2026-09-30-codegraph-packaged-node-result.json)
- [首次相同工作目录复测](./2026-09-30-codegraph-packaged-node-original-cwd-result.json)
- [首次原生异常记录](./2026-09-30-codegraph-packaged-first-failure.json)

更新产物后，现有进程仍保留旧模块。待当前任务结束，在 Aether 设置中重启引擎或退出后重开应用，再重新查询即可加载修复；已经保存的历史失败记录不会被自动改写为成功。远端部署需要更新并重启远端引擎进程。
