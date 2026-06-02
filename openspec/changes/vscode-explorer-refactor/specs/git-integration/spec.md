## ADDED Requirements

### Requirement: Git 状态图标
文件树节点右侧 SHALL 实时显示 git 工作区状态徽章：未跟踪（U，绿色）、已修改（M，黄色）、已暂存（A，蓝色）、冲突（C，红色）。状态 SHALL 在文件树刷新时重新获取，刷新间隔 ≤ 5 秒。

#### Scenario: 修改文件后状态更新
- **WHEN** 工作区中某文件被修改后文件树刷新
- **THEN** 该文件节点右侧显示黄色"M"徽章

#### Scenario: 无 git 仓库时不显示徽章
- **WHEN** 当前工作区目录不是 git 仓库
- **THEN** 所有节点不显示任何 git 状态徽章，无报错

### Requirement: Git 历史面板
点击右键菜单"在 Git 中查看历史"或按 Ctrl+G 时，系统 SHALL 在编辑器区域打开 Git 历史面板，展示当前文件的 git log（作者、日期、哈希前 7 位、提交信息），点击任一提交记录可展开该提交与前一提交的 diff 预览（Monaco diff editor）。

#### Scenario: 打开 Git 历史面板
- **WHEN** 用户对有 git 历史的文件按 Ctrl+G
- **THEN** 编辑器区域打开 Git 历史面板，显示至少最近 20 条提交记录

#### Scenario: 展开 diff 预览
- **WHEN** 用户点击历史面板中某条提交记录
- **THEN** 面板下方展开 Monaco diff editor，左侧为该提交前版本，右侧为该提交后版本

### Requirement: 一键拉取（git pull --rebase）
Explorer 工具栏 SHALL 提供"拉取"按钮，点击后执行 `git pull --rebase`；若无冲突则提示成功并刷新文件树；若出现冲突则自动打开冲突文件列表，点击冲突文件后以 Monaco diff editor 双栏视图展示（OURS / THEIRS），用户可手动解决冲突后点击"标记为已解决"。

#### Scenario: 无冲突拉取成功
- **WHEN** 用户点击"拉取"按钮且远程无冲突
- **THEN** git pull --rebase 成功，状态栏显示"已拉取最新提交 N 条"，文件树刷新

#### Scenario: 拉取出现冲突
- **WHEN** git pull --rebase 产生合并冲突
- **THEN** 弹出冲突文件列表，点击任一文件自动打开 Monaco diff editor 双栏视图
