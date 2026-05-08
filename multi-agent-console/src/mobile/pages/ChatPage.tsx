import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Toast, ImageViewer } from 'antd-mobile'
import { SendOutline, PictureOutline, FolderOutline, CloseOutline } from 'antd-mobile-icons'
import { useSessionStore } from '@core/store/session'
import { chatStream, cancelChat, workspaceApi } from '@core/api'
import type { Message } from '@core/types'
import { AppNavBar } from '../components/AppNavBar'
import styles from './ChatPage.module.css'

// ─── 常量 ──────────────────────────────────────────────────────────────────
const MAX_FILE_SIZE = 100 * 1024 * 1024 // 100 MB

interface AttachmentItem {
  file: File
  previewUrl?: string   // 图片本地预览 URL
  encoding: 'utf-8' | 'base64'
}

// ─── 工具函数 ──────────────────────────────────────────────────────────────

function isBinary(fileName: string) {
  const BINARY_EXTS = [
    '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.ico',
    '.pdf', '.zip', '.tar', '.gz', '.7z', '.rar',
    '.mp4', '.mov', '.avi', '.mp3', '.wav', '.ogg',
    '.exe', '.bin', '.wasm', '.so', '.dll',
  ]
  const ext = fileName.toLowerCase().slice(fileName.lastIndexOf('.'))
  return BINARY_EXTS.includes(ext)
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

// ─── 气泡 ──────────────────────────────────────────────────────────────────

function Bubble({ msg }: { msg: Message }) {
  const isUser = msg.role === 'user'

  // content 可能是字符串或多模态数组
  const textContent =
    typeof msg.content === 'string'
      ? msg.content
      : msg.content
          .filter((c: any) => c.type === 'text')
          .map((c: any) => c.text)
          .join('')

  const imageItems: Array<{ url: string; alt: string }> = []
  if (Array.isArray(msg.content)) {
    for (const c of msg.content) {
      if (c.type === 'image_url' && c.image_url?.url) {
        imageItems.push({ url: c.image_url.url, alt: c.image_url.alt || '图片' })
      }
    }
  }

  const [lightboxVisible, setLightboxVisible] = useState(false)
  const [lightboxIndex, setLightboxIndex] = useState(0)

  return (
    <div className={`${styles.bubbleWrap} ${isUser ? styles.userWrap : styles.aiWrap}`}>
      <div className={`${styles.bubble} ${isUser ? styles.userBubble : styles.aiBubble}`}>
        {/* 图片附件 */}
        {imageItems.length > 0 && (
          <div className={styles.imageGrid}>
            {imageItems.map((img, i) => (
              <img
                key={i}
                src={img.url}
                alt={img.alt}
                className={styles.thumbImage}
                onClick={() => { setLightboxIndex(i); setLightboxVisible(true) }}
              />
            ))}
            <ImageViewer.Multi
              images={imageItems.map((img) => img.url)}
              visible={lightboxVisible}
              defaultIndex={lightboxIndex}
              onClose={() => setLightboxVisible(false)}
            />
          </div>
        )}

        {/* 文字内容 */}
        {msg.status === 'streaming' && !textContent ? (
          <span className={styles.typing}>···</span>
        ) : textContent ? (
          <span className={styles.bubbleText}>{textContent}</span>
        ) : null}
      </div>
    </div>
  )
}

// ─── 附件预览条 ────────────────────────────────────────────────────────────

function AttachmentBar({
  items,
  onRemove,
}: {
  items: AttachmentItem[]
  onRemove: (idx: number) => void
}) {
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
              <div className={styles.attachIcon}>
                <FolderOutline />
              </div>
            )}
            <div className={styles.attachName} title={item.file.name}>
              {item.file.name.length > 12
                ? item.file.name.slice(0, 10) + '…' + item.file.name.slice(-4)
                : item.file.name}
            </div>
            <div className={styles.attachSize}>{formatBytes(item.file.size)}</div>
            <button
              className={styles.attachRemove}
              onClick={() => onRemove(idx)}
              aria-label="移除"
            >
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
    addMessage,
    updateMessage,
    sessions,
    isSessionRunning,
    markSessionRunning,
    markSessionDone,
  } = useSessionStore()

  const messages: Message[] = messageMap[activeSessionId] ?? []
  const session = sessions.find((s) => s.id === activeSessionId)
  const running = isSessionRunning(activeSessionId)

  const [input, setInput] = useState('')
  const [attachments, setAttachments] = useState<AttachmentItem[]>([])
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const imageInputRef = useRef<HTMLInputElement>(null)

  // 自动滚到最新消息
  const lastMessageContent = messages[messages.length - 1]?.content
  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages.length, lastMessageContent])

  // visualViewport resize → 输入框保持可见（iOS 键盘弹起时）
  useEffect(() => {
    const onResize = () => {
      if (document.activeElement === inputRef.current) {
        inputRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
      }
    }
    window.visualViewport?.addEventListener('resize', onResize)
    return () => window.visualViewport?.removeEventListener('resize', onResize)
  }, [])

  // 释放预览 URL
  useEffect(() => {
    return () => {
      attachments.forEach((a) => { if (a.previewUrl) URL.revokeObjectURL(a.previewUrl) })
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  function genId() {
    return Math.random().toString(36).slice(2, 10) + Date.now().toString(36)
  }

  // ── 添加附件 ──────────────────────────────────────────────────────────────

  const addFiles = useCallback((files: File[]) => {
    const valid: AttachmentItem[] = []
    for (const file of files) {
      if (file.size > MAX_FILE_SIZE) {
        Toast.show({ icon: 'fail', content: `${file.name} 超过 100MB 限制` })
        continue
      }
      const isImage = file.type.startsWith('image/')
      const encoding: 'utf-8' | 'base64' = isImage || isBinary(file.name) ? 'base64' : 'utf-8'
      const previewUrl = isImage ? URL.createObjectURL(file) : undefined
      valid.push({ file, previewUrl, encoding })
    }
    if (valid.length > 0) setAttachments((prev) => [...prev, ...valid])
  }, [])

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) addFiles(Array.from(e.target.files))
    e.target.value = ''
  }

  const removeAttachment = (idx: number) => {
    setAttachments((prev) => {
      const item = prev[idx]
      if (item.previewUrl) URL.revokeObjectURL(item.previewUrl)
      return prev.filter((_, i) => i !== idx)
    })
  }

  // ── 发送 ──────────────────────────────────────────────────────────────────

  const handleSend = async () => {
    const text = input.trim()
    if ((!text && attachments.length === 0) || running) return

    const currentAttachments = [...attachments]
    setInput('')
    setAttachments([])
    // 重置 textarea 高度
    if (inputRef.current) inputRef.current.style.height = 'auto'

    // 上传附件 & 组装 content
    const attachmentData: Array<{ name: string; content: string; type: string; encoding?: 'utf-8' | 'base64' }> = []
    const messageContent: any[] = []

    for (const att of currentAttachments) {
      try {
        const isImage = att.file.type.startsWith('image/')
        const fileContent =
          att.encoding === 'base64' ? await readAsBase64(att.file) : await readAsText(att.file)

        // 上传到工作区（AI 可通过 read_file 工具访问）
        await workspaceApi.uploadFile(activeSessionId, att.file.name, fileContent, att.encoding)

        attachmentData.push({
          name: att.file.name,
          content: fileContent,
          type: att.file.type,
          encoding: att.encoding,
        })

        if (isImage) {
          messageContent.push({
            type: 'image_url',
            image_url: {
              url: `/api/v1/workspace/image?sessionId=${encodeURIComponent(activeSessionId)}&path=${encodeURIComponent(att.file.name)}`,
              alt: att.file.name,
            },
          })
        } else {
          messageContent.push({ type: 'workspace_file', name: att.file.name, fileType: att.file.type })
        }
      } catch (err: any) {
        Toast.show({ icon: 'fail', content: `上传 ${att.file.name} 失败` })
      }
    }

    if (text) messageContent.push({ type: 'text', text })
    const finalContent = messageContent.length === 1 && messageContent[0].type === 'text'
      ? text
      : messageContent.length > 0 ? messageContent : text

    // 用户气泡
    const userMsgId = genId()
    addMessage(activeSessionId, {
      id: userMsgId,
      role: 'user',
      content: finalContent,
      status: 'done',
      createdAt: Date.now(),
    })

    // AI 占位
    const aiMsgId = genId()
    addMessage(activeSessionId, {
      id: aiMsgId,
      role: 'assistant',
      content: '',
      status: 'streaming',
      createdAt: Date.now(),
    })

    markSessionRunning(activeSessionId)
    let accumulated = ''
    const sid = activeSessionId

    chatStream({
      message: finalContent,
      sessionId: sid,
      agentId: session?.agentId,
      attachments: attachmentData.length > 0 ? attachmentData : undefined,
      onEvent: (evt) => {
        if (evt.type === 'text_delta' && evt.content) {
          accumulated += evt.content
          updateMessage(sid, aiMsgId, { content: accumulated, status: 'streaming' })
        }
      },
      onDone: () => {
        updateMessage(sid, aiMsgId, { status: 'done', content: accumulated })
        markSessionDone(sid)
      },
      onError: (err) => {
        updateMessage(sid, aiMsgId, {
          status: 'error',
          content: accumulated || '发生错误，请重试',
        })
        Toast.show({ icon: 'fail', content: err?.message ?? '发送失败' })
        markSessionDone(sid)
      },
    })
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
      <AppNavBar title={session?.title || '对话'} back={null} />

      {/* 消息列表 */}
      <div ref={listRef} className={`${styles.list} scroll-area`}>
        {messages.length === 0 && (
          <div className={styles.empty}>发送消息或上传文件开始对话</div>
        )}
        {messages
          .filter((m) => m.role !== 'system')
          .map((m) => (
            <Bubble key={m.id} msg={m} />
          ))}
      </div>

      {/* 附件预览 */}
      <AttachmentBar items={attachments} onRemove={removeAttachment} />

      {/* 输入栏 */}
      <div className={styles.inputBar}>
        {/* 图片选择按钮（相册 + 拍照） */}
        <button
          className={styles.iconBtn}
          onClick={() => imageInputRef.current?.click()}
          aria-label="图片/拍照"
          disabled={running}
        >
          <PictureOutline />
        </button>

        {/* 文件选择按钮 */}
        <button
          className={styles.iconBtn}
          onClick={() => fileInputRef.current?.click()}
          aria-label="附件"
          disabled={running}
        >
          <FolderOutline />
        </button>

        {/* 文字输入框 */}
        <textarea
          ref={inputRef}
          className={styles.input}
          placeholder="输入消息…"
          value={input}
          rows={1}
          onChange={(e) => {
            setInput(e.target.value)
            e.target.style.height = 'auto'
            e.target.style.height = `${Math.min(e.target.scrollHeight, 120)}px`
          }}
          onKeyDown={handleKeyDown}
        />

        {/* 发送 / 停止 */}
        <button
          className={`${styles.sendBtn} ${!canSend && !running ? styles.sendBtnDisabled : ''}`}
          onClick={running ? () => cancelChat(activeSessionId) : handleSend}
          aria-label={running ? '停止' : '发送'}
        >
          {running ? (
            <span className={styles.stopIcon}>■</span>
          ) : (
            <SendOutline />
          )}
        </button>
      </div>

      {/* 隐藏 file input：图片（含相机） */}
      <input
        ref={imageInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        multiple
        style={{ display: 'none' }}
        onChange={handleFileChange}
      />

      {/* 隐藏 file input：所有文件 */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        style={{ display: 'none' }}
        onChange={handleFileChange}
      />
    </div>
  )
}
