import React, { useEffect, useRef, useState, useCallback } from 'react'
import { Bubble, Sender, Conversations, Welcome, Prompts } from '@ant-design/x'
import {
  PlusOutlined, RobotOutlined, UserOutlined, CopyOutlined, CheckOutlined,
  DeleteOutlined, MinusOutlined, BorderOutlined, CloseOutlined,
  ThunderboltOutlined, SearchOutlined, FileTextOutlined, BulbOutlined,
  BarChartOutlined, ReloadOutlined, QuestionCircleOutlined, EditOutlined,
  ClockCircleOutlined,
} from '@ant-design/icons'
import { Button, Tooltip, theme, Popover, Input, Popconfirm } from 'antd'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import rehypeHighlight from 'rehype-highlight'
import 'katex/dist/katex.min.css'
import { useSessionStore } from './store/session'
import type { ThinkingStep } from './store/session'
import type { TokenUsage } from './types'
import { useXAgentChat } from './hooks/useXAgentChat'
import XCardRenderer from './components/XCardRenderer'

const { useToken } = theme
const BASE_URL = import.meta.env.VITE_API_URL ?? ''

const WELCOME_PROMPTS = [
  { key: 'search',  icon: <SearchOutlined />,  label: '网络搜索',  description: '搜索最新资讯和信息' },
  { key: 'write',   icon: <FileTextOutlined />, label: '写作助手',  description: '帮你撰写各类文档' },
  { key: 'idea',    icon: <BulbOutlined />,     label: '头脑风暴',  description: '激发创意与想法' },
  { key: 'analyze', icon: <BarChartOutlined />, label: '数据分析',  description: '分析处理各类数据' },
]
const PROMPT_MESSAGES: Record<string, string> = {
  search:  '帮我搜索一下最新的 AI 行业新闻',
  write:   '帮我写一篇关于人工智能的产品介绍文案',
  idea:    '帮我想 5 个有创意的 SaaS 产品方向',
  analyze: '帮我分析一份销售数据，并给出优化建议',
}


// ── 复制按钮 ─────────────────────────────────────────────────────────────────
function CopyBtn({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <Tooltip title={copied ? '已复制' : '复制'}>
      <Button type="text" size="small"
        icon={copied ? <CheckOutlined style={{ color: '#52c41a' }} /> : <CopyOutlined />}
        style={{ color: '#6e7681', padding: '0 4px', height: 22, fontSize: 12 }}
        onClick={() => { navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 2000) }}
      />
    </Tooltip>
  )
}

// ── Token 指标定义（含详细说明）────────────────────────────────────────────
const TOKEN_META = [
  {
    key:   'systemPromptTokens' as keyof TokenUsage,
    color: '#818cf8',
    label: 'System Prompt',
    shortLabel: 'Sys',
    desc: ['系统提示词消耗的 Token 数量。', '这是每次对话预先注入给 AI 的角色设定、行为规范和背景信息。', '⚠️ 每次请求都会完整发送，是固定基础开销。', '📌 计入：输入 Token（Prompt Tokens）'],
  },
  {
    key:   'messagesTokens' as keyof TokenUsage,
    color: '#38bdf8',
    label: 'Messages',
    shortLabel: 'Msg',
    desc: ['对话历史消息消耗的 Token 数量。', '包含本次请求中所有历史对话轮次（用户消息 + AI 回复）。', '随对话轮次增多持续增长，超出上下文窗口时旧消息会被截断。', '📌 计入：输入 Token（Prompt Tokens）'],
  },
  {
    key:   'skillTokens' as keyof TokenUsage,
    color: '#c084fc',
    label: 'Skills',
    shortLabel: 'Skill',
    desc: ['AI 技能（Skills / Codewiki）占用的 Token 数量。', '包括从知识库检索到的相关文档片段，以及注入的专业技能上下文。', '💡 技能内容越丰富此项越大，但会显著提升回答质量。', '📌 计入：输入 Token（Prompt Tokens）'],
  },
  {
    key:   'systemToolsTokens' as keyof TokenUsage,
    color: '#fbbf24',
    label: 'System Tools',
    shortLabel: 'Tools',
    desc: ['工具定义（Tools Schema）占用的 Token 数量。', '每次请求都需要将所有可用工具的 JSON Schema 定义发送给模型。', '🔧 工具越多、定义越详细此项越大。通常是最大的固定开销项。', '📌 计入：输入 Token（Prompt Tokens）'],
  },
  {
    key:   'completionTokens' as keyof TokenUsage,
    color: '#fb7185',
    label: 'Completion',
    shortLabel: 'Out',
    desc: ['AI 本次生成的输出 Token 数量。', '即 AI 回复的正文内容，以及调用工具时输出的 JSON 参数。', '💬 回答越长、调用工具越多此项越大。', '📌 计入：输出 Token（Completion Tokens），通常比输入 Token 贵 2-3 倍'],
  },
]

