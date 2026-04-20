/**
 * XCardRenderer
 * 根据 card.type 分发到不同的卡片组件，实现 A2UI 动态卡片协议。
 */
import React, { useState, useCallback } from 'react'
import { Table, Tag, Collapse, Button, theme } from 'antd'
import { CheckCircleOutlined, CodeOutlined, InfoCircleOutlined, UnorderedListOutlined, TableOutlined } from '@ant-design/icons'
import XMarkdown from '@ant-design/x-markdown'
import type { XCardData } from '../hooks/useXAgentChat'

const { useToken } = theme

interface XCardRendererProps {
  card: XCardData
  onAction?: (value: string) => void
}

// ── InfoCard ─────────────────────────────────────────────────────────────────
function InfoCard({ card, onAction }: { card: XCardData; onAction?: (v: string) => void }) {
  const { token } = useToken()
  return (
    <div style={{ background: token.colorBgElevated, border: `1px solid ${token.colorBorderSecondary}`, borderRadius: 10, padding: '14px 16px', marginBottom: 10 }}>
      {card.title && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, fontWeight: 600, fontSize: 14, color: token.colorText }}>
          <InfoCircleOutlined style={{ color: token.colorPrimary }} />
          {card.title}
        </div>
      )}
      {card.fields?.map((f, i) => (
        <div key={i} style={{ display: 'flex', padding: '6px 0', borderBottom: i < (card.fields?.length ?? 0) - 1 ? `1px solid ${token.colorBorderSecondary}` : 'none' }}>
          <span style={{ width: 120, color: token.colorTextTertiary, fontSize: 12, flexShrink: 0 }}>{f.label}</span>
          <span style={{ color: token.colorText, fontSize: 13, flex: 1 }}>{f.value}</span>
        </div>
      ))}
      {card.actions && <CardActions actions={card.actions} onAction={onAction} />}
    </div>
  )
}

// ── TableCard ─────────────────────────────────────────────────────────────────
function TableCard({ card, onAction }: { card: XCardData; onAction?: (v: string) => void }) {
  const { token } = useToken()
  const columns = (card.columns ?? []).map((c) => ({
    key:       c.key,
    dataIndex: c.key,
    title:     c.title,
    ellipsis:  true,
  }))
  const dataSource = (card.dataSource ?? []).map((row, i) => ({ ...row, key: i }))

  return (
    <div style={{ background: token.colorBgElevated, border: `1px solid ${token.colorBorderSecondary}`, borderRadius: 10, padding: '14px 16px', marginBottom: 10 }}>
      {card.title && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, fontWeight: 600, fontSize: 14, color: token.colorText }}>
          <TableOutlined style={{ color: '#fbbf24' }} />
          {card.title}
          <Tag color="gold" style={{ marginLeft: 'auto', fontSize: 11 }}>{dataSource.length} 条</Tag>
        </div>
      )}
      <Table
        columns={columns}
        dataSource={dataSource}
        size="small"
        pagination={dataSource.length > 10 ? { pageSize: 10, size: 'small' } : false}
        scroll={{ x: true }}
        style={{ fontSize: 12 }}
      />
      {card.actions && <CardActions actions={card.actions} onAction={onAction} />}
    </div>
  )
}

// ── ListCard ──────────────────────────────────────────────────────────────────
function ListCard({ card, onAction }: { card: XCardData; onAction?: (v: string) => void }) {
  const { token } = useToken()
  return (
    <div style={{ background: token.colorBgElevated, border: `1px solid ${token.colorBorderSecondary}`, borderRadius: 10, padding: '14px 16px', marginBottom: 10 }}>
      {card.title && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, fontWeight: 600, fontSize: 14, color: token.colorText }}>
          <UnorderedListOutlined style={{ color: '#38bdf8' }} />
          {card.title}
        </div>
      )}
      {card.items?.map((item, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '8px 0', borderBottom: i < (card.items?.length ?? 0) - 1 ? `1px solid ${token.colorBorderSecondary}` : 'none' }}>
          {item.icon && <span style={{ fontSize: 16, flexShrink: 0, marginTop: 1 }}>{item.icon}</span>}
          <div>
            <div style={{ fontWeight: 500, color: token.colorText, fontSize: 13 }}>{item.title}</div>
            {item.description && <div style={{ color: token.colorTextSecondary, fontSize: 12, marginTop: 2 }}>{item.description}</div>}
          </div>
        </div>
      ))}
      {card.actions && <CardActions actions={card.actions} onAction={onAction} />}
    </div>
  )
}

