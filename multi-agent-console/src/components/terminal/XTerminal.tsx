/**
 * XTerminal — xterm.js 终端组件
 * 负责挂载 xterm、连接 WebSocket、处理 resize
 */
import React, { useEffect, useRef, useCallback } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'

export interface XTerminalProps {
  wsUrl: string
  terminalId: string
  /** 是否为当前激活的 Tab，切换时触发 re-fit + focus */
  isActive?: boolean
  onReady?: () => void
  onExit?: (code: number) => void
  onTitleChange?: (title: string) => void
  style?: React.CSSProperties
}

const XTerminal: React.FC<XTerminalProps> = ({
  wsUrl,
  terminalId,
  isActive,
  onReady,
  onExit,
  onTitleChange,
  style,
}) => {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef      = useRef<Terminal | null>(null)
  const fitRef       = useRef<FitAddon | null>(null)
  const wsRef        = useRef<WebSocket | null>(null)
  const resizeObserverRef = useRef<ResizeObserver | null>(null)

  const sendResize = useCallback((cols: number, rows: number) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'resize', cols, rows }))
    }
  }, [])

  useEffect(() => {
    if (!containerRef.current) return

    // ── 动态读取当前主题色（响应 light / dark） ──────────────────────────
    const cs = getComputedStyle(document.documentElement)
    const getVar = (name: string, fallback: string) =>
      (cs.getPropertyValue(name).trim() || fallback)
    const isDark = document.documentElement.getAttribute('data-theme') !== 'light'
    const termBg = isDark ? '#000000' : '#FFFFFF'
    const termFg = isDark ? '#F5F5F7' : '#1D1D1F'

    // ── 初始化 xterm ─────────────────────────────────────────────────────
    const term = new Terminal({
      theme: {
        background: termBg,
        foreground: termFg,
        cursor: getVar('--color-accent', '#0A84FF'),
        selectionBackground: isDark ? 'rgba(10,132,255,0.30)' : 'rgba(0,122,255,0.22)',
        black: '#000000', brightBlack: '#666666',
        red: '#FF453A', brightRed: '#FF6961',
        green: '#30D158', brightGreen: '#4ADE80',
        yellow: '#FFD60A', brightYellow: '#FFE55C',
        blue: '#0A84FF', brightBlue: '#409CFF',
        magenta: '#BF5AF2', brightMagenta: '#D670D6',
        cyan: '#64D2FF', brightCyan: '#A6E1FA',
        white: '#E5E5EA', brightWhite: '#FFFFFF',
      },
      fontFamily: 'var(--font-mono), "Cascadia Code", "JetBrains Mono", Menlo, Consolas, monospace',
      fontSize: 13,
      lineHeight: 1.3,
      cursorBlink: true,
      cursorStyle: 'bar',
      scrollback: 5000,
      allowTransparency: false,
    })

    const fitAddon = new FitAddon()
    const webLinksAddon = new WebLinksAddon()
    term.loadAddon(fitAddon)
    term.loadAddon(webLinksAddon)
    term.open(containerRef.current)

    // 延迟 fit：等容器真正完成布局后再计算尺寸
    requestAnimationFrame(() => {
      try { fitAddon.fit() } catch { /* ignore */ }
    })

    termRef.current = term
    fitRef.current = fitAddon

    // 标题变化
    term.onTitleChange(title => onTitleChange?.(title))

    // ── 建立 WebSocket ───────────────────────────────────────────────────
    const ws = new WebSocket(wsUrl)
    wsRef.current = ws

    ws.onopen = () => {
      onReady?.()
      // 等 fit 完成后再发送尺寸（rAF 保证顺序）
      requestAnimationFrame(() => {
        try { fitAddon.fit() } catch { /* ignore */ }
        const { cols, rows } = term
        sendResize(cols, rows)
      })
    }

    ws.onmessage = (evt) => {
      try {
        const msg = JSON.parse(evt.data)
        if (msg.type === 'output') {
          term.write(msg.data)
        } else if (msg.type === 'exit') {
          term.write(`\r\n\x1b[90m[进程已退出，退出码: ${msg.code}]\x1b[0m\r\n`)
          onExit?.(msg.code)
        }
      } catch { /* ignore */ }
    }

    ws.onclose = () => {
      term.write('\r\n\x1b[90m[连接已断开]\x1b[0m\r\n')
    }

    ws.onerror = () => {
      term.write('\r\n\x1b[31m[WebSocket 错误]\x1b[0m\r\n')
    }

    // ── 剪贴板工具函数 ────────────────────────────────────────────────────
    /** 写入剪贴板（优先 Clipboard API，降级 execCommand） */
    const copyText = (text: string) => {
      if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(text).catch(() => fallbackCopy(text))
      } else {
        fallbackCopy(text)
      }
    }
    const fallbackCopy = (text: string) => {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.cssText = 'position:fixed;opacity:0;pointer-events:none'
      document.body.appendChild(ta)
      ta.focus(); ta.select()
      try { document.execCommand('copy') } catch {}
      document.body.removeChild(ta)
    }

    // ── 自定义按键拦截（必须在 onData 之前注册）────────────────────────────
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true

      // Ctrl+C：有选中内容 → 复制到剪贴板；无选中 → 正常发 ^C 给 PTY
      if (e.ctrlKey && e.key === 'c') {
        const sel = term.getSelection()
        if (sel) {
          copyText(sel)
          term.clearSelection()
          return false   // 阻止 xterm 把 ^C 发给 PTY
        }
        return true      // 无选中 → 照常发 ^C（中断命令）
      }

      // Ctrl+V：return false 阻止 xterm 把 \x16 发给 PTY
      // 浏览器的 paste 事件仍然会触发 → xterm.js 内部 textarea 收到后通过 onData 发出
      if (e.ctrlKey && e.key === 'v') {
        return false
      }

      return true
    })

    // 用户输入 → WebSocket
    term.onData(data => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'input', data }))
      }
    })

    // ── ResizeObserver 自动 fit（防抖：拖动停止后才执行，避免连续触发乱屏）──
    let rafId = 0
    let debounceTimer = 0
    const doFit = () => {
      cancelAnimationFrame(rafId)
      rafId = requestAnimationFrame(() => {
        try {
          fitAddon.fit()
          sendResize(term.cols, term.rows)
        } catch { /* ignore */ }
      })
    }
    const ro = new ResizeObserver(() => {
      // debounce 80ms：拖动过程中不断推迟，松手后才真正执行
      clearTimeout(debounceTimer)
      debounceTimer = window.setTimeout(doFit, 80)
    })
    ro.observe(containerRef.current)
    resizeObserverRef.current = ro

    // ── 清理 ─────────────────────────────────────────────────────────────
    return () => {
      ro.disconnect()
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close()
      }
      term.dispose()
      termRef.current = null
      fitRef.current = null
      wsRef.current = null
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wsUrl, terminalId])

  // ── Effect 2：Tab 切换时 re-fit + focus ──────────────────────────────────
  useEffect(() => {
    if (!isActive) return
    const id = requestAnimationFrame(() => {
      try {
        fitRef.current?.fit()
        const term = termRef.current
        if (term) {
          sendResize(term.cols, term.rows)
          term.focus()
        }
      } catch { /* ignore */ }
    })
    return () => cancelAnimationFrame(id)
  }, [isActive, sendResize])

  return (
    // 外层负责背景色、间距；不挂 ref，不影响 FitAddon 尺寸计算
    <div
      style={{
        width: '100%',
        height: '100%',
        background: 'var(--color-bg-primary)',
        overflow: 'hidden',
        boxSizing: 'border-box',
        ...style,
      }}
    >
      {/*
        xterm.js 挂载点：
        - 不能有 padding / margin，FitAddon 依赖 clientWidth/clientHeight 精确计算行列数
        - overflow: hidden 防止滚动条出现在 xterm 之外（xterm 自带内部滚动）
      */}
      <div
        ref={containerRef}
        style={{
          width: '100%',
          height: '100%',
          overflow: 'hidden',
        }}
      />
    </div>
  )
}

export default XTerminal