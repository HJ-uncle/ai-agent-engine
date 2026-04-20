import { useSessionStore } from '../store/session'
import styles from './TokenPanel.module.css'

const COLORS = {
  systemPrompt: '#58a6ff',
  systemTools:  '#3fb950',
  messages:     '#d29922',
  skills:       '#bc8cff',
  completion:   '#f78166',
}

export function TokenPanel() {
  // 从 usageMap 读取当前会话的 usage，切换会话时自动更新
  const lastUsage = useSessionStore((s) => s.usageMap[s.activeSessionId] ?? null)

  if (!lastUsage) {
    return (
      <div className={styles.panel}>
        <div className={styles.title}>本次会话消耗 Tokens 分布</div>
        <div className={styles.empty}>发送消息后显示 Token 统计</div>
      </div>
    )
  }

  const u = lastUsage
  const total = u.totalTokens || 1
  const pct = (n: number) => ((n / total) * 100).toFixed(1) + '%'
  const fmt = (n: number) => n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n)

  const rows = [
    { label: 'System Prompt', value: u.systemPromptTokens, color: COLORS.systemPrompt },
    { label: 'System Tools',  value: u.systemToolsTokens,  color: COLORS.systemTools },
    { label: 'Messages',      value: u.messagesTokens,      color: COLORS.messages },
    { label: 'Skill Tokens',  value: u.skillTokens,         color: COLORS.skills },
    { label: 'Completion',    value: u.completionTokens,    color: COLORS.completion },
  ]

  return (
    <div className={styles.panel}>
      <div className={styles.title}>本次会话消耗 Tokens 分布</div>

      {/* 色块进度条 */}
      <div className={styles.bar}>
        {rows.map((r) => r.value > 0 && (
          <div
            key={r.label}
            className={styles.barSegment}
            style={{ width: pct(r.value), background: r.color }}
            title={`${r.label}: ${r.value}`}
          />
        ))}
      </div>

      {/* 明细列表 */}
      <div className={styles.rows}>
        {rows.map((r) => (
          <div key={r.label} className={styles.row}>
            <span className={styles.dot} style={{ background: r.color }} />
            <span className={styles.label}>{r.label}</span>
            <span className={styles.value}>{fmt(r.value)}</span>
            <span className={styles.percent}>({pct(r.value)})</span>
          </div>
        ))}
        <div className={styles.divider} />
        <div className={`${styles.row} ${styles.total}`}>
          <span className={styles.dot} style={{ background: '#8b949e' }} />
          <span className={styles.label}>Total</span>
          <span className={styles.value}>{fmt(u.totalTokens)}</span>
          <span className={styles.percent}>(100%)</span>
        </div>
      </div>

      {u.conversationId && (
        <div className={styles.convId}>
          ID: <code>{u.conversationId.slice(0, 16)}…</code>
        </div>
      )}
    </div>
  )
}