// ── Token 行 Tooltip ──────────────────────────────────────────────────────────
function TokenRowTip({ meta, children }: { meta: typeof TOKEN_META[0]; children: React.ReactNode }) {
  return (
    <Tooltip
      overlayStyle={{ maxWidth: 300 }}
      title={
        <div style={{ fontSize: 12 }}>
          <div style={{ fontWeight: 700, color: meta.color, marginBottom: 6 }}>{meta.label}</div>
          {meta.desc.map((line, i) => <p key={i} style={{ margin: '0 0 4px', color: '#c9d1d9', lineHeight: 1.55 }}>{line}</p>)}
        </div>
      }
      placement="right"
    >
      <span style={{ cursor: 'help' }}>{children}</span>
    </Tooltip>
  )
}

// ── Token 详情 Popover（消息级别）────────────────────────────────────────────
function TokenDetail({ usage, durationMs }: { usage: TokenUsage; durationMs?: number }) {
  const total = usage.totalTokens || 1
  const fmt   = (n: number) => n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n)
  const pct   = (n: number) => ((n / total) * 100).toFixed(1) + '%'

  const content = (
    <div style={{ width: 310 }}>
      {/* 标题行 */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <span style={{ fontWeight: 700, color: '#e6edf3', fontSize: 13 }}>⚡ 本条消息 Token 详情</span>
        {durationMs != null && (
          <span style={{ fontSize: 11, color: '#3fb950', background: 'rgba(63,185,80,0.1)', padding: '1px 7px', borderRadius: 10 }}>
            <ClockCircleOutlined style={{ marginRight: 3 }} />{(durationMs / 1000).toFixed(1)}s
          </span>
        )}
      </div>
      {/* 彩色堆叠进度条 */}
      <div style={{ height: 6, borderRadius: 3, overflow: 'hidden', background: '#0d1117', display: 'flex', marginBottom: 14, gap: 1 }}>
        {TOKEN_META.map((m) => {
          const v = (usage[m.key] as number) ?? 0
          return v > 0 ? (
            <Tooltip key={m.key} title={`${m.label}: ${fmt(v)}`}>
              <div style={{ width: `${(v / total) * 100}%`, background: m.color, borderRadius: 2, cursor: 'default' }} />
            </Tooltip>
          ) : null
        })}
      </div>
      {/* 数据行 */}
      {TOKEN_META.map((m) => {
        const v = (usage[m.key] as number) ?? 0
        return (
          <div key={m.key} style={{ display: 'flex', alignItems: 'center', marginBottom: 8, gap: 0 }}>
            <span style={{ width: 9, height: 9, borderRadius: 2, background: m.color, flexShrink: 0, marginRight: 8 }} />
            <TokenRowTip meta={m}>
              <span style={{ flex: 1, color: '#8b949e', fontSize: 12, display: 'flex', alignItems: 'center', gap: 4 }}>
                {m.label} <QuestionCircleOutlined style={{ fontSize: 10, opacity: 0.5 }} />
              </span>
            </TokenRowTip>
            <span style={{ color: '#e6edf3', fontVariantNumeric: 'tabular-nums', minWidth: 42, textAlign: 'right', fontSize: 12, fontWeight: 600 }}>
              {fmt(v)}
            </span>
            <span style={{ color: '#484f58', minWidth: 52, textAlign: 'right', fontSize: 11 }}>{pct(v)}</span>
          </div>
        )
      })}
      {/* Total */}
      <div style={{ display: 'flex', justifyContent: 'space-between', paddingTop: 8, marginTop: 4, borderTop: '1px solid #21262d', fontWeight: 700 }}>
        <span style={{ color: '#8b949e', fontSize: 12 }}>Total Tokens</span>
        <span style={{ color: '#3fb950', fontVariantNumeric: 'tabular-nums', fontSize: 13 }}>{fmt(usage.totalTokens)}</span>
      </div>
    </div>
  )

  return (
    <Popover
      content={content}
      trigger="hover"
      placement="topLeft"
      overlayInnerStyle={{ background: '#161b22', border: '1px solid #30363d', borderRadius: 10, padding: '12px 16px' }}
      arrow={false}
    >
      <span style={{ cursor: 'help', color: '#3fb950', fontSize: 11, display: 'inline-flex', alignItems: 'center', gap: 3, padding: '0 4px', borderRadius: 4, background: 'rgba(63,185,80,0.08)' }}>
        <ThunderboltOutlined />{fmt(usage.totalTokens)}
      </span>
    </Popover>
  )
}

