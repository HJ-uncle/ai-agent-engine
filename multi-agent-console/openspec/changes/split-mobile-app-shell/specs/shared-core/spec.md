## ADDED Requirements

### Requirement: Core 层目录与边界

系统 SHALL 在 `src/core/` 下集中存放与 UI 框架解耦的领域代码，目录结构必须包含 `api/`、`store/`、`hooks/`、`domain/`、`types/`、`utils/` 六个子目录。

#### Scenario: 目录存在且 lint 强制
- **WHEN** 开发者执行 `npm run lint`
- **THEN** ESLint 规则 `no-restricted-imports` 报错任何 `src/core/` 内文件出现 `from 'antd'`、`from 'antd-mobile'`、`from 'react-dom'`、`from 'monaco-editor'`、`from '@xterm/...'` 的 import

#### Scenario: 共享 store 跨入口可用
- **WHEN** 桌面入口和移动入口分别在浏览器同源下打开
- **THEN** 二者从 `@core/store` 导入的同名 store 操作的是同一份 `localStorage` 持久化数据

### Requirement: TypeScript 路径别名

`tsconfig.json` MUST 提供 `@core/*`、`@web/*`、`@mobile/*` 三个 path alias，且 craco/webpack 配置 MUST 同步该 alias。

#### Scenario: 三层 alias 解析正确
- **WHEN** 任意源文件写 `import { x } from '@core/store/chat'`
- **THEN** TypeScript 编译能解析到 `src/core/store/chat.ts`，webpack 也能正确打包

### Requirement: Core 层 UI 无关性

`src/core/` 下任何文件 MUST NOT 直接 import React DOM、Antd、Antd-Mobile、Monaco、Xterm 或任何浏览器 DOM 专属 API（如 `document.createElement`），但 SHALL 允许 import `react`（仅用于 hooks / context）。

#### Scenario: Core 可被 RN 入口直接消费
- **WHEN** 未来新增 `src/native/index.tsx`（RN 入口）import `@core/store` 与 `@core/api`
- **THEN** 该 import 不会引入任何 web-only 依赖、不会因缺少 `window` 报错

### Requirement: 既有代码迁移完整性

下列原始路径的全部代码 MUST 迁移到 core 对应位置且不残留旧文件：

- `src/store/*`         → `src/core/store/*`
- `src/api/*`           → `src/core/api/*`
- `src/types/*`         → `src/core/types/*`
- `src/hooks/useBreakpoint.ts` → `src/core/hooks/useBreakpoint.ts`
- `src/components/panels/index.tsx` 内的纯逻辑（面板配置、ID 常量）→ `src/core/domain/panels.ts`

#### Scenario: 旧路径不再存在
- **WHEN** 在仓库根执行 `find src/store src/api src/types -type f` 
- **THEN** 命令返回空列表

#### Scenario: 全部 import 已重写
- **WHEN** 执行 `grep -r "from '\\.\\./store" src/web src/mobile`
- **THEN** 命令返回空，所有引用均改为 `@core/store`