// ── SkillCard ─────────────────────────────────────────────────────────────────
function SkillCard({ card, onAction }: { card: XCardData; onAction?: (v: string) => void }) {
  const { token } = useToken()
  const isCode = card.details?.format === 'code'

  return (
    <div style={{ background: token.colorBgElevated, border: `1px solid #238636`, borderRadius: 10, overflow: 'hidden', marginBottom: 10 }}>
      {/* 标题行 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', background: 'rgba(35,134,54,0.1)', borderBottom: `1px solid #238636` }}>
        <CheckCircleOutlined style={{ color: '#3fb950', fontSize: 14 }} />
        <span style={{ fontWeight: 600, color: token.colorText, fontSize: 13 }}>{card.skillName ?? 'Skill Result'}</span>
        <Tag color="success" style={{ marginLeft: 'auto', fontSize: 11 }}>已完成</Tag>
      </div>
      {/* 摘要 */}
      {card.summary && (
        <div style={{ padding: '10px 14px', color: token.colorTextSecondary, fontSize: 13, borderBottom: `1px solid ${token.colorBorderSecondary}` }}>
          {card.summary}
        </div>
      )}
      {/* 详情 */}
      {card.details && (
        <Collapse
          ghost
          size="small"
          items={[{
            key: '1',
            label: <span style={{ fontSize: 12, color: token.colorTextTertiary }}><CodeOutlined style={{ marginRight: 4 }} />查看详情</span>,
            children: isCode ? (
              <XMarkdown content={`\`\`\`${card.details.lang ?? ''}\n${card.details.content}\n\`\`\``} />
            ) : (
              <div style={{ color: token.colorTextSecondary, fontSize: 12, whiteSpace: 'pre-wrap' }}>{card.details.content}</div>
            ),
          }]}
        />
      )}
      {card.actions && <div style={{ padding: '8px 14px' }}><CardActions actions={card.actions} onAction={onAction} /></div>}
    </div>
  )
}

// ── Action 按钮组 ─────────────────────────────────────────────────────────────
function CardActions({ actions, onAction }: { actions: XCardData['actions']; onAction?: (v: string) => void }) {
  const [loading, setLoading] = useState<string | null>(null)
  const handleClick = useCallback((value: string) => {
    if (loading) return
    setLoading(value)
    onAction?.(value)
    setTimeout(() => setLoading(null), 2000)
  }, [loading, onAction])

  if (!actions?.length) return null
  return (
    <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
      {actions.map((action, i) => (
        <Button
          key={i}
          size="small"
          type={action.variant === 'primary' ? 'primary' : 'default'}
          loading={loading === action.value}
          onClick={() => handleClick(action.value)}
          style={{ fontSize: 12 }}
        >
          {action.label}
        </Button>
      ))}
    </div>
  )
}

// ── 主分发组件 ────────────────────────────────────────────────────────────────
export default function XCardRenderer({ card, onAction }: XCardRendererProps) {
  try {
    switch (card.type) {
      case 'info':         return <InfoCard card={card} onAction={onAction} />
      case 'table':        return <TableCard card={card} onAction={onAction} />
      case 'list':         return <ListCard card={card} onAction={onAction} />
      case 'skill-result': return <SkillCard card={card} onAction={onAction} />
      default:
        // 未知类型：降级为 info 卡片渲染
        return <InfoCard card={{ ...card, title: card.title ?? `卡片 (${card.type})` }} onAction={onAction} />
    }
  } catch {
    return null  // 渲染失败静默降级
  }
}