// ── 思考步骤面板 ──────────────────────────────────────────────────────────────
function ThinkingPanel({ steps, isActive }: { steps: ThinkingStep[]; isActive?: boolean }) {
  const [expanded, setExpanded] = useState(false)
  const { token } = useToken()
  const toolCount  = steps.filter((s) => s.type === 'tool_start').length
  const toolNames  = [...new Set(steps.filter((s) => s.type === 'tool_start').map((s) => s.toolName))]
  const hasFailure = steps.some((s) => s.type === 'tool_end' && s.success === false)
  if (steps.length === 0 && !isActive) return null
  return (
    <div style={{ marginBottom: 8, borderRadius: 8, border: `1px solid ${token.colorBorderSecondary}`, overflow: 'hidden', fontSize: 12 }}>
      <div onClick={() => setExpanded(!expanded)} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 12px', background: token.colorBgElevated, cursor: 'pointer', userSelect: 'none' }}>
        {isActive ? <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#3fb950', animation: 'pulse 1.2s ease-in-out infinite', flexShrink: 0 }} /> : hasFailure ? <span style={{ color: '#f78166' }}>⚠</span> : <span style={{ color: '#3fb950' }}>✓</span>}
        <span style={{ color: token.colorTextSecondary, flex: 1 }}>
          {isActive ? '正在思考...' : toolCount > 0 ? `调用了 ${toolCount} 个工具：${toolNames.join('、')}` : '推理完成'}
        </span>
        <span style={{ color: token.colorTextTertiary, fontSize: 11 }}>{expanded ? '收起 ▲' : '展开 ▼'}</span>
      </div>
      {expanded && (
        <div style={{ padding: '10px 14px', background: token.colorBgContainer }}>
          {steps.map((step, i) => {
            if (step.type === 'thinking') return <div key={i} style={{ marginBottom: 10, padding: '8px 10px', background: 'rgba(139,139,255,0.06)', borderLeft: '3px solid #8b8bff', borderRadius: 4 }}><div style={{ color: '#8b8bff', fontWeight: 600, marginBottom: 4, fontSize: 11 }}>💭 思考</div><div style={{ color: token.colorTextSecondary, lineHeight: 1.6, whiteSpace: 'pre-wrap', fontSize: 12 }}>{step.text}</div></div>
            if (step.type === 'tool_start') return <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 6 }}><span style={{ fontSize: 14, marginTop: 1 }}>🔧</span><div><span style={{ color: '#d29922', fontWeight: 600 }}>{step.toolName}</span>{step.toolArgs && <span style={{ color: token.colorTextTertiary, marginLeft: 6, fontSize: 11 }}>({JSON.stringify(step.toolArgs).slice(0, 120)})</span>}</div></div>
            if (step.type === 'tool_end') return <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 10, paddingLeft: 22 }}><span style={{ fontSize: 13, marginTop: 1 }}>{step.success ? '✅' : '❌'}</span><div style={{ color: step.success ? token.colorTextSecondary : '#f78166', fontSize: 11, maxWidth: 520, wordBreak: 'break-all' }}>{step.outputPreview}</div></div>
            return null
          })}
          {isActive && <div style={{ color: token.colorTextTertiary, fontSize: 11, fontStyle: 'italic' }}>Agent 正在处理...</div>}
        </div>
      )}
    </div>
  )
}

