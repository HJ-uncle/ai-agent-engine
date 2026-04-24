import React, { useEffect, useRef, useCallback, useState, useLayoutEffect } from 'react'
import {
  Button, Tooltip, Popconfirm, Input, Select,
} from 'antd'
import {
  SendOutlined, StopOutlined, ReloadOutlined,
  DeleteOutlined, CopyOutlined, CheckOutlined,
  EditOutlined, RobotOutlined, UserOutlined,
  ClockCircleOutlined, ThunderboltOutlined,
  ClearOutlined, LoadingOutlined, CheckCircleFilled,
  WarningFilled, BulbOutlined, ToolOutlined,
  CheckCircleOutlined, CloseCircleOutlined,
  UpOutlined, DownOutlined,
} from '@ant-design/icons'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import rehypeHighlight from 'rehype-highlight'
import 'katex/dist/katex.min.css'
import 'highlight.js/styles/github-dark.css'
import { useSessionStore } from '../store/session'
import { useAgentStore } from '../store/agents'
import { useChat } from '../hooks/useChat'
import type { Message, TokenUsage, ThinkingStep } from '../types'
import styles from './ChatArea.module.css'
import dayjs from 'dayjs'

// ── Copy button ───────────────────────────────────────────────────────────────
function CopyBtn({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <Tooltip title={copied ? '已复制' : '复制'}>
      <Button
        type="text" size="small"
        icon={copied ? <CheckOutlined style={{ color: '#3fb950' }} /> : <CopyOutlined />}
        className={styles.iconBtn}
        onClick={() => {
          navigator.clipboard.writeText(text)
          setCopied(true)
          setTimeout(() => setCopied(false), 2000)
        }}
      />
    </Tooltip>
  )
}

// ── Token meta ─────────────────────────────────────────────────────────────────
const TOKEN_META = [
  { key: 'systemPromptTokens' as keyof TokenUsage, color: '#818cf8', label: '系统提示词' },
  { key: 'messagesTokens' as keyof TokenUsage, color: '#38bdf8', label: '历史消息' },
  { key: 'skillTokens' as keyof TokenUsage, color: '#c084fc', label: '技能/工具' },
  { key: 'systemToolsTokens' as keyof TokenUsage, color: '#fbbf24', label: '系统工具' },
  { key: 'completionTokens' as keyof TokenUsage, color: '#fb7185', label: '生成内容' },
]

function fmtToken(n: number) {
  return n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n ?? 0)
}

// ── Token badge ────────────────────────────────────────────────────────────────
function TokenDetailsContent({ usage, durationMs, title = 'Token 详情' }: { usage: TokenUsage; durationMs?: number; title?: string }) {
  return (
    <div style={{ width: 200, fontSize: 12 }}>
      <div style={{ fontWeight: 700, marginBottom: 8, color: '#e6edf3' }}>
        ⚡ {title} {durationMs != null && (
          <span style={{ fontSize: 11, color: '#3fb950', marginLeft: 8 }}>
            {(durationMs / 1000).toFixed(1)}s
          </span>
        )}
      </div>
      {/* Bar */}
      <div style={{ height: 5, display: 'flex', gap: 1, borderRadius: 3, overflow: 'hidden', background: '#0d1117', marginBottom: 10 }}>
        {TOKEN_META.map((m) => {
          const v = (usage[m.key] as number) ?? 0
          const total = usage.totalTokens || 1
          return v > 0 ? (
            <div key={m.key} style={{ width: `${(v / total) * 100}%`, background: m.color }} />
          ) : null
        })}
      </div>
      {TOKEN_META.map((m) => {
        const v = (usage[m.key] as number) ?? 0
        return (
          <div key={m.key} style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4, fontSize: 11 }}>
            <span style={{ color: '#8b949e', display: 'flex', alignItems: 'center', gap: 5 }}>
              <span style={{ width: 8, height: 8, borderRadius: 2, background: m.color, display: 'inline-block' }} />
              {m.label}
            </span>
            <span style={{ color: '#e6edf3', fontWeight: 600 }}>{fmtToken(v)}</span>
          </div>
        )
      })}
      <div style={{ display: 'flex', justifyContent: 'space-between', paddingTop: 8, borderTop: '1px solid #21262d', fontWeight: 700, fontSize: 12 }}>
        <span style={{ color: '#8b949e' }}>总计</span>
        <span style={{ color: '#3fb950' }}>{fmtToken(usage.totalTokens)}</span>
      </div>
    </div>
  )
}

