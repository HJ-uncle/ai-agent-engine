## ADDED Requirements

### Requirement: 虚拟滚动大目录性能
文件树 SHALL 在单目录包含 ≥ 5 万个文件时，首次展开节点耗时 < 200 ms（从点击到 DOM 渲染完成），内存占用增量 < 50 MB；通过 `rc-tree` 的 `virtual={true}` + 固定行高 22 px 实现。

#### Scenario: 5 万文件目录首次展开
- **WHEN** 文件树中存在含 50,000 个文件的目录，用户点击展开
- **THEN** 200 ms 内节点完成渲染，Performance 面板显示 JavaScript 堆内存增量 < 50 MB

#### Scenario: 滚动超大目录
- **WHEN** 用户在超大目录的文件列表中快速滚动
- **THEN** 滚动帧率保持 ≥ 30 fps，无明显卡顿

### Requirement: Ctrl+P 快速打开文件
系统 SHALL 提供 Ctrl+P 快速文件搜索面板，输入关键词后模糊匹配工作区内所有文件路径，结果列表 SHALL 在 100 ms 内呈现（工作区文件 ≤ 10 万），支持 ↑↓ 导航并按 Enter 打开。

#### Scenario: Ctrl+P 唤起快速打开
- **WHEN** 用户按下 Ctrl+P
- **THEN** 屏幕中央弹出快速文件搜索面板，输入框自动聚焦

#### Scenario: 模糊搜索结果
- **WHEN** 用户输入 "explo"
- **THEN** 100 ms 内列表展示包含 "explo" 的所有文件路径（高亮匹配字符）

### Requirement: 性能基准报告
项目 SHALL 提供性能基准脚本（`scripts/perf-benchmark.ts`），输出以下指标到 `reports/perf-baseline.json`：cold-start 时间（从进程启动到文件树可交互）、大文件夹展开时间（含 50,000 文件）、Ctrl+P 搜索响应时间（10 万文件索引）。

#### Scenario: 运行基准脚本
- **WHEN** 执行 `npm run perf:bench`
- **THEN** 脚本无报错运行完毕，`reports/perf-baseline.json` 包含三个指标的实测毫秒数