// ── AI 消息 Footer ─────────────────────────────────────────────────────────────
function AiMsgFooter({ msg, onRegenerate }: {
  msg: { id: string; content: string; createdAt: number; conversationId?: string | null; usage?: TokenUsage | null; durationMs?: number }
  onRegenerate: () => void
}) {
  const { token } = useToken()
  const { deleteMessage } = useSessionStore()
  const timeStr = new Date(msg.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 6, paddingLeft: 2, flexWrap: 'wrap' }}>
      <CopyBtn text={msg.content} />
      <Tooltip title="重新生成">
        <Button type="text" size="small" icon={<ReloadOutlined />}
          style={{ color: '#6e7681', padding: '0 4px', height: 22, fontSize: 12 }}
          onClick={onRegenerate}
        />
      </Tooltip>
      <Popconfirm title="删除这条消息？" onConfirm={() => deleteMessage(msg.id)} okText="删除" cancelText="取消" okButtonProps={{ danger: true }}>
        <Tooltip title="删除消息">
          <Button type="text" size="small" icon={<DeleteOutlined />}
            style={{ color: '#6e7681', padding: '0 4px', height: 22, fontSize: 12 }}
          />
        </Tooltip>
      </Popconfirm>
      {/* 分隔线 */}
      <span style={{ width: 1, height: 12, background: token.colorBorderSecondary, margin: '0 2px' }} />
      {/* 时间 */}
      <span style={{ fontSize: 11, color: '#484f58' }}>{timeStr}</span>
      {/* 耗时 */}
      {msg.durationMs != null && (
        <span style={{ fontSize: 11, color: '#484f58', display: 'inline-flex', alignItems: 'center', gap: 2 }}>
          <ClockCircleOutlined style={{ fontSize: 10 }} />{(msg.durationMs / 1000).toFixed(1)}s
        </span>
      )}
      {/* Token 详情 */}
      {msg.usage && <TokenDetail usage={msg.usage} durationMs={msg.durationMs} />}
    </div>
  )
}

// ── 用户消息 Footer（编辑 + 删除）────────────────────────────────────────────
function UserMsgFooter({ msg, onEdit }: {
  msg: { id: string; content: string; createdAt: number }
  onEdit: (newContent: string) => void
}) {
  const { deleteMessage } = useSessionStore()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const timeStr = new Date(msg.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })

  const startEdit = () => { setDraft(msg.content); setEditing(true) }
  const cancelEdit = () => setEditing(false)
  const confirmEdit = () => { if (draft.trim() && draft !== msg.content) { onEdit(draft.trim()) } setEditing(false) }

  if (editing) {
    return (
      <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-end' }}>
        <Input.TextArea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          autoSize={{ minRows: 1, maxRows: 6 }}
          style={{ fontSize: 13, borderRadius: 8 }}
          autoFocus
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); confirmEdit() } if (e.key === 'Escape') cancelEdit() }}
        />
        <div style={{ display: 'flex', gap: 6 }}>
          <Button size="small" onClick={cancelEdit}>取消</Button>
          <Button type="primary" size="small" onClick={confirmEdit}>保存并重发</Button>
        </div>
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 6, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
      <span style={{ fontSize: 11, color: '#484f58' }}>{timeStr}</span>
      <Tooltip title="编辑并重发">
        <Button type="text" size="small" icon={<EditOutlined />}
          style={{ color: '#6e7681', padding: '0 4px', height: 22, fontSize: 12 }}
          onClick={startEdit}
        />
      </Tooltip>
      <Popconfirm title="删除这条消息？" onConfirm={() => deleteMessage(msg.id)} okText="删除" cancelText="取消" okButtonProps={{ danger: true }}>
        <Tooltip title="删除消息">
          <Button type="text" size="small" icon={<DeleteOutlined />}
            style={{ color: '#6e7681', padding: '0 4px', height: 22, fontSize: 12 }}
          />
        </Tooltip>
      </Popconfirm>
    </div>
  )
}

