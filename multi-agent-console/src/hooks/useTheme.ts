/**
 * useTheme — 主题模式管理
 * 持久化到 localStorage，优先级：用户设置 > 系统偏好
 * 通过切换 <html data-theme="..."> 属性 + 向 tokens.css 的 [data-theme] 选择器生效
 */
import { useState, useEffect, useCallback } from 'react'

export type ThemeMode = 'dark' | 'light' | 'system'

const STORAGE_KEY = 'ui.themeMode'

function applyTheme(mode: ThemeMode) {
  const root = document.documentElement
  if (mode === 'system') {
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
    root.setAttribute('data-theme', prefersDark ? 'dark' : 'light')
  } else {
    root.setAttribute('data-theme', mode)
  }
}

export function useTheme() {
  const [mode, setModeState] = useState<ThemeMode>(() => {
    try {
      return (localStorage.getItem(STORAGE_KEY) as ThemeMode) ?? 'dark'
    } catch {
      return 'dark'
    }
  })

  // 初始化 & 变化时应用
  useEffect(() => {
    applyTheme(mode)
    // 如果是 system 模式，监听系统变化
    if (mode === 'system') {
      const mq = window.matchMedia('(prefers-color-scheme: dark)')
      const handler = () => applyTheme('system')
      mq.addEventListener('change', handler)
      return () => mq.removeEventListener('change', handler)
    }
  }, [mode])

  const setMode = useCallback((next: ThemeMode) => {
    try { localStorage.setItem(STORAGE_KEY, next) } catch {}
    setModeState(next)
  }, [])

  const isDark = mode === 'dark' || (mode === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)

  return { mode, setMode, isDark }
}
