## ADDED Requirements

### Requirement: 构建脚本先编译主包再复制产物到 bin/
`scripts/build-sdk.js` SHALL 在 `sdk-package/` 的 `prepack` 阶段，将 `../dist/main.js` 及 `../node_modules/` 复制到 `bin/`。

#### Scenario: 主包已构建时 copy-bin 成功
- **WHEN** `../dist/main.js` 存在，执行 `node scripts/copy-bin.js`
- **THEN** `bin/main.js` 和 `bin/node_modules/` 被创建/更新，脚本以 0 退出码退出

#### Scenario: 主包未构建时 copy-bin 给出明确错误
- **WHEN** `../dist/main.js` 不存在，执行 `node scripts/copy-bin.js`
- **THEN** 脚本以非 0 退出码退出，错误信息包含 `'dist/main.js not found'` 和操作提示

### Requirement: npm pack 产物包含 dist/ 和 bin/ 但排除源码
`sdk-package/package.json` 的 `files` 字段 SHALL 只包含 `dist/`（TypeScript 编译产物）和 `bin/`（运行时），不包含 `src/`。

#### Scenario: pack 后的 tgz 可被安装并正常 require
- **WHEN** `.tgz` 安装到 wuzu-client 后，`require('@wuzu/agent-engine-sdk')` 被调用
- **THEN** 返回包含 `AgentEngineSdk` 类的模块，不报 `MODULE_NOT_FOUND`

#### Scenario: pack 后的 tgz 包含类型定义文件
- **WHEN** `.tgz` 安装后，TypeScript 编译 wuzu-client 时引用 `AgentEngineSdkConfig`
- **THEN** 类型正确解析，无 TS 类型错误

### Requirement: SDK 包的 package.json 声明正确的 main 和 types 字段
`sdk-package/package.json` SHALL 声明 `"main": "dist/index.js"` 和 `"types": "dist/index.d.ts"`，确保 CJS 和 TypeScript 均可正确引用。

#### Scenario: CJS require 入口正确
- **WHEN** `require('@wuzu/agent-engine-sdk')` 在 Node CJS 环境中执行
- **THEN** 返回包含 `AgentEngineSdk` 的模块对象

#### Scenario: TypeScript 类型入口正确
- **WHEN** `import type { AgentEngineSdkConfig } from '@wuzu/agent-engine-sdk'` 在 TypeScript 文件中使用
- **THEN** 类型系统正确识别，不报 `TS2307` 错误