// ── 左侧 Token 统计面板 ───────────────────────────────────────────────────────
function SessionTokenPanel({ usage }: { usage: TokenUsage }) {
  const { token } = useToken()
  const fmt = (n: number) => n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n)
  const total = usage.totalTokens || 1

  return (
    <div style={{ padding: '12px 14px', borderTop: `1px solid ${token.colorBorderSecondary}`, fontSize: 12 }}>
      <Tooltip
        title={<div style={{ fontSize: 12, lineHeight: 1.7 }}><b>当前会话累计 Token 消耗</b><br />统计本会话中所有 AI 回复的 Token 总和。<br /><br />💡 GPT-4o 费用参考：<br />输入：$2.5 / 1M tokens<br />输出：$10 / 1M tokens</div>}
        placement="topLeft"
      >
        <div style={{ fontSize: 11, color: token.colorTextTertiary, fontWeight: 600, letterSpacing: '0.05em', marginBottom: 8, cursor: 'help', display: 'flex', alignItems: 'center', gap: 4, textTransform: 'uppercase' }}>
          TOKEN 消耗 <QuestionCircleOutlined style={{ fontSize: 10 }} />
        </div>
      </Tooltip>
      {/* 堆叠条 */}
      <div style={{ height: 5, borderRadius: 3, overflow: 'hidden', background: token.colorFillTertiary, display: 'flex', gap: 1, marginBottom: 10 }}>
        {TOKEN_META.map((m) => { const v = (usage[m.key] as number) ?? 0; return v > 0 ? <Tooltip key={m.key} title={`${m.label}: ${fmt(v)}`}><div style={{ width: `${(v / total) * 100}%`, background: m.color }} /></Tooltip> : null })}
      </div>
      {/* 行 */}
      {TOKEN_META.map((m) => {
        const v = (usage[m.key] as number) ?? 0
        return (
          <TokenRowTip key={m.key} meta={m}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 5, cursor: 'help', padding: '1px 0' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ width: 8, height: 8, borderRadius: 2, background: m.color, flexShrink: 0 }} />
                <span style={{ color: token.colorTextSecondary, fontSize: 11 }}>{m.label}</span>
                <QuestionCircleOutlined style={{ fontSize: 9, color: token.colorTextTertiary, opacity: 0.6 }} />
              </div>
              <span style={{ color: m.color, fontVariantNumeric: 'tabular-nums', fontWeight: 600, fontSize: 12 }}>{fmt(v)}</span>
            </div>
          </TokenRowTip>
        )
      })}
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8, paddingTop: 8, borderTop: `1px solid ${token.colorBorderSecondary}`, fontWeight: 700 }}>
        <span style={{ color: token.colorText, fontSize: 12 }}>Total</span>
        <span style={{ color: token.colorPrimary, fontSize: 13 }}>{fmt(usage.totalTokens)}</span>
      </div>
    </div>
  )
}

