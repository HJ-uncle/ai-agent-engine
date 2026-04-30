/**
 * settings/shared.ts
 * 设置页面共用的 inline style 常量 — 全部引用 CSS token 变量
 */
import type React from 'react'

/** 标准输入框样式（覆盖 Antd 默认） */
export const INPUT_STYLE: React.CSSProperties = {
  background: 'var(--color-fill-secondary)',
  border: '1px solid var(--color-gray-4)',
  color: 'var(--color-label)',
  borderRadius: 'var(--radius-sm)',
}

/** 内联 code 片段样式 */
export const CODE_STYLE: React.CSSProperties = {
  background: 'var(--color-fill)',
  padding: '1px 6px',
  borderRadius: 'var(--radius-xs)',
  fontSize: 12,
  fontFamily: 'var(--font-mono)',
  color: 'var(--color-teal)',
}

/** 辅助说明文字 */
export const MUTED_TEXT: React.CSSProperties = {
  color: 'var(--color-label-secondary)',
  fontSize: 12,
}

/** 警告图标色 */
export const WARNING_COLOR = 'var(--color-orange)'
/** 成功图标色 */
export const SUCCESS_COLOR = 'var(--color-green)'
/** 危险图标色 */
export const DANGER_COLOR  = 'var(--color-red)'
/** 辅助图标色 */
export const MUTED_COLOR   = 'var(--color-label-tertiary)'
/** 强调色 */
export const ACCENT_COLOR  = 'var(--color-accent)'
