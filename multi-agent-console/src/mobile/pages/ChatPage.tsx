import React, { useCallback, useEffect, useRef, useState } from 'react'
import { UnorderedListOutline, AddOutline, AddCircleOutline, CloseOutline } from 'antd-mobile-icons'
import { useNavigate } from 'react-router-dom'
import { useSessionStore } from '@core/store/session'
import { useAgentStore } from '@core/store/agents'
import { useChat } from '@web/hooks/useChat'
import { workspaceApi } from '@core/api'
import type { Message } from '@core/types'
import { SessionsDrawer } from '../components/SessionsDrawer'
import { AgentPicker } from '../components/AgentPicker'
import { InputToolbox } from '../components/InputToolbox'
import { MessageBubble } from '../components/MessageBubble'
import styles from './ChatPage.module.css'

// ─── 轻量 Snack（替代 antd-mobile Toast，避免 React 18 unmountComponentAtNode 崩溃） ─

interface SnackItem { id: number; msg: string; icon: '✅' | '❌' | 'ℹ️' }

function SnackBar({ items }: { items: SnackItem[] }) {
  if (items.length === 0) return null
  return (
    <div style={{
      position: 'fixed', top: 60, left: '50%', transform: 'translateX(-50%)',
      display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8,
      zIndex: 9999, pointerEvents: 'none',
    }}>
      {items.map((s) => (
        <div key={s.id} style={{
          background: 'rgba(40,40,40,0.92)', color: '#eee',
          padding: '8px 16px', borderRadius: 20, fontSize: 14,
          display: 'flex', alignItems: 'center', gap: 6,
          boxShadow: '0 2px 12px rgba(0,0,0,0.4)',
          backdropFilter: 'blur(8px)',
          animation: 'fadeInDown 0.2s ease',
        }}>
          {s.icon} {s.msg}
        </div>
      ))}
    </div>
  )
}

let _snackCounter = 0
function useSnack() {
  const [items, setItems] = useState<SnackItem[]>([])
  const show = useCallback((msg: string, icon: SnackItem['icon'] = 'ℹ️', duration = 2000) => {
    const id = ++_snackCounter
    setItems((prev) => [...prev, { id, msg, icon }])
    setTimeout(() => setItems((prev) => prev.filter((s) => s.id !== id)), duration)
  }, [])
  return { items, show }
}

// ─── 常量 ──────────────────────────────────────────────────────────────────
const MAX_FILE_SIZE = 100 * 1024 * 1024

interface AttachmentItem {
  file: File
  previewUrl?: string
  encoding: 'utf-8' | 'base64'
}

// ─── 工具函数 ──────────────────────────────────────────────────────────────

function isBinary(fileName: string) {
  const BINARY_EXTS = ['.png','.jpg','.jpeg','.gif','.webp','.bmp','.svg','.ico','.pdf',
    '.zip','.tar','.gz','.7z','.rar','.mp4','.mov','.avi','.mp3','.wav','.ogg',
    '.exe','.bin','.wasm','.so','.dll']
  return BINARY_EXTS.includes(fileName.toLowerCase().slice(fileName.lastIndexOf('.')))
}

function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve((reader.result as string).split(',')[1])
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

function readAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = reject
    reader.readAsText(file)
  })
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

// ─── 空状态欢迎页 ──────────────────────────────────────────────────────────

const PROMPT_EXAMPLES = [
  { emoji: '💡', text: '帮我分析这段代码的逻辑' },
  { emoji: '✍️', text: '帮我写一份项目方案文档' },
  { emoji: '🔍', text: '搜索并总结最新行业动态' },
  { emoji: '🛠️', text: '调试这个报错并给出修复方案' },
]

function WelcomeScreen({ onPrompt }: { onPrompt: (text: string) => void }) {
  return (
    <div className={styles.welcome}>
      <div className={styles.welcomeEmoji}>🤖</div>
      <h2 className={styles.welcomeTitle}>Agent 引擎</h2>
      <p className={styles.welcomeSub}>多智能体协作，让 AI 帮你完成复杂任务</p>
      <div className={styles.promptGrid}>
        {PROMPT_EXAMPLES.map((p) => (
          <button
            key={p.text}
            className={styles.promptCard}
            onClick={() => onPrompt(p.text)}
          >
            <span className={styles.promptEmoji}>{p.emoji}</span>
            <span className={styles.promptText}>{p.text}</span>
          </button>
        ))}
      </div>
    </div>
  )
}

// ─── 附件预览条 ────────────────────────────────────────────────────────────

