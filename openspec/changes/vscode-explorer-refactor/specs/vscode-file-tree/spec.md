## ADDED Requirements

### Requirement: 层级树结构与渲染
文件树 SHALL 以无限级嵌套树形式呈现工作区文件系统，每个节点对应一个文件或目录，节点高度固定 22 px，使用 `rc-tree` 内置 `virtual={true}` 虚拟滚动，单目录 ≥ 5 万文件时首次展开耗时 SHALL < 200 ms，内存增长 SHALL < 50 MB。

#### Scenario: 展开大目录
- **WHEN** 用户点击展开包含 50,000 个子文件的目录节点
- **THEN** 所有子节点在 200 ms 内渲染完毕，页面无明显卡顿，内存增量 < 50 MB

#### Scenario: 折叠目录
- **WHEN** 用户点击已展开目录的折叠箭头
- **THEN** 目录折叠，子节点从 DOM 中卸载（虚拟化），箭头图标切换为折叠状态

### Requirement: 多选操作
文件树 SHALL 支持 Ctrl+Click 切换单个节点选中状态，Shift+Click 范围选中两个节点之间所有可见节点。

#### Scenario: Ctrl+Click 多选
- **WHEN** 用户按住 Ctrl 并依次点击三个不连续文件节点
- **THEN** 三个节点均高亮显示为已选中状态

#### Scenario: Shift+Click 范围选
- **WHEN** 用户先点击节点 A，再按住 Shift 点击节点 B
- **THEN** A 到 B 之间所有可见节点均被选中

### Requirement: 拖拽排序
文件树 SHALL 支持节点拖拽至同级或跨级目标目录，拖拽过程中目标目录高亮，释放后执行文件系统移动操作，并刷新树结构。

#### Scenario: 文件拖拽至目录
- **WHEN** 用户将文件节点拖入另一个目录节点
- **THEN** 文件被移动至目标目录，文件树刷新，原位置节点消失，目标目录下出现该节点

### Requirement: Material Icon Theme 图标体系
每个文件树节点 SHALL 根据文件扩展名通过 `vscode-icons-js` 获取对应 svg 图标名称；若 `vscode-icons-js` 返回空值，SHALL fallback 至 `default_file.svg`（文件）或 `default_folder.svg` / `default_folder_opened.svg`（目录）。

#### Scenario: 已知扩展名匹配图标
- **WHEN** 节点文件名为 `index.ts`
- **THEN** 节点左侧显示 TypeScript 专属图标（`file_type_typescript.svg`）

#### Scenario: 未知扩展名 fallback
- **WHEN** 节点文件名为 `Makefile`（无扩展名）
- **THEN** 节点左侧显示 `default_file.svg` 兜底图标

### Requirement: 右键上下文菜单
右键点击文件树节点时 SHALL 弹出包含以下操作的菜单：新建文件（Ctrl+N）、新建文件夹（Ctrl+Shift+N）、重命名（F2）、删除（Delete）、复制路径（Ctrl+Shift+C）、在终端中打开（Ctrl+\`）、在 Git 中查看历史（Ctrl+G）。快捷键 SHALL 在节点聚焦时全局响应。

#### Scenario: 新建文件
- **WHEN** 用户右键目录节点并选择"新建文件"
- **THEN** 在该目录下创建名称输入框，用户确认后创建空文件并在编辑器中打开

#### Scenario: 重命名快捷键
- **WHEN** 节点聚焦时用户按下 F2
- **THEN** 节点名称进入内联编辑模式，用户可输入新名称后回车确认

#### Scenario: 删除操作
- **WHEN** 用户右键文件节点并选择"删除"，或按下 Delete 键
- **THEN** 弹出确认对话框；用户确认后文件移入系统回收站，树节点消失

#### Scenario: 复制路径
- **WHEN** 用户右键文件节点并选择"复制路径"
- **THEN** 该文件的绝对路径写入系统剪贴板，状态栏短暂提示"路径已复制"
