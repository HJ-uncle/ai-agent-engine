/**
 * useBreakpoint — 响应式断点 Hook
 *
 * 统一断点定义，是项目中所有响应式判断的唯一来源。
 * 禁止在组件内自行写 `window.innerWidth` 判断。
 *
 * 断点：
 *  - mobile  : ≤ 767 px
 *  - tablet  : 768 – 1023 px
 *  - desktop : ≥ 1024 px
 *
 * 平板默认走桌面布局（仅在 mobile 断点切换为移动 Shell）。
 */
import { useEffect, useState } from 'react'

export const BP = {
  mobile: 767,
  desktop: 1024,
} as const

export type Breakpoint = 'mobile' | 'tablet' | 'desktop'

const QUERIES: Record<Breakpoint, string> = {
  mobile: `(max-width: ${BP.mobile}px)`,
  tablet: `(min-width: ${BP.mobile + 1}px) and (max-width: ${BP.desktop - 1}px)`,
  desktop: `(min-width: ${BP.desktop}px)`,
}

function getCurrent(): Breakpoint {
  if (typeof window === 'undefined') return 'desktop'
  if (window.matchMedia(QUERIES.mobile).matches) return 'mobile'
  if (window.matchMedia(QUERIES.tablet).matches) return 'tablet'
  return 'desktop'
}

export function useBreakpoint(): Breakpoint {
  const [bp, setBp] = useState<Breakpoint>(getCurrent)

  useEffect(() => {
    if (typeof window === 'undefined') return

    const mqls = (Object.keys(QUERIES) as Breakpoint[]).map(k => ({
      key: k,
      mql: window.matchMedia(QUERIES[k]),
    }))

    const update = () => setBp(getCurrent())

    // 兼容旧 Safari：addEventListener / addListener 双写法
    mqls.forEach(({ mql }) => {
      if (mql.addEventListener) mql.addEventListener('change', update)
      else mql.addListener(update)
    })

    // 初次同步一次（避免 SSR / 首次渲染窗口尺寸已变化）
    update()

    return () => {
      mqls.forEach(({ mql }) => {
        if (mql.removeEventListener) mql.removeEventListener('change', update)
        else mql.removeListener(update)
      })
    }
  }, [])

  return bp
}

/** 便捷 Hook：是否移动端 */
export function useIsMobile(): boolean {
  return useBreakpoint() === 'mobile'
}