function AttachmentBar({ items, onRemove }: { items: AttachmentItem[]; onRemove: (i: number) => void }) {
  if (items.length === 0) return null
  return (
    <div className={styles.attachBar}>
      {items.map((item, idx) => {
        const isImage = item.file.type.startsWith('image/')
        return (
          <div key={idx} className={styles.attachThumb}>
            {isImage && item.previewUrl ? (
              <img src={item.previewUrl} alt={item.file.name} className={styles.attachImg} />
            ) : (
              <div className={styles.attachIcon}>📎</div>
            )}
            <div className={styles.attachName}>
              {item.file.name.length > 10
                ? item.file.name.slice(0, 8) + '…'
                : item.file.name}
            </div>
            <div className={styles.attachSize}>{formatBytes(item.file.size)}</div>
            <button className={styles.attachRemove} onClick={() => onRemove(idx)}>
              <CloseOutline />
            </button>
          </div>
        )
      })}
    </div>
  )
}

// ─── ChatPage ──────────────────────────────────────────────────────────────

export default function ChatPage() {
  const {
    activeSessionId,
    messageMap,
    sessions,
    addSession,
    isSessionRunning,
  } = useSessionStore()
  const { agents } = useAgentStore()
  const navigate = useNavigate()
  const { items: snackItems, show: showSnack } = useSnack()

  const {
    send,
    regenerate,
    fetchHistory,
    cancel,
    sendToolResponse,
    deleteMessage: deleteMessageWithBackend,
  } = useChat()

  const messages: Message[] = messageMap[activeSessionId] ?? []
  const session = sessions.find((s) => s.id === activeSessionId)
  const running = isSessionRunning(activeSessionId)

  // 当前 Agent 名称
  const currentAgent = agents.find((a) => a.id === session?.agentId)

  // ── 加载历史消息（切换会话 / 刷新页面后从后端拉取）────────────────────────
  const [historyLoading, setHistoryLoading] = useState(false)

  useEffect(() => {
    if (!activeSessionId) return
    setHistoryLoading(true)
    fetchHistory(activeSessionId)
      .finally(() => setHistoryLoading(false))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSessionId])

  // ── UI 状态 ────────────────────────────────────────────────────────────────
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [agentPickerOpen, setAgentPickerOpen] = useState(false)
  const [toolboxOpen, setToolboxOpen] = useState(false)
  const [input, setInput] = useState('')
  const [attachments, setAttachments] = useState<AttachmentItem[]>([])
  const [showScrollBtn, setShowScrollBtn] = useState(false)

  const listRef  = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  // ── 滚底工具函数 ───────────────────────────────────────────────────────────
  const scrollToBottom = useCallback((smooth = false) => {
    const el = listRef.current
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' })
  }, [])

  // ── 监听滚动位置，决定是否显示"到底"按钮 ─────────────────────────────────
  useEffect(() => {
    const el = listRef.current
    if (!el) return
    const onScroll = () => {
      const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
      setShowScrollBtn(distFromBottom > 120)
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [])

  // ── 自动滚底（仅当用户已在底部附近时才自动跟随）───────────────────────────
  const lastMsgContent = messages[messages.length - 1]?.content
  useEffect(() => {
    const el = listRef.current
    if (!el) return
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    // 距底部 200px 以内才自动跟随，否则不打扰用户翻阅历史
    if (distFromBottom < 200) scrollToBottom()
  }, [messages.length, lastMsgContent, scrollToBottom])

  // ── 页面首次挂载时强制滚底（刷新后恢复历史消息场景）─────────────────────
  useEffect(() => {
    const timer = setTimeout(() => scrollToBottom(true), 100)
    return () => clearTimeout(timer)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── 新消息/会话切换时强制滚底 ─────────────────────────────────────────────
  useEffect(() => {
    scrollToBottom(true)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSessionId])

  // ── iOS visualViewport 键盘弹出适配 ──────────────────────────────────────
  useEffect(() => {
    const onResize = () => {
      if (document.activeElement === inputRef.current) {
        inputRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
      }
    }
    window.visualViewport?.addEventListener('resize', onResize)
    return () => window.visualViewport?.removeEventListener('resize', onResize)
  }, [])

  // ── 工具箱关闭时输入框聚焦 ────────────────────────────────────────────────
  useEffect(() => {
    if (!toolboxOpen) inputRef.current?.focus()
  }, [toolboxOpen])

  // ── 附件管理 ───────────────────────────────────────────────────────────────
  const addFiles = useCallback((files: File[]) => {
    const valid: AttachmentItem[] = []
    for (const file of files) {
      if (file.size > MAX_FILE_SIZE) {
        showSnack(`${file.name} 超过 100MB`, '❌')
        continue
      }
      const encoding: 'utf-8' | 'base64' =
        file.type.startsWith('image/') || isBinary(file.name) ? 'base64' : 'utf-8'
      const previewUrl = file.type.startsWith('image/')
        ? URL.createObjectURL(file)
        : undefined
      valid.push({ file, previewUrl, encoding })
    }
    if (valid.length > 0) {
      setAttachments((prev) => [...prev, ...valid])
      setToolboxOpen(false)
    }
  }, [showSnack])

  const removeAttachment = (idx: number) => {
    setAttachments((prev) => {
      const item = prev[idx]
      if (item.previewUrl) URL.revokeObjectURL(item.previewUrl)
      return prev.filter((_, i) => i !== idx)
    })
  }

  // ── 发送逻辑 ───────────────────────────────────────────────────────────────
  const handleSend = async (quickText?: string) => {
    const text = (quickText ?? input).trim()
    if ((!text && attachments.length === 0) || running) return

    const currentAtts = [...attachments]
    setInput('')
    setAttachments([])
    if (inputRef.current) inputRef.current.style.height = 'auto'

    // 组装 attachmentData & messageContent
    const attachmentData: any[] = []
    const messageContent: any[] = []

    for (const att of currentAtts) {
      try {
        const isImage = att.file.type.startsWith('image/')
        const fileContent = att.encoding === 'base64'
          ? await readAsBase64(att.file)
          : await readAsText(att.file)

        await workspaceApi.uploadFile(activeSessionId, att.file.name, fileContent, att.encoding)
        attachmentData.push({ name: att.file.name, content: fileContent, type: att.file.type, encoding: att.encoding })

        if (isImage) {
          messageContent.push({
            type: 'image_url',
            image_url: {
              // 加 t= 时间戳防止同名文件覆盖后浏览器命中缓存
              url: `/api/v1/workspace/image?sessionId=${encodeURIComponent(activeSessionId)}&path=${encodeURIComponent(att.file.name)}&t=${Date.now()}`,
              alt: att.file.name,
            },
          })
        } else {
          messageContent.push({ type: 'workspace_file', name: att.file.name, fileType: att.file.type })
        }
      } catch {
        showSnack(`上传 ${att.file.name} 失败`, '❌')
      }
    }

    if (text) messageContent.push({ type: 'text', text })
    const finalContent =
      messageContent.length === 1 && messageContent[0].type === 'text'
        ? text
        : messageContent.length > 0 ? messageContent : text

    try {
      await send(finalContent, activeSessionId, attachmentData.length > 0 ? attachmentData : undefined)
    } catch (err: any) {
      showSnack(err?.message ?? '发送失败', '❌')
    }
  }

  const handleRegenerate = async () => {
    if (running) return
    try {
      await regenerate(activeSessionId)
    } catch (err: any) {
      showSnack(err?.message ?? '重新生成失败', '❌')
    }
  }

  const handleDeleteMessage = useCallback(async (messageId: string) => {
    console.log('[ChatPage] handleDeleteMessage called:', messageId)
    try {
      await deleteMessageWithBackend(activeSessionId, messageId)
      showSnack('已删除整轮对话', '✅')
    } catch (err: any) {
      console.error('[ChatPage] delete failed:', err)
      showSnack(err?.message ?? '删除失败', '❌')
    }
  }, [activeSessionId, deleteMessageWithBackend, showSnack])

  const handleToolReply = useCallback(async (
    msgId: string,
    toolCallId: string,
    toolName: string,
    content: string,
  ) => {
    if (running) return
    try {
      await sendToolResponse(msgId, toolCallId, toolName, content, activeSessionId)
    } catch (err: any) {
      showSnack(err?.message ?? '回复失败', '❌')
    }
  }, [activeSessionId, running, sendToolResponse, showSnack])

  // ── 输入框高度自适应 ───────────────────────────────────────────────────────
  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value)
    e.target.style.height = 'auto'
    e.target.style.height = `${Math.min(e.target.scrollHeight, 120)}px`
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const canSend = (input.trim().length > 0 || attachments.length > 0) && !running

  return (
    <div className={styles.page}>

      {/* ── NavBar ─────────────────────────────────────────────────────────── */}
      <div className={styles.navBar}>
        {/* 左：历史会话按钮 */}
        <button className={styles.navBtn} onClick={() => setDrawerOpen(true)} aria-label="历史会话">
          <UnorderedListOutline />
        </button>

        {/* 中：Agent 选择 */}
        <button className={styles.agentSelector} onClick={() => setAgentPickerOpen(true)}>
          <span className={styles.agentName}>
            {currentAgent?.name ?? '默认对话'}
          </span>
          <span className={styles.agentArrow}>▾</span>
        </button>

        {/* 右：新建 + 我的 */}
        <div className={styles.navRight}>
          <button
            className={styles.navBtn}
            onClick={() => { addSession(); }}
            aria-label="新建对话"
          >
            <AddCircleOutline />
          </button>
          <button
            className={styles.navAvatar}
            onClick={() => navigate('/me')}
            aria-label="我的"
          >
            <span>👤</span>
          </button>
        </div>
      </div>

      {/* ── 消息列表 ───────────────────────────────────────────────────────── */}
      <div className={styles.listWrap}>
        <div
          ref={listRef}
          className={`${styles.list} scroll-area`}
          onClick={() => { setToolboxOpen(false); setAgentPickerOpen(false) }}
        >
          {historyLoading ? (
            <div className={styles.historyLoading}>
              <span className={styles.historyLoadingDot} />
            </div>
          ) : messages.filter((m) => m.role !== 'system').length === 0 ? (
            <WelcomeScreen onPrompt={(text) => handleSend(text)} />
          ) : (
            messages
              .filter((m) => m.role !== 'system')
              .map((m, i, arr) => {
                const isLast = i === arr.length - 1
                const isLastAi = m.role === 'assistant' && isLast
                return (
                  <MessageBubble
                    key={m.id}
                    msg={m}
                    isLast={isLast}
                    isStreaming={running && isLast && m.role === 'assistant'}
                    sessionId={activeSessionId}
                    onRegenerate={isLastAi && !running ? handleRegenerate : undefined}
                    onDelete={handleDeleteMessage}
                    onToolReply={handleToolReply}
                  />
                )
              })
          )}
        </div>

        {/* ── 一键到底按钮 ───────────────────────────────────────────────── */}
        {showScrollBtn && (
          <button
            className={styles.scrollBottomBtn}
            onClick={() => scrollToBottom(true)}
            aria-label="滚动到底部"
          >
            ↓
          </button>
        )}
      </div>

      {/* ── 附件预览条 ─────────────────────────────────────────────────────── */}
      <AttachmentBar items={attachments} onRemove={removeAttachment} />

      {/* ── 输入区 ─────────────────────────────────────────────────────────── */}
      <div className={styles.inputArea}>
        <div className={styles.inputRow}>
          {/* [+] 工具箱切换 */}
          <button
            className={`${styles.iconBtn} ${toolboxOpen ? styles.iconBtnActive : ''}`}
            onClick={() => setToolboxOpen((v) => !v)}
            aria-label="工具"
            disabled={running}
          >
            {toolboxOpen ? <CloseOutline /> : <AddOutline />}
          </button>

          {/* 输入框 */}
          <textarea
            ref={inputRef}
            className={styles.input}
            placeholder={running ? 'AI 思考中…' : '给 Agent 发消息'}
            value={input}
            rows={1}
            disabled={running && input.length === 0}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            onFocus={() => setToolboxOpen(false)}
          />

          {/* 发送 / 停止 */}
          <button
            className={`${styles.sendBtn} ${canSend || running ? styles.sendBtnActive : ''}`}
            onClick={running ? () => cancel(activeSessionId) : () => handleSend()}
            aria-label={running ? '停止' : '发送'}
          >
            {running ? (
              <span className={styles.stopIcon}>■</span>
            ) : (
              <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
                <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/>
              </svg>
            )}
          </button>
        </div>
      </div>

      {/* ── 工具箱面板 ─────────────────────────────────────────────────────── */}
      <InputToolbox visible={toolboxOpen} onFileSelected={addFiles} />

      {/* ── 左抽屉：历史会话 ───────────────────────────────────────────────── */}
      <SessionsDrawer visible={drawerOpen} onClose={() => setDrawerOpen(false)} />

      {/* ── Agent 选择 Popup ───────────────────────────────────────────────── */}
      <AgentPicker visible={agentPickerOpen} onClose={() => setAgentPickerOpen(false)} />

      {/* ── 轻量 Snack 通知（替代 antd-mobile Toast） ─────────────────────── */}
      <SnackBar items={snackItems} />
    </div>
  )
}
