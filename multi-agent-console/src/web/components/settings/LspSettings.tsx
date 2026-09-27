import React, { useEffect, useState, useCallback } from 'react'
import { App, Button, Input, Space, Table, Tag, Typography } from 'antd'
import { ReloadOutlined, ExperimentOutlined, DeleteOutlined } from '@ant-design/icons'
import { lspApi, type LspAdapterInfo, type LspDiagnoseResult } from '@core/api'
import styles from './SettingsLayout.module.css'

const { Title, Text } = Typography

const SEV_COLOR: Record<string, string> = { error: 'red', warning: 'orange', info: 'blue', hint: 'default' }

export default function LspSettings() {
  const { message } = App.useApp()
  const [adapters, setAdapters] = useState<LspAdapterInfo[]>([])
  const [loading, setLoading] = useState(false)
  const [testFile, setTestFile] = useState('src/main.ts')
  const [result, setResult] = useState<LspDiagnoseResult | null>(null)
  const [running, setRunning] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setAdapters(await lspApi.listAdapters())
    } catch (e: any) {
      message.error(`加载失败: ${e.message}`)
    } finally {
      setLoading(false)
    }
  }, [message])

  useEffect(() => { load() }, [load])

  const runDiagnose = async () => {
    if (!testFile) return
    setRunning(true)
    setResult(null)
    try {
      const r = await lspApi.diagnose({ filePath: testFile })
      setResult(r)
      message.success(`诊断完成，发现 ${r.diagnostics.length} 条问题`)
    } catch (e: any) {
      message.error(`诊断失败: ${e.message}`)
    } finally {
      setRunning(false)
    }
  }

  const purge = async () => {
    let days = 7
    try {
      const r = await lspApi.purgeCache(days)
      message.success(`已清理 ${r?.removed ?? 0} 条 LSP 缓存`)
    } catch (e: any) {
      message.error(`清理失败: ${e.message}`)
    }
  }

  return (
    <div className={styles.settingsContainer}>
      <div className={styles.section}>
        <Title level={4} className={styles.sectionTitle}>代码诊断 (LSP)</Title>
        <Text type="secondary" className={styles.sectionDescription}>
          AI 写入代码后可调用 <code>code_diagnose</code> 工具自动检查类型错误、lint 问题，并根据结果自我修复。
        </Text>

        <div className={styles.card} style={{ padding: 16 }}>
          <div style={{ marginBottom: 12, fontWeight: 500 }}>已注册适配器</div>
          <Table<LspAdapterInfo>
            rowKey="name"
            size="small"
            pagination={false}
            loading={loading}
            columns={[
              { title: '适配器', dataIndex: 'name', key: 'name', width: 140 },
              { title: '语言', dataIndex: 'language', key: 'language', width: 140 },
              {
                title: '支持扩展名', dataIndex: 'extensions', key: 'extensions',
                render: (v: string[]) => v.map((x) => <Tag key={x}>{x}</Tag>),
              },
              {
                title: '可用性', dataIndex: 'available', key: 'available', width: 100,
                render: (v: boolean) => v
                  ? <Tag color="green">可用</Tag>
                  : <Tag color="default">未安装</Tag>,
              },
            ]}
            dataSource={adapters}
          />
          <div style={{ marginTop: 12 }}>
            <Button icon={<ReloadOutlined />} size="small" onClick={load}>刷新</Button>
            <Button icon={<DeleteOutlined />} size="small" style={{ marginLeft: 8 }} onClick={purge}>清理诊断缓存</Button>
          </div>
        </div>
      </div>

      <div className={styles.section}>
        <Title level={5} className={styles.sectionSubtitle}>快速测试</Title>
        <div className={styles.card} style={{ padding: 16 }}>
          <Space.Compact style={{ width: '100%', maxWidth: 520, marginBottom: 12 }}>
            <Input value={testFile} onChange={(e) => setTestFile(e.target.value)}
                   placeholder="相对项目根或绝对路径的文件" />
            <Button type="primary" icon={<ExperimentOutlined />} loading={running} onClick={runDiagnose}>
              运行诊断
            </Button>
          </Space.Compact>

          {result && (
            <>
              <div style={{ marginBottom: 8, color: '#888', fontSize: 12 }}>
                语言: <Tag>{result.language}</Tag>
                适配器: <Tag>{result.adapter}</Tag>
                耗时: <Tag>{result.durationMs}ms</Tag>
                缓存: {result.fromCache ? <Tag color="green">命中</Tag> : <Tag>未命中</Tag>}
                问题数: <Tag color={result.diagnostics.length ? 'red' : 'green'}>{result.diagnostics.length}</Tag>
              </div>
              <Table
                rowKey={(r: any) => `${r.line}-${r.column}-${r.code ?? 'x'}-${r.source}-${r.message.slice(0, 20)}`}
                size="small"
                pagination={{ pageSize: 10, size: 'small' }}
                columns={[
                  {
                    title: '级别', dataIndex: 'severity', key: 'severity', width: 80,
                    render: (v: string) => <Tag color={SEV_COLOR[v]}>{v}</Tag>,
                  },
                  { title: '位置', key: 'pos', width: 80, render: (_: any, r: any) => `${r.line}:${r.column}` },
                  { title: '代码', dataIndex: 'code', key: 'code', width: 100 },
                  { title: '来源', dataIndex: 'source', key: 'source', width: 100 },
                  { title: '说明', dataIndex: 'message', key: 'message', ellipsis: true },
                ]}
                dataSource={result.diagnostics}
              />
            </>
          )}
        </div>
      </div>
    </div>
  )
}
