import { useEffect, useRef } from 'react'
import { Bubble, Sender } from '@ant-design/x'
import { RobotOutlined, UserOutlined, CopyOutlined, CheckOutlined } from '@ant-design/icons'
import { Button, Tooltip, theme } from 'antd'
import { useSessionStore } from '../store/session'
import { useChat } from '../hooks/useChat'
import styles from './ChatArea.module.css'
import { useState } from 'react'

const { useToken } = theme

const WELCOME_PROMPTS = [
  { label: '🔍 网络搜索', value: '帮我搜索一下最新的 AI 新闻' },
  { label: '📊 数据分析', value: '帮我分析一份 CSV 数据' },
  { label: '💡 头脑风暴', value: '帮我想5个创业方向' },
  { label: '📝 写作助手', value: '帮我写一篇产品介绍文案' },
]

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <Tooltip title={copied ? '已复制' : '复制'}>
      <Button
        type="text"
        size="small"
        icon={copied ? <CheckOutlined style={{ color: '#3fb950' }} /> : <CopyOutlined />}
        onClick={() => {
          navigator.clipboard.writeText(text)
          setCopied(true)
          setTimeout(() => setCopied(false), 2000)
        }}
        style={{ color: '#6e7681' }}
      />
    </Tooltip>
  )
}

export function ChatArea() {
  // 从 messageMap 读当前会话消息，切换会话时自动更新
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const messages = useSessionStore((s) => s.messageMap[s.activeSessionId] ?? [])
  const isStreaming = useSessionStore((s) => s.isStreaming)
  const { sendMessage } = useChat()
  const bottomRef = useRef<HTMLDivElement>(null)
  // 受控输入框 value，发送后主动清空
  const [inputValue, setInputValue] = useState('')

  const handleSubmit = async (val: string) => {
    if (!val.trim() || isStreaming) return
    setInputValue('')          // 立即清空输入框
    await sendMessage(val)
  }

  // 切换会话时清空输入框
  useEffect(() => {
    setInputValue('')
  }, [activeSessionId])

  // 自动滚动到底部
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  return (
    <div className={styles.container}>
      {/* 消息列表 */}
      <div className={styles.messages}>
        {messages.length === 0 ? (
          <div className={styles.welcome}>
            <RobotOutlined className={styles.welcomeIcon} />
            <h2 className={styles.welcomeTitle}>你好，我是 AI Agent</h2>
            <p className={styles.welcomeSub}>我可以帮你搜索、分析、创作，还能调用各种工具完成复杂任务</p>
            <div className={styles.prompts}>
              {WELCOME_PROMPTS.map((p) => (
                <button key={p.value} className={styles.promptBtn} onClick={() => sendMessage(p.value)}>
                  {p.label}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className={styles.bubbleList}>
            {messages.map((msg) => (
              <div
                key={msg.id}
                className={`${styles.bubbleWrapper} ${msg.role === 'user' ? styles.userWrapper : styles.assistantWrapper}`}
              >
                <Bubble
                  placement={msg.role === 'user' ? 'end' : 'start'}
                  content={msg.content || (msg.status === 'loading' ? '▌' : '')}
                  loading={msg.status === 'loading' && !msg.content}
                  avatar={
                    msg.role === 'user'
                      ? { icon: <UserOutlined />, style: { background: '#1f6feb', color: '#fff' } }
                      : { icon: <RobotOutlined />, style: { background: '#238636', color: '#fff' } }
                  }
                  styles={{
                    content: {
                      background: msg.role === 'user' ? '#1f6feb' : '#161b22',
                      color: '#c9d1d9',
                      border: msg.role === 'user' ? 'none' : '1px solid #30363d',
                      borderRadius: '10px',
                      fontSize: '14px',
                      lineHeight: '1.6',
                      maxWidth: '680px',
                      padding: '10px 14px',
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-word',
                    },
                  }}
                  footer={
                    msg.role === 'assistant' && msg.status === 'done' && msg.content ? (
                      <div className={styles.bubbleFooter}>
                        <CopyButton text={msg.content} />
                        <span className={styles.metaTime}>
                          {new Date(msg.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                        </span>
                        {msg.completionTokens !== undefined && (
                          <span className={styles.metaTokens}>
                            {msg.completionTokens} tokens
                          </span>
                        )}
                        {msg.conversationId && (
                          <span className={styles.convIdBadge}>
                            ID: {msg.conversationId.slice(0, 8)}…
                          </span>
                        )}
                      </div>
                    ) : null
                  }
                />
              </div>
            ))}
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* 输入框 */}
      <div className={styles.senderWrapper}>
        <Sender
          value={inputValue}
          onChange={setInputValue}
          placeholder="输入消息，Ctrl+Enter 发送..."
          disabled={isStreaming}
          loading={isStreaming}
          onSubmit={handleSubmit}
          onCancel={() => { setInputValue('') }}
          style={{
            background: '#161b22',
            border: '1px solid #30363d',
            borderRadius: '10px',
          }}
          styles={{
            input: { color: '#c9d1d9', background: 'transparent', fontSize: '14px' },
          }}
          actions={(_, info) => {
            const { SendButton, LoadingButton, ClearButton } = info.components
            return (
              <>
                <ClearButton />
                {isStreaming ? <LoadingButton /> : <SendButton />}
              </>
            )
          }}
        />
        <div className={styles.hint}>
          {isStreaming ? '🤔 Agent 正在思考中...' : 'Ctrl+Enter 发送 · Shift+Enter 换行'}
        </div>
      </div>
    </div>
  )
}