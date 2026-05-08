/**
 * core/domain/panels.ts — 与 UI 框架无关的面板领域常量
 *
 * 这里只放纯数据 / 类型，不允许出现 React、antd、antd-mobile 任何引用。
 * 桌面 (`web/`) 与移动 (`mobile/`) 各自的渲染层从这里读取 ID 与配置元数据。
 */

// ── PanelKey ────────────────────────────────────────────────────────
export type PanelKey =
  | 'chat'
  | 'agents'
  | 'mcp'
  | 'knowledge'
  | 'tools'
  | 'memory'
  | 'tasks'
  | 'history'
  | 'explorer'

/** 桌面 Activity Bar 顺序（不含 icon，icon 由 UI 层注入） */
export const ACTIVITY_KEYS: { key: PanelKey; label: string }[] = [
  { key: 'explorer',  label: '资源管理器' },
  { key: 'chat',      label: '对话' },
  { key: 'agents',    label: 'Agents' },
  { key: 'mcp',       label: 'MCP Servers' },
  { key: 'knowledge', label: '知识库' },
  { key: 'tools',     label: '工具列表' },
  { key: 'memory',    label: '记忆存储' },
  { key: 'tasks',     label: '任务' },
]

/** 移动端 TabBar 默认 4 项 */
export const MOBILE_TAB_KEYS: { key: PanelKey | 'me'; label: string }[] = [
  { key: 'chat',    label: '对话' },
  { key: 'history', label: '会话' },
  { key: 'agents',  label: '智能体' },
  { key: 'me',      label: '我的' },
]

// ── 工具来源元数据 ───────────────────────────────────────────────────
export const TOOL_SOURCE_META: Record<
  string,
  { label: string; color: string; bg: string }
> = {
  builtin: { label: 'builtin', color: '#4ade80', bg: 'rgba(74,222,128,0.08)' },
  skill:   { label: 'skill',   color: '#c084fc', bg: 'rgba(192,132,252,0.08)' },
  mcp:     { label: 'MCP',     color: '#38bdf8', bg: 'rgba(56,189,248,0.08)' },
}

// ── Todo 状态 / 优先级元数据 ─────────────────────────────────────────
export type TodoStatus = 'pending' | 'in_progress' | 'done' | 'cancelled'
export type TodoPriority = 'high' | 'medium' | 'low'

export const TODO_STATUS_CFG: Record<
  TodoStatus,
  { color: string; bg: string; label: string; dot: string }
> = {
  pending:     { color: '#d29922', bg: 'rgba(210,153,34,0.12)', label: '待办',   dot: '#d29922' },
  in_progress: { color: '#38bdf8', bg: 'rgba(56,189,248,0.12)', label: '进行中', dot: '#38bdf8' },
  done:        { color: '#4ade80', bg: 'rgba(74,222,128,0.12)', label: '完成',   dot: '#4ade80' },
  cancelled:   { color: '#6e7681', bg: 'rgba(110,118,129,0.1)', label: '已取消', dot: '#6e7681' },
}

export const TODO_PRIORITY_CFG: Record<TodoPriority, { color: string; label: string }> = {
  high:   { color: '#f85149', label: '高' },
  medium: { color: '#d29922', label: '中' },
  low:    { color: '#4ade80', label: '低' },
}
