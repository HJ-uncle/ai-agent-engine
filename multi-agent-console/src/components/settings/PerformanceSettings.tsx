import React, { useEffect, useState, useCallback } from 'react'
import { App, Button, InputNumber, Progress, Space, Statistic, Table, Tag, Typography } from 'antd'
import { ReloadOutlined, ThunderboltOutlined } from '@ant-design/icons'
import { performanceApi, type PerformanceStats, settingsApi } from '../../api'
import { useSettings } from './useSettings'
import styles from './SettingsLayout.module.css'

const { Title, Text } = Typography

export default function PerformanceSettings() {
  const { message } = App.useApp()
  const { settings, handleChange, saveKeys, saving } = useSettings()
  const [stats, setStats] = useState<PerformanceStats | null>(null)
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setStats(await performanceApi.getStats())
    } catch (e: any) {
      message.error(`加载失败: ${e.message}`)
    } finally {
      setLoading(false)
    }
  }, [message])

  useEffect(() => {
    load()
    const t = setInterval(load, 5000)
    return () => clearInterval(t)
  }, [load])

  const applyPool = async () => {
    const limit = Number(settings.TOOL_CONCURRENCY_LIMIT ?? 8)
    try {
      await performanceApi.setToolPoolLimit(limit)
      await settingsApi.update({ TOOL_CONCURRENCY_LIMIT: limit })
      message.success(`并发上限已切换为 ${limit}（热生效 + 持久化）`)
      load()
    } catch (e: any) {
      message.error(`应用失败: ${e.message}`)
    }
  }

  const KEYS = ['TOOL_CONCURRENCY_LIMIT', 'SQLITE_CACHE_KB', 'SQLITE_MMAP_BYTES', 'SQLITE_BUSY_TIMEOUT_MS']

  return (
    <div className={styles.settingsContainer}>
      <Title level={4} className={styles.sectionTitle}>性能</Title>
      <Text type="secondary" className={styles.sectionDescription}>
        SQLite WAL + 缓存优化可让响应速度提升 30-50%；工具并发池防止高并发压垮服务。
      </Text>

      {/* ── 运行时指标 ──────────────────────────────────────────────── */}
      <div className={styles.section}>
        <div className={styles.sectionTitle}>运行时指标</div>
        <div className={styles.card} style={{ padding: 16, display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16 }}>
          <Statistic title="工具池容量" value={stats?.toolPool.size ?? 0} />
          <Statistic title="并发中" value={stats?.toolPool.active ?? 0} styles={{ content: { color: (stats?.toolPool.active ?? 0) > 0 ? '#52c41a' : undefined } }} />
          <Statistic title="排队" value={stats?.toolPool.pending ?? 0} styles={{ content: { color: (stats?.toolPool.pending ?? 0) > 0 ? '#faad14' : undefined } }} />
          <div style={{ gridColumn: 'span 3' }}>
            <Progress
              percent={Math.min(100, Math.round(((stats?.toolPool.active ?? 0) / Math.max(1, stats?.toolPool.size ?? 1)) * 100))}
              showInfo={false}
            />
          </div>
        </div>
      </div>

      {/* ── SQLite pragma ───────────────────────────────────────────── */}
      <div className={styles.section}>
        <div className={styles.sectionTitle}>SQLite 运行参数（只读）</div>
        <div className={styles.card} style={{ padding: 16 }}>
          <Space wrap>
            {stats && Object.entries(stats.sqlite).map(([k, v]) => (
              <Tag key={k} style={{ fontSize: 12 }}>{k}: {String(v)}</Tag>
            ))}
          </Space>
          <div style={{ marginTop: 12 }}>
            <Button icon={<ReloadOutlined />} size="small" onClick={load} loading={loading}>刷新</Button>
          </div>
        </div>
      </div>

      {/* ── 可调参数 ─────────────────────────────────────────────────── */}
      <div className={styles.section}>
        <div className={styles.sectionTitle}>可调参数</div>
        <div className={styles.card} style={{ padding: 16 }}>
          <div className={styles.settingItem}>
            <div className={styles.itemInfo}>
              <div className={styles.itemTitle}>工具并发上限 (TOOL_CONCURRENCY_LIMIT)</div>
              <div className={styles.itemDescription}>所有 Tool.execute 共享的全局并发池，1-64 之间。数值越大 QPS 越高，但消耗更多资源。</div>
            </div>
            <div className={styles.itemControls}>
              <Space>
                <InputNumber min={1} max={64}
                  value={Number(settings.TOOL_CONCURRENCY_LIMIT ?? 8)}
                  onChange={(v) => handleChange('TOOL_CONCURRENCY_LIMIT', v)} />
                <Button type="primary" icon={<ThunderboltOutlined />} onClick={applyPool}>立即应用</Button>
              </Space>
            </div>
          </div>

          <div className={styles.settingItem}>
            <div className={styles.itemInfo}>
              <div className={styles.itemTitle}>SQLite Cache (KB, SQLITE_CACHE_KB)</div>
              <div className={styles.itemDescription}>建议 20000 (20MB)。重启后生效。</div>
            </div>
            <div className={styles.itemControls}>
              <InputNumber min={2048} max={2097152} step={1024}
                value={Number(settings.SQLITE_CACHE_KB ?? 20000)}
                onChange={(v) => handleChange('SQLITE_CACHE_KB', v)} />
            </div>
          </div>

          <div className={styles.settingItem}>
            <div className={styles.itemInfo}>
              <div className={styles.itemTitle}>mmap 大小 (字节, SQLITE_MMAP_BYTES)</div>
              <div className={styles.itemDescription}>内存映射 I/O 上限，默认 256MB。0 = 关闭。重启后生效。</div>
            </div>
            <div className={styles.itemControls}>
              <InputNumber min={0} max={4294967296} step={64 * 1024 * 1024}
                value={Number(settings.SQLITE_MMAP_BYTES ?? 268435456)}
                onChange={(v) => handleChange('SQLITE_MMAP_BYTES', v)} />
            </div>
          </div>

          <div className={styles.settingItem}>
            <div className={styles.itemInfo}>
              <div className={styles.itemTitle}>Busy Timeout (ms, SQLITE_BUSY_TIMEOUT_MS)</div>
              <div className={styles.itemDescription}>锁冲突等待时间。重启后生效。</div>
            </div>
            <div className={styles.itemControls}>
              <InputNumber min={1000} max={60000} step={500}
                value={Number(settings.SQLITE_BUSY_TIMEOUT_MS ?? 5000)}
                onChange={(v) => handleChange('SQLITE_BUSY_TIMEOUT_MS', v)} />
            </div>
          </div>

          <div style={{ textAlign: 'right', paddingTop: 12 }}>
            <Button type="primary" loading={saving} onClick={() => saveKeys(KEYS, '性能参数已保存（SQLite 项重启后生效）')}>
              保存所有参数
            </Button>
          </div>
        </div>
      </div>

      {/* ── 工具统计 ────────────────────────────────────────────────── */}
      <div className={styles.section}>
        <div className={styles.sectionTitle}>最近 24h 工具调用统计</div>
        <div className={styles.card} style={{ padding: 16 }}>
          <Table
            rowKey="tool"
            size="small"
            pagination={{ pageSize: 10, size: 'small' }}
            dataSource={stats?.toolStats ?? []}
            columns={[
              { title: '工具', dataIndex: 'tool', key: 'tool' },
              { title: '调用次数', dataIndex: 'count', key: 'count', width: 120, sorter: (a: any, b: any) => a.count - b.count },
              {
                title: '平均耗时 (ms)', dataIndex: 'avgMs', key: 'avgMs', width: 160,
                sorter: (a: any, b: any) => a.avgMs - b.avgMs,
              },
              {
                title: '成功率', dataIndex: 'successRate', key: 'successRate', width: 120,
                render: (v: number) => (
                  <span style={{ color: v >= 0.95 ? '#52c41a' : v >= 0.8 ? '#faad14' : '#f5222d' }}>
                    {Math.round(v * 100)}%
                  </span>
                ),
              },
            ]}
          />
        </div>
      </div>
    </div>
  )
}