// ══════════════════════════════════════════════════════════════════════════════
// 主 App
// ══════════════════════════════════════════════════════════════════════════════
export default function App() {
  const { token } = useToken()
  const api = (window as any).electronAPI

  const {
    sessions, activeSessionId, messageMap, usageMap,
    addSession, switchSession, deleteSession,
    editUserMessage,
  } = useSessionStore()

  // ── @ant-design/x-sdk 驱动的对话流管理 ──────────────────────────────────
  const { send: xSend, cancel: xCancel } = useXAgentChat()

  const messages     = messageMap[activeSessionId] ?? []
  const sessionUsage = usageMap[activeSessionId]   ?? null

  const [inputValue, setInputValue]       = useState('')
  const [isStreaming, setIsStreaming]     = useState(false)
  const [loadingHistory, setLoadingHistory] = useState(false)

  // ── 滚动控制（企业级：流式中 atBottom 时才自动滚，手动上滑则暂停）─────────
  const scrollRef      = useRef<HTMLDivElement>(null)
  const atBottomRef    = useRef(true)
  const loadedSessions = useRef<Set<string>>(new Set())

  const scrollToBottom = useCallback((smooth = false) => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' })
  }, [])

  // 监听用户滚动，判断是否在底部
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = el
      atBottomRef.current = scrollHeight - scrollTop - clientHeight < 80
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [])

  // 流式时每次内容更新 → 若用户在底部则跟随
  useEffect(() => {
    if (isStreaming && atBottomRef.current) scrollToBottom()
  }, [messages, isStreaming, scrollToBottom])

  // 非流式切换会话/新消息到来 → 直接跳底
  useEffect(() => {
    if (!isStreaming) { atBottomRef.current = true; scrollToBottom() }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSessionId])

  // ── 启动时加载历史 session 列表 ───────────────────────────────────────────
  useEffect(() => {
    ;(async () => {
      try {
        const res = await fetch(`${BASE_URL}/api/v1/conversation/sessions`)
        if (!res.ok) return
        const data = await res.json() as { sessions?: Array<{ sessionId: string; lastMessage: string; lastAt: number }> }
        const remote = data.sessions ?? []
        if (remote.length === 0) return
        useSessionStore.setState((state) => {
          const existingIds = new Set(state.sessions.map((s) => s.id))
          const newSessions = remote.filter((s) => !existingIds.has(s.sessionId)).map((s) => ({
            id: s.sessionId,
            title: s.lastMessage ? s.lastMessage.slice(0, 22) + (s.lastMessage.length > 22 ? '...' : '') : `历史会话 ${new Date(s.lastAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}`,
            createdAt: s.lastAt, lastMessage: s.lastMessage,
          }))
          if (newSessions.length === 0) return state
          const merged = [...newSessions, ...state.sessions].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
          const msgMap = { ...state.messageMap }
          const usageMap = { ...state.usageMap }
          newSessions.forEach((s) => { if (!msgMap[s.id]) msgMap[s.id] = []; if (!usageMap[s.id]) usageMap[s.id] = null })
          return { sessions: merged, messageMap: msgMap, usageMap }
        })
      } catch { /* ignore */ }
    })()
  }, [])

  // ── 加载单个 session 历史消息 ─────────────────────────────────────────────
  const loadHistory = useCallback(async (sessionId: string) => {
    if (loadedSessions.current.has(sessionId)) return
    loadedSessions.current.add(sessionId)
    setLoadingHistory(true)
    try {
      const res = await fetch(`${BASE_URL}/api/v1/conversation/history?sessionId=${encodeURIComponent(sessionId)}`)
      if (!res.ok) return
      const data = await res.json() as { messages?: Array<{ role: string; content: string; createdAt?: number }> }
      const msgs = (data.messages ?? []).filter((m) => (m.role === 'user' || m.role === 'assistant') && m.content?.trim())
      if (msgs.length === 0) return
      const existing = useSessionStore.getState().messageMap[sessionId] ?? []
      if (existing.length > 0) return
      const hydrated = msgs.map((m, i) => ({
        id: `hist_${i}_${Math.random().toString(36).slice(2, 6)}`,
        role: m.role as 'user' | 'assistant',
        content: m.content,
        status: 'done' as const,
        createdAt: m.createdAt ?? (Date.now() - (msgs.length - i) * 1000),
      }))
      useSessionStore.setState((state) => ({ messageMap: { ...state.messageMap, [sessionId]: hydrated } }))
    } catch { /* ignore */ } finally {
      setLoadingHistory(false)
    }
  }, [])

  useEffect(() => { setInputValue(''); loadHistory(activeSessionId) }, [activeSessionId, loadHistory])

  // ── 发送消息（委托给 useXAgentChat hook）────────────────────────────────
  const sendMessage = useCallback(async (content: string) => {
    if (!content.trim() || isStreaming) return
    setInputValue('')
    setIsStreaming(true)
    atBottomRef.current = true
    scrollToBottom()
    try {
      await xSend(content, activeSessionId)
    } finally {
      setIsStreaming(false)
      setTimeout(() => scrollToBottom(true), 100)
    }
  }, [activeSessionId, isStreaming, xSend, scrollToBottom])

  // ── 重新生成：删掉最后一条 AI 回复，重发上一条用户消息 ───────────────────
  const regenerate = useCallback(() => {
    const msgs = messageMap[activeSessionId] ?? []
    const lastAi = [...msgs].reverse().find((m) => m.role === 'assistant')
    const lastUser = [...msgs].reverse().find((m) => m.role === 'user')
    if (!lastAi || !lastUser || isStreaming) return
    useSessionStore.getState().deleteMessage(lastAi.id)
    setTimeout(() => sendMessage(lastUser.content), 50)
  }, [activeSessionId, messageMap, isStreaming, sendMessage])

  // ── 编辑用户消息并重发 ────────────────────────────────────────────────────
  const editAndResend = useCallback((msgId: string, newContent: string) => {
    editUserMessage(msgId, newContent)
    // 删掉该消息之后的所有消息，再重发
    const msgs = messageMap[activeSessionId] ?? []
    const idx = msgs.findIndex((m) => m.id === msgId)
    if (idx >= 0) {
      const toDelete = msgs.slice(idx + 1)
      toDelete.forEach((m) => useSessionStore.getState().deleteMessage(m.id))
    }
    setTimeout(() => sendMessage(newContent), 80)
  }, [activeSessionId, messageMap, editUserMessage, sendMessage])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: token.colorBgBase, overflow: 'hidden' }}>

      {/* 标题栏 */}
      <div style={{ height: 40, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 12px', background: token.colorBgContainer, borderBottom: `1px solid ${token.colorBorderSecondary}`, WebkitAppRegion: 'drag' as any, userSelect: 'none' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <RobotOutlined style={{ color: token.colorPrimary, fontSize: 15 }} />
          <span style={{ color: token.colorTextSecondary, fontSize: 13, fontWeight: 500 }}>Agent Desktop</span>
          <span style={{ fontSize: 11, color: '#3fb950', background: 'rgba(63,185,80,0.12)', padding: '1px 8px', borderRadius: 10 }}>● 已连接</span>
        </div>
        <div style={{ display: 'flex', gap: 2, WebkitAppRegion: 'no-drag' as any }}>
          <Button type="text" size="small" icon={<MinusOutlined />} style={{ width: 28, height: 28, padding: 0 }} onClick={() => api?.windowMinimize()} />
          <Button type="text" size="small" icon={<BorderOutlined />} style={{ width: 28, height: 28, padding: 0 }} onClick={() => api?.windowMaximize()} />
          <Button type="text" size="small" icon={<CloseOutlined />} danger style={{ width: 28, height: 28, padding: 0 }} onClick={() => api?.windowClose()} />
        </div>
      </div>

      {/* 主体 */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>

        {/* 左侧栏 */}
        <div style={{ width: 240, flexShrink: 0, display: 'flex', flexDirection: 'column', background: token.colorBgLayout, borderRight: `1px solid ${token.colorBorderSecondary}`, overflow: 'hidden' }}>
          <div style={{ padding: '12px 10px 8px' }}>
            <Button type="primary" icon={<PlusOutlined />} block onClick={addSession} style={{ borderRadius: 8 }}>新建会话</Button>
          </div>
          <div style={{ flex: 1, overflow: 'auto' }}>
            <Conversations
              activeKey={activeSessionId}
              items={sessions.map((s) => ({ key: s.id, label: s.title }))}
              onActiveChange={switchSession}
              menu={(conv) => ({ items: [{ key: 'delete', label: '删除', icon: <DeleteOutlined />, danger: true, onClick: () => deleteSession(conv.key) }] })}
              style={{ padding: '0 6px' }}
            />
          </div>
          {sessionUsage && <SessionTokenPanel usage={sessionUsage} />}
        </div>

        {/* 对话区 */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

          {/* ✅ 消息列表 - 使用 ref 控制滚动，不用 scrollIntoView */}
          <div ref={scrollRef} style={{ flex: 1, overflowY: 'auto', padding: '24px 32px' }} className="msg-scroll">
            {messages.length === 0 && loadingHistory ? (
              <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: token.colorTextTertiary, fontSize: 13 }}>
                ⏳ 正在加载历史消息...
              </div>
            ) : messages.length === 0 ? (
              <div style={{ height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 28 }}>
                <Welcome
                  icon={<RobotOutlined style={{ fontSize: 40, color: token.colorPrimary }} />}
                  title="你好，我是 AI Agent 👋"
                  description="我可以帮你搜索信息、分析数据、写作创作，还能通过工具完成复杂任务"
                />
                <Prompts
                  items={WELCOME_PROMPTS}
                  onItemClick={(item) => sendMessage(PROMPT_MESSAGES[item.data.key as string] ?? String(item.data.label))}
                  wrap style={{ maxWidth: 540 }}
                />
              </div>
            ) : (
              <Bubble.List
                role={{
                  user: {
                    placement: 'end',
                    avatar: <UserOutlined style={{ fontSize: 14, color: '#fff', background: token.colorPrimary, borderRadius: '50%', padding: 6 }} />,
                    styles: { content: { background: token.colorPrimary, color: '#fff', borderRadius: '12px 4px 12px 12px', maxWidth: 560 } },
                  },
                  assistant: {
                    placement: 'start',
                    avatar: <RobotOutlined style={{ fontSize: 14, color: '#fff', background: '#238636', borderRadius: '50%', padding: 6 }} />,
                    contentRender: (content) => (
                      <div className="md-body">
                        <ReactMarkdown
                          remarkPlugins={[remarkGfm, remarkMath] as any}
                          rehypePlugins={[rehypeKatex, rehypeHighlight] as any}
                        >
                          {String(content)}
                        </ReactMarkdown>
                      </div>
                    ),
                    styles: { content: { background: token.colorBgContainer, border: `1px solid ${token.colorBorder}`, borderRadius: '4px 12px 12px 12px', maxWidth: 740 } },
                  },
                }}
                items={messages.map((msg) => ({
                  key:     msg.id,
                  role:    msg.role,
                  content: msg.content,
                  loading: msg.status === 'loading' && !msg.content,
                  header: msg.role === 'assistant' && (msg.thinkingSteps?.length ?? 0) > 0 ? (
                    <ThinkingPanel steps={msg.thinkingSteps!} isActive={msg.status === 'loading'} />
                  ) : msg.role === 'assistant' && msg.status === 'loading' ? (
                    <ThinkingPanel steps={[]} isActive />
                  ) : undefined,
                  footer: msg.role === 'assistant' && msg.status === 'done' && msg.content ? (
                    <>
                      {msg.card && <XCardRenderer card={msg.card} />}
                      <AiMsgFooter msg={msg} onRegenerate={regenerate} />
                    </>
                  ) : msg.role === 'user' ? (
                    <UserMsgFooter msg={msg} onEdit={(newContent) => editAndResend(msg.id, newContent)} />
                  ) : undefined,
                }))}
              />
            )}
          </div>

          {/* 输入区 */}
          <div style={{ padding: '14px 32px 18px', borderTop: `1px solid ${token.colorBorderSecondary}`, flexShrink: 0 }}>
            <Sender
              value={inputValue}
              onChange={setInputValue}
              onSubmit={sendMessage}
              onCancel={() => { xCancel(); setInputValue('') }}
              loading={isStreaming}
              disabled={isStreaming}
              placeholder="输入消息，Enter 发送，Shift+Enter 换行..."
              style={{ borderRadius: 12 }}
              actions={(_, info) => {
                const { SendButton, LoadingButton, ClearButton } = info.components
                return <><ClearButton key="clear" />{isStreaming ? <LoadingButton key="loading" /> : <SendButton key="send" />}</>
              }}
            />
            <div style={{ textAlign: 'center', fontSize: 11, color: token.colorTextTertiary, marginTop: 6 }}>
              {isStreaming ? '🤔 Agent 正在思考中...' : '⏎ 发送 · Shift+⏎ 换行 · Esc 取消'}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}