function TokenBadge({ usage, durationMs }: { usage: TokenUsage; durationMs?: number }) {
  return (
    <Tooltip
      style={{ width: 260 }}
      title={<TokenDetailsContent usage={usage} durationMs={durationMs} />}
      overlayInnerStyle={{ background: '#161b22', border: '1px solid #30363d', borderRadius: 8, padding: '10px 14px' }}
      arrow={false}
    >
      <span className={styles.tokenBadge}>
        <ThunderboltOutlined style={{ fontSize: 10 }} />
        {fmtToken(usage.totalTokens)}
      </span>
    </Tooltip>
  )
}

// ── Thinking steps ─────────────────────────────────────────────────────────────
function ThinkingPanel({ steps, isActive }: { steps: ThinkingStep[]; isActive?: boolean }) {
  const [expanded, setExpanded] = useState(isActive ?? false)

  // 当会话进入活动状态（正在思考/处理）时，默认展开；完成后自动收起
  useEffect(() => {
    setExpanded(isActive ?? false)
  }, [isActive])

  const toolCount = steps.filter((s) => s.type === 'tool_start').length
  const toolNames = Array.from(new Set(steps.filter((s) => s.type === 'tool_start').map((s) => s.toolName)))
  const hasFailure = steps.some((s) => s.type === 'tool_end' && s.success === false)

  if (steps.length === 0 && !isActive) return null

  return (
    <div className={styles.thinkingPanel}>
      <div
        className={styles.thinkingHeader}
        onClick={() => setExpanded(!expanded)}
      >
        <div className={styles.thinkingHeaderLeft}>
          {isActive ? (
            <LoadingOutlined className={styles.thinkingActiveIcon} />
          ) : hasFailure ? (
            <WarningFilled style={{ color: '#f78166' }} />
          ) : (
            <CheckCircleFilled style={{ color: '#3fb950' }} />
          )}
          <span className={styles.thinkingLabel}>
            {isActive
              ? '正在思考...'
              : toolCount > 0
              ? `调用了 ${toolCount} 个工具：${toolNames.join('、')}`
              : '推理完成'}
          </span>
        </div>
        <div className={styles.thinkingHeaderRight}>
          <span className={styles.thinkingToggleLabel}>{expanded ? '收起' : '展开'}</span>
          {expanded ? <UpOutlined /> : <DownOutlined />}
        </div>
      </div>
      {expanded && (
        <div className={styles.thinkingBody}>
          {steps.map((step, i) => {
            if (step.type === 'thinking')
              return (
                <div key={i} className={styles.thinkStep}>
                  <span className={styles.thinkLabel}>
                    <BulbOutlined style={{ marginRight: 6 }} />
                    思考
                  </span>
                  <div className={styles.thinkText}>{step.text}</div>
                </div>
              )
            if (step.type === 'tool_start')
              return (
                <div key={i} className={styles.toolStepWrapper}>
                  <div className={styles.toolStep}>
                    {step.success === true && <CheckCircleOutlined className={styles.resultSuccessIcon} style={{ marginTop: 0 }} />}
                    {step.success === false && <CloseCircleOutlined className={styles.resultErrorIcon} style={{ marginTop: 0}} />}
                    {step.success === undefined && <ToolOutlined className={styles.toolIcon} />}
                    
                    <span className={styles.toolName}>{step.toolName}</span>
                    {step.toolArgs && (
                      <span className={styles.toolArgs}>
                        {JSON.stringify(step.toolArgs).slice(0, 120)}
                      </span>
                    )}
                  </div>
                  {step.outputPreview && (
                    <div className={styles.toolResultCompact}>
                      <span className={styles.resultText}>{step.outputPreview}</span>
                    </div>
                  )}
                </div>
              )
            if (step.type === 'tool_end')
              return (
                <div key={i} className={styles.toolResult}>
                  {step.success ? (
                    <CheckCircleOutlined className={styles.resultSuccessIcon} />
                  ) : (
                    <CloseCircleOutlined className={styles.resultErrorIcon} />
                  )}
                  <span className={styles.resultText} style={{ color: step.success ? '#8b949e' : '#f78166' }}>
                    {step.outputPreview}
                  </span>
                </div>
              )
            return null
          })}
          {isActive && (
            <div className={styles.thinkingLoading}>
              <LoadingOutlined style={{ marginRight: 6 }} />
              Agent 正在处理...
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── Welcome screen ─────────────────────────────────────────────────────────────
const WELCOME_PROMPTS = [
  { key: 'search', emoji: '🔍', label: '网络搜索', desc: '搜索最新资讯和信息', msg: '帮我搜索一下最新的 AI 行业新闻' },
  { key: 'write', emoji: '✍️', label: '写作助手', desc: '帮你撰写各类文档', msg: '帮我写一篇关于人工智能的产品介绍文案' },
  { key: 'idea', emoji: '💡', label: '头脑风暴', desc: '激发创意与想法', msg: '帮我想 5 个有创意的 SaaS 产品方向' },
  { key: 'analyze', emoji: '📊', label: '数据分析', desc: '分析处理各类数据', msg: '帮我分析一份销售数据，并给出优化建议' },
]

function WelcomeScreen({ onPrompt, agentName }: { onPrompt: (msg: string) => void; agentName?: string }) {
  return (
    <div className={styles.welcome}>
      <div className={styles.welcomeIcon}>
        {agentName ? <RobotOutlined /> : '🤖'}
      </div>
      <h2 className={styles.welcomeTitle}>
        {agentName ? `你好，我是 ${agentName}` : '你好，有什么可以帮你？'}
      </h2>
      <p className={styles.welcomeSub}>基于 Agent Engine 驱动，支持工具调用、知识库检索</p>
      <div className={styles.promptGrid}>
        {WELCOME_PROMPTS.map((p) => (
          <div key={p.key} className={styles.promptCard} onClick={() => onPrompt(p.msg)}>
            <span className={styles.promptEmoji}>{p.emoji}</span>
            <span className={styles.promptLabel}>{p.label}</span>
            <span className={styles.promptDesc}>{p.desc}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Message item ───────────────────────────────────────────────────────────────
function MessageItem({
  msg,
  onRegenerate,
  onEdit,
}: {
  msg: Message
  onRegenerate?: () => void
  onEdit?: (newContent: string) => void
}) {
  const { deleteMessage } = useSessionStore()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const isUser = msg.role === 'user'
  const isStreaming = msg.status === 'streaming'

  const timeStr = dayjs(msg.createdAt).format('YYYY-MM-DD HH:mm:ss')

  const startEdit = () => { setDraft(msg.content); setEditing(true) }
  const cancelEdit = () => setEditing(false)
  const confirmEdit = () => {
    if (draft.trim() && draft !== msg.content) onEdit?.(draft.trim())
    setEditing(false)
  }

  return (
    <div className={`${styles.msgRow} ${isUser ? styles.userRow : styles.aiRow}`}>
      {/* Avatar */}
      <div className={`${styles.avatar} ${isUser ? styles.userAvatar : styles.aiAvatar}`}>
        {isUser ? <UserOutlined /> : <RobotOutlined />}
      </div>

      {/* Bubble */}
      <div className={styles.bubble}>
        {/* Thinking panel (AI only) */}
        {!isUser && (msg.thinkingSteps?.length ?? 0) > 0 && (
          <ThinkingPanel steps={msg.thinkingSteps!} isActive={isStreaming} />
        )}
        {!isUser && isStreaming && (msg.thinkingSteps?.length ?? 0) === 0 && (
          <ThinkingPanel steps={[]} isActive />
        )}

        {/* Content */}
        {editing ? (
          <div className={styles.editArea}>
            <Input.TextArea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              autoSize={{ minRows: 2, maxRows: 10 }}
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); confirmEdit() }
                if (e.key === 'Escape') cancelEdit()
              }}
            />
            <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', marginTop: 6 }}>
              <Button size="small" onClick={cancelEdit}>取消</Button>
              <Button type="primary" size="small" onClick={confirmEdit}>保存并重发</Button>
            </div>
          </div>
        ) : (msg.content || isUser) ? (
          <div className={`${styles.content} ${isUser ? styles.userContent : styles.aiContent}`}>
            {isUser ? (
              <span style={{ whiteSpace: 'pre-wrap' }}>{msg.content}</span>
            ) : (
              <ReactMarkdown
                remarkPlugins={[remarkGfm, remarkMath]}
                rehypePlugins={[rehypeKatex, rehypeHighlight]}
                components={{
                  code({ node, className, children, ...props }: any) {
                    const isBlock = className?.includes('language-')
                    return isBlock ? (
                      <div className={styles.codeBlock}>
                        <div className={styles.codeHeader}>
                          <span className={styles.codeLang}>
                            {className?.replace('language-', '') ?? 'code'}
                          </span>
                          <CopyBtn text={String(children)} />
                        </div>
                        <code className={className} {...props}>{children}</code>
                      </div>
                    ) : (
                      <code className={styles.inlineCode} {...props}>{children}</code>
                    )
                  },
                }}
              >
                {msg.content || (isStreaming ? '▌' : '')}
              </ReactMarkdown>
            )}
          </div>
        ) : null}

        {/* Footer */}
        {!editing && (
          <div className={`${styles.footer} ${isUser ? styles.userFooter : ''}`}>
            <span className={styles.time}>{timeStr}</span>

            {msg.durationMs != null && (
              <span className={styles.duration}>
                <ClockCircleOutlined style={{ fontSize: 10 }} />
                {(msg.durationMs / 1000).toFixed(1)}s
              </span>
            )}

            {!isUser && msg.usage && (
              <TokenBadge usage={msg.usage} durationMs={msg.durationMs} />
            )}

            <div className={styles.actions}>
              <CopyBtn text={msg.content} />
              {!isUser && onRegenerate && (
                <Tooltip title="重新生成">
                  <Button type="text" size="small" icon={<ReloadOutlined />} className={styles.iconBtn} onClick={onRegenerate} />
                </Tooltip>
              )}
              {isUser && onEdit && (
                <Tooltip title="编辑并重发">
                  <Button type="text" size="small" icon={<EditOutlined />} className={styles.iconBtn} onClick={startEdit} />
                </Tooltip>
              )}
              <Popconfirm title="删除这条消息？" onConfirm={() => deleteMessage(msg.id)} okText="删除" cancelText="取消" okButtonProps={{ danger: true }}>
                <Tooltip title="删除">
                  <Button type="text" size="small" icon={<DeleteOutlined />} className={`${styles.iconBtn} ${styles.dangerBtn}`} />
                </Tooltip>
              </Popconfirm>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Main ChatArea ──────────────────────────────────────────────────────────────
export default function ChatArea() {
  const {
    activeSessionId, sessions, messageMap, usageMap,
    clearMessages,
    updateSessionAgent,
  } = useSessionStore()
  const { agents } = useAgentStore()
  const { send, regenerate, editAndResend, fetchHistory, cancel } = useChat()

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const messages = React.useMemo(() => messageMap[activeSessionId] ?? [], [messageMap, activeSessionId])
  const sessionUsage = usageMap[activeSessionId]
  const session = sessions.find((s) => s.id === activeSessionId)
  const currentAgent = session?.agentId ? agents.find((a) => a.id === session.agentId) : undefined

  const [inputValue, setInputValue] = useState('')
  const [isStreaming, setIsStreaming] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const atBottomRef = useRef(true)

  // Fetch history on session change
  useEffect(() => {
    if (activeSessionId) {
      fetchHistory(activeSessionId)
    }
  }, [activeSessionId, fetchHistory])

  // Scroll logic
  const scrollToBottom = useCallback((smooth = false) => {
    if (smooth) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
    } else {
      messagesEndRef.current?.scrollIntoView({ behavior: 'auto', block: 'end' })
    }
  }, [])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = el
      // 增加容错范围
      atBottomRef.current = scrollHeight - scrollTop - clientHeight < 100
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [])

  // 使用 useLayoutEffect 确保在 DOM 更新后、重绘前同步滚动位置
  // 流式输出时使用 auto 滚动，因为高频更新下 smooth 会导致动画冲突和“跳动”
  useLayoutEffect(() => {
    if (isStreaming && atBottomRef.current) {
      scrollToBottom(false)
    }
  }, [messages, isStreaming, scrollToBottom])

  // 切换会话时可以使用平滑滚动
  useEffect(() => {
    atBottomRef.current = true
    scrollToBottom(true)
  }, [activeSessionId, scrollToBottom])

  const sendMessage = useCallback(async (content: string) => {
    if (!content.trim() || isStreaming) return
    setInputValue('')
    setIsStreaming(true)
    atBottomRef.current = true
    scrollToBottom()
    try {
      await send(content, activeSessionId)
    } finally {
      setIsStreaming(false)
      setTimeout(() => scrollToBottom(true), 100)
    }
  }, [activeSessionId, isStreaming, send, scrollToBottom])

  const handleRegenerate = useCallback(() => {
    if (isStreaming) return
    setIsStreaming(true)
    atBottomRef.current = true
    regenerate(activeSessionId).finally(() => {
      setIsStreaming(false)
      setTimeout(() => scrollToBottom(true), 100)
    })
  }, [activeSessionId, isStreaming, regenerate, scrollToBottom])

  const handleEditAndResend = useCallback((msgId: string, newContent: string) => {
    if (isStreaming) return
    setIsStreaming(true)
    atBottomRef.current = true
    editAndResend(msgId, newContent, activeSessionId).finally(() => {
      setIsStreaming(false)
      setTimeout(() => scrollToBottom(true), 100)
    })
  }, [activeSessionId, isStreaming, editAndResend, scrollToBottom])

  return (
    <div className={styles.container}>
      {/* Chat Header */}
      <div className={styles.header}>
        <div className={styles.headerLeft}>
          {currentAgent ? (
            <>
              <RobotOutlined className={styles.agentIcon} />
              <span className={styles.headerTitle}>{currentAgent.name}</span>
              {currentAgent.description && (
                <span className={styles.headerDesc}>{currentAgent.description}</span>
              )}
            </>
          ) : (
            <span className={styles.headerTitle}>{session?.title ?? '新对话'}</span>
          )}
        </div>
        <div className={styles.headerRight}>
          {/* Agent selector */}
          <Select
            size="small"
            placeholder="选择 Agent"
            allowClear
            className={styles.agentSelect}
            value={session?.agentId || undefined}
            onChange={(val) => updateSessionAgent(activeSessionId, val || undefined)}
            options={[
              ...agents.map((a) => ({
                value: a.id,
                label: (
                  <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <RobotOutlined style={{ fontSize: 11 }} />
                    {a.name}
                  </span>
                ),
              })),
            ]}
            dropdownStyle={{ minWidth: 180 }}
          />

          {/* Token summary */}
          {sessionUsage && (
            <Tooltip
              title={<TokenDetailsContent usage={sessionUsage} title="会话累计 Token" />}
              overlayInnerStyle={{ background: '#161b22', border: '1px solid #30363d', borderRadius: 8, padding: '10px 14px' }}
              arrow={false}
            >
              <span className={styles.sessionToken}>
                <ThunderboltOutlined style={{ fontSize: 11 }} />
                {fmtToken(sessionUsage.totalTokens)}
              </span>
            </Tooltip>
          )}

          <Tooltip title="清空对话">
            <Popconfirm
              title="清空当前对话？"
              onConfirm={() => clearMessages(activeSessionId)}
              okText="清空"
              cancelText="取消"
              okButtonProps={{ danger: true }}
            >
              <Button type="text" size="small" icon={<ClearOutlined />} className={styles.headerBtn} />
            </Popconfirm>
          </Tooltip>
        </div>
      </div>

      {/* Messages */}
      <div className={styles.messages} ref={scrollRef}>
        {messages.length === 0 ? (
          <WelcomeScreen onPrompt={sendMessage} agentName={currentAgent?.name} />
        ) : (
          <>
            {messages.map((msg, idx) => (
              <MessageItem
                key={msg.id}
                msg={msg}
                onRegenerate={idx === messages.length - 1 ? handleRegenerate : undefined}
                onEdit={msg.role === 'user' ? (newContent) => handleEditAndResend(msg.id, newContent) : undefined}
              />
            ))}
            <div ref={messagesEndRef} style={{ height: 1, clear: 'both' }} />
          </>
        )}
      </div>

      {/* Input area */}
      <div className={styles.inputArea}>
        <div className={styles.inputWrapper}>
          <Input.TextArea
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            placeholder={isStreaming ? '正在生成回复...' : '发送消息（Enter 发送，Shift+Enter 换行）'}
            autoSize={{ minRows: 1, maxRows: 8 }}
            disabled={isStreaming}
            className={styles.input}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                sendMessage(inputValue)
              }
            }}
          />
          <div className={styles.inputActions}>
            {isStreaming ? (
              <Tooltip title="停止生成">
                <Button
                  type="primary"
                  danger
                  icon={<StopOutlined />}
                  className={styles.sendBtn}
                  onClick={cancel}
                />
              </Tooltip>
            ) : (
              <Tooltip title="发送 (Enter)">
                <Button
                  type="primary"
                  icon={<SendOutlined />}
                  className={styles.sendBtn}
                  disabled={!inputValue.trim()}
                  onClick={() => sendMessage(inputValue)}
                />
              </Tooltip>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
