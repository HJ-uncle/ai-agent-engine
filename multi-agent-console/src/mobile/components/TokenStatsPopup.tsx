import React from 'react'
import { Popup, ProgressBar, List } from 'antd-mobile'
import type { TokenUsage } from '@core/types'
import styles from './TokenStatsPopup.module.css'

interface TokenStatsPopupProps {
  visible: boolean
  onClose: () => void
  usage: TokenUsage
  modelId?: string
}

const TOKEN_META = [
  { key: 'messagesTokens' as keyof TokenUsage, color: '#6366f1', label: '对话历史' },
  { key: 'systemPromptTokens' as keyof TokenUsage, color: '#3b82f6', label: '系统指令' },
  { key: 'skillTokens' as keyof TokenUsage, color: '#c084fc', label: '技能 Prompt' },
  { key: 'ragTokens' as keyof TokenUsage, color: '#34d399', label: '知识库(RAG)' },
  { key: 'mcpToolsTokens' as keyof TokenUsage, color: '#f97316', label: 'MCP 工具' },
  { key: 'builtinToolsTokens' as keyof TokenUsage, color: '#fbbf24', label: '内置工具' },
  { key: 'toolResultsTokens' as keyof TokenUsage, color: '#a78bfa', label: '工具结果' },
  { key: 'completionTokens' as keyof TokenUsage, color: '#fb7185', label: '生成内容' },
]

function fmtToken(n: number = 0) {
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k'
  return n.toString()
}

export const TokenStatsPopup: React.FC<TokenStatsPopupProps> = ({ visible, onClose, usage, modelId }) => {
  const total = usage.totalTokens || 1

  return (
    <Popup
      visible={visible}
      onMaskClick={onClose}
      onClose={onClose}
      bodyStyle={{ borderTopLeftRadius: '12px', borderTopRightRadius: '12px', minHeight: '40vh' }}
    >
      <div className={styles.container}>
        <div className={styles.header}>
          <div className={styles.title}>Token 消耗详情</div>
          <div className={styles.modelId}>{modelId}</div>
        </div>

        {/* 比例条 */}
        <div className={styles.chartBar}>
          {TOKEN_META.map(m => {
            const v = (usage[m.key] as number) ?? 0
            if (v === 0) return null
            return (
              <div
                key={m.key}
                style={{
                  width: `${(v / total) * 100}%`,
                  backgroundColor: m.color,
                  height: '100%',
                }}
              />
            )
          })}
        </div>

        <List className={styles.list}>
          {TOKEN_META.map(m => {
            const v = (usage[m.key] as number) ?? 0
            if (v === 0) return null
            return (
              <List.Item
                key={m.key}
                prefix={<div className={styles.dot} style={{ backgroundColor: m.color }} />}
                extra={fmtToken(v)}
              >
                {m.label}
              </List.Item>
            )
          })}
          
          <List.Item extra={fmtToken(usage.promptTokens)} className={styles.groupItem}>
            输入 (Prompt)
          </List.Item>
          <List.Item extra={fmtToken(usage.completionTokens)} className={styles.groupItem}>
            输出 (Completion)
          </List.Item>
          <List.Item extra={<span className={styles.totalVal}>{fmtToken(usage.totalTokens)}</span>} className={styles.totalItem}>
            总计消耗
          </List.Item>
        </List>

        {/* DeepSeek 专有指标 */}
        {((usage.cacheHitTokens ?? 0) > 0 || (usage.reasoningTokens ?? 0) > 0) && (
          <div className={styles.deepseekSection}>
            <div className={styles.dsTitle}>🐋 DeepSeek 专有指标</div>
            <List mode="card" className={styles.dsList}>
              {usage.reasoningTokens ? (
                <List.Item extra={fmtToken(usage.reasoningTokens)}>思维链 (Reasoning)</List.Item>
              ) : null}
              {usage.cacheHitTokens ? (
                <List.Item extra={<span className={styles.hitText}>{fmtToken(usage.cacheHitTokens)}</span>}>
                  KV Cache 命中
                </List.Item>
              ) : null}
            </List>
          </div>
        )}
      </div>
    </Popup>
  )
}
