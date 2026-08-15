/**
 * 会话导出弹窗 —— 按轮次勾选导出（避免万条消息全量导出）
 *
 * 交互：导出按钮 → 弹出轮次列表（倒序，最新在前，默认勾选最后一轮）
 *      → 勾选任意轮次 → 导出 Markdown / 复制选中内容
 */
import React, { useMemo, useState } from 'react'
import { Modal, Button, Checkbox, Space, Input, App, Tag } from 'antd'
import { SearchOutlined } from '@ant-design/icons'
import type { Message, Session } from '@core/types'
import { copyToClipboard } from '@core/utils/clipboard'
import {
  buildSessionMarkdown,
  downloadText,
  sessionFileName,
  splitRounds,
  type Round,
} from '../utils/sessionExport'

interface ExportDialogProps {
  open: boolean
  session: Session | null
  messages: Message[]
  agentName?: string
  onClose: () => void
}

function roundSummary(r: Round): { user: string; ai: string; time: string } {
  const user = (typeof r.userMessage.content === 'string'
    ? r.userMessage.content
    : (r.userMessage.content ?? []).map((p: any) => p?.text ?? '').join(' ')
  ).replace(/\s+/g, ' ').trim()
  const lastAi = r.assistantMessages[r.assistantMessages.length - 1]
  const ai = lastAi
    ? (typeof lastAi.content === 'string'
        ? lastAi.content
        : (lastAi.content ?? []).map((p: any) => p?.text ?? '').join(' ')
      ).replace(/\s+/g, ' ').trim()
    : ''
  return {
    user: user.length > 60 ? user.slice(0, 60) + '…' : user || '（空）',
    ai: ai.length > 60 ? ai.slice(0, 60) + '…' : ai || '（无回复）',
    time: new Date(r.userMessage.createdAt).toLocaleString('zh-CN', { hour12: false }),
  }
}

export const ExportDialog: React.FC<ExportDialogProps> = ({
  open, session, messages, agentName, onClose,
}) => {
  const { message } = App.useApp()
  const [keyword, setKeyword] = useState('')

  // 倒序（最新在前），默认勾选最后一轮
  const roundsDesc = useMemo(() => splitRounds(messages).reverse(), [messages])
  const [selected, setSelected] = useState<Set<number>>(new Set())

  // 打开时默认勾选最新一轮
  React.useEffect(() => {
    if (open && roundsDesc.length > 0) {
      setSelected(new Set([roundsDesc[0].index]))
    }
  }, [open, roundsDesc.length > 0]) // eslint-disable-line react-hooks/exhaustive-deps

  const filtered = useMemo(() => {
    const kw = keyword.trim().toLowerCase()
    if (!kw) return roundsDesc
    return roundsDesc.filter((r) => {
      const s = roundSummary(r)
      return s.user.toLowerCase().includes(kw) || s.ai.toLowerCase().includes(kw)
    })
  }, [roundsDesc, keyword])

  const chosenMessages = useMemo(() => {
    // 选中轮次的消息（按时间正序拼接）
    const picked: Message[] = []
    for (const r of roundsDesc) {
      if (selected.has(r.index)) {
        picked.push(r.userMessage, ...r.assistantMessages)
      }
    }
    return picked.sort((a, b) => a.createdAt - b.createdAt)
  }, [roundsDesc, selected])

  const toggle = (idx: number) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(idx)) next.delete(idx)
      else next.add(idx)
      return next
    })
  }

  const toggleAll = () => {
    if (selected.size === roundsDesc.length) setSelected(new Set())
    else setSelected(new Set(roundsDesc.map((r) => r.index)))
  }

  const doExport = async (mode: 'download' | 'copy') => {
    if (!session || chosenMessages.length === 0) {
      message.warning('请先勾选要导出的轮次')
      return
    }
    const md = buildSessionMarkdown(session, chosenMessages, agentName)
    if (mode === 'download') {
      const first = selected.values().next().value
      const suffix = selected.size === 1 ? `第${first}轮` : `${selected.size}轮`
      downloadText(sessionFileName(session).replace(/\.md$/, `-${suffix}.md`), md)
      message.success(`已导出 ${selected.size} 轮（${chosenMessages.length} 条消息）`)
    } else {
      const ok = await copyToClipboard(md)
      if (ok) message.success(`已复制 ${selected.size} 轮内容（${md.length} 字符）`)
      else message.error('复制失败，请改用导出文件')
    }
  }

  if (!session) return null

  return (
    <Modal
      open={open}
      onCancel={onClose}
      width={560}
      title={`导出对话 · ${session.title}`}
      footer={
        <Space>
          <span style={{ color: '#888', fontSize: 12, marginRight: 'auto' }}>
            已选 {selected.size} 轮 / {roundsDesc.length} 轮 · {chosenMessages.length} 条消息
          </span>
          <Button onClick={onClose}>取消</Button>
          <Button onClick={() => void doExport('copy')} disabled={selected.size === 0}>
            复制选中内容
          </Button>
          <Button type="primary" onClick={() => void doExport('download')} disabled={selected.size === 0}>
            导出 Markdown
          </Button>
        </Space>
      }
    >
      <Space direction="vertical" style={{ width: '100%' }} size="small">
        <Space.Compact style={{ width: '100%' }}>
          <Input
            prefix={<SearchOutlined style={{ color: '#666' }} />}
            placeholder="搜索轮次内容…"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            allowClear
            size="small"
          />
          <Button size="small" onClick={toggleAll}>
            {selected.size === roundsDesc.length && roundsDesc.length > 0 ? '取消全选' : '全选'}
          </Button>
        </Space.Compact>

        <div
          style={{
            maxHeight: 360, overflowY: 'auto', border: '1px solid rgba(255,255,255,0.08)',
            borderRadius: 6, padding: 4,
          }}
        >
          {filtered.length === 0 && (
            <div style={{ color: '#888', fontSize: 12, textAlign: 'center', padding: 24 }}>
              没有匹配的轮次
            </div>
          )}
          {filtered.map((r) => {
            const s = roundSummary(r)
            const checked = selected.has(r.index)
            return (
              <div
                key={r.index}
                onClick={() => toggle(r.index)}
                style={{
                  display: 'flex', gap: 8, alignItems: 'flex-start', padding: '6px 8px',
                  borderRadius: 4, cursor: 'pointer',
                  background: checked ? 'rgba(88,166,255,0.08)' : 'transparent',
                }}
              >
                <Checkbox checked={checked} style={{ marginTop: 2 }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <span style={{ color: '#58a6ff', fontSize: 11, fontFamily: 'monospace' }}>#{r.index}</span>
                    <span style={{ color: '#888', fontSize: 11 }}>{s.time}</span>
                    {r.assistantMessages.length > 1 && (
                      <Tag style={{ fontSize: 10, lineHeight: '16px', marginRight: 0 }}>
                        {r.assistantMessages.length} 条回复
                      </Tag>
                    )}
                  </div>
                  <div style={{ color: '#ccc', fontSize: 12, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    🧑 {s.user}
                  </div>
                  <div style={{ color: '#888', fontSize: 11, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    🤖 {s.ai}
                  </div>
                </div>
              </div>
            )
          })}
        </div>

        <div style={{ color: '#666', fontSize: 11 }}>
          提示：导出内容含选中轮次的完整对话、思考过程与工具调用，用于分析 AI 输出问题。
        </div>
      </Space>
    </Modal>
  )
}
