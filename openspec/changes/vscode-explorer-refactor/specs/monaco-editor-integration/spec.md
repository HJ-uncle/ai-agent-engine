## ADDED Requirements

### Requirement: Monaco Editor 多标签宿主
系统 SHALL 提供多标签编辑器区域，每个打开的文件对应一个标签页；标签页 SHALL 显示文件名，未保存时在文件名左侧显示"●"；标签页支持关闭（中键或×按钮）、拖拽重排序。

#### Scenario: 打开文件在新标签页
- **WHEN** 用户在文件树中单击文件节点
- **THEN** 系统在编辑器区域新建标签页打开该文件，并聚焦该标签页

#### Scenario: 重复打开同一文件
- **WHEN** 用户再次单击已打开的文件节点
- **THEN** 系统激活已有标签页，不创建重复标签

#### Scenario: 未保存标识
- **WHEN** 用户在编辑器中修改文件内容
- **THEN** 对应标签页文件名前显示"●"，标题栏追加"（已编辑）"

### Requirement: 语言高亮与 IntelliSense
Monaco Editor SHALL 支持 VS Code 声明的 150+ 种语言的语法高亮；对 TypeScript/JavaScript/JSON/CSS/HTML SHALL 提供内置 IntelliSense（无需外部 LSP）；其余语言仅高亮不提示。

#### Scenario: TypeScript 文件语法高亮
- **WHEN** 用户打开 `.ts` 文件
- **THEN** 编辑器以 TypeScript 语言模式渲染，关键字、类型、字符串等颜色正确

#### Scenario: 未知语言 fallback
- **WHEN** 用户打开 `.xyz` 后缀文件
- **THEN** 编辑器以纯文本模式打开，无语法错误，无崩溃

### Requirement: Undo/Redo 栈
编辑器 SHALL 维护独立的 undo/redo 栈（按标签页隔离）；Ctrl+Z 撤销，Ctrl+Y / Ctrl+Shift+Z 重做，行为与 VS Code 一致。

#### Scenario: 撤销编辑
- **WHEN** 用户输入若干字符后按 Ctrl+Z
- **THEN** 最近一次输入被撤销，光标回到撤销前位置

### Requirement: Ctrl+S 保存与自动格式化
Ctrl+S SHALL 保存当前标签页文件；保存前 SHALL 异步执行 prettier/eslint 格式化（规则读取项目根目录 `.prettierrc` 与 `.eslintrc`）；若配置文件不存在，SHALL 跳过格式化直接保存。Ctrl+K S SHALL 保存所有已修改标签页。

#### Scenario: 保存单个文件
- **WHEN** 用户按下 Ctrl+S
- **THEN** 当前文件执行格式化后写入磁盘，标签页"●"消失，标题栏"（已编辑）"消失

#### Scenario: 保存所有文件
- **WHEN** 用户按下 Ctrl+K S
- **THEN** 所有带"●"标识的标签页依次格式化并保存，全部"●"消失

### Requirement: 关闭未保存文件确认
关闭带"●"标识的标签页时 SHALL 弹出 VS Code 风格确认对话框，包含"保存""不保存""取消"三个按钮，默认聚焦"保存"按钮；按 Enter 等同于点击"保存"，按 Escape 等同于"取消"。

#### Scenario: 关闭未保存标签
- **WHEN** 用户点击带"●"标签页的关闭按钮
- **THEN** 弹出确认对话框，默认聚焦"保存"按钮

#### Scenario: 选择"不保存"
- **WHEN** 在确认对话框中点击"不保存"
- **THEN** 标签页关闭，文件磁盘内容不变，未保存的修改丢弃
