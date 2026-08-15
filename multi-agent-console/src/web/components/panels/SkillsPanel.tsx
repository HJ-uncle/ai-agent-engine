/**
 * SkillsPanel — 技能管理侧栏面板
 *
 * 上：技能列表（实时来自 SkillsRegistry，导入落盘后热重载自动出现）
 * 下：压缩包导入（复用 SkillImportPanel，成功后自动刷新列表）
 */

import React, { useCallback, useEffect, useState } from 'react'
import { Tooltip, Collapse } from 'antd'
import { ReloadOutlined, ExperimentOutlined, UploadOutlined, KeyOutlined } from '@ant-design/icons'
import { workspaceApi } from '@core/api'
import { useSessionStore } from '@core/store/session'
import SkillImportPanel from '../settings/SkillImportPanel'

interface SkillItem {
  name: string
  description: string
  enabled: boolean
  order: number
}

export function SkillsPanel() {
  const [skills, setSkills] = useState<SkillItem[]>([])
  const [root, setRoot] = useState('')
  const [loading, setLoading] = useState(false)
  const [authError, setAuthError] = useState(false)
  const openSettings = useSessionStore((s) => s.openSettings)

  const fetchData = useCallback(async () => {
    setLoading(true)
    setAuthError(false)
    try {
      const data = await workspaceApi.skillsList()
      if (data) {
        setSkills(data.list)
        setRoot(data.root)
      }
    } catch (err: any) {
      // 41015：服务器开启鉴权且本机无有效凭据
      if (err?.message && (err.message.includes('需要登录') || err.message.includes('权限不足'))) {
        setAuthError(true)
      }
    } finally { setLoading(false) }
  }, [])

  useEffect(() => { fetchData() }, [fetchData])

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden', background: '#1a1a1a' }}>
      {/* 头部 */}
      <div style={{ padding: '10px 14px 8px', flexShrink: 0, borderBottom: '1px solid #242424', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.08em', color: '#666', textTransform: 'uppercase' }}>技能管理</span>
          {skills.length > 0 && (
            <span style={{ fontSize: 10, color: '#555', background: 'rgba(255,255,255,0.06)', padding: '1px 7px', borderRadius: 10 }}>{skills.length}</span>
          )}
        </div>
        <Tooltip title="刷新">
          <div
            onClick={fetchData}
            style={{ width: 24, height: 24, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 4, cursor: 'pointer', color: '#555', fontSize: 13 }}
            onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.08)'; e.currentTarget.style.color = '#ccc' }}
            onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = '#555' }}
          ><ReloadOutlined spin={loading} /></div>
        </Tooltip>
      </div>

      {/* 技能列表 */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '6px 8px' }}>
        {authError ? (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 10, color: '#8b949e', padding: '0 16px', textAlign: 'center' }}>
            <KeyOutlined style={{ fontSize: 26, color: '#d29922' }} />
            <div style={{ fontSize: 12, lineHeight: 1.6 }}>
              服务器已开启鉴权（AUTH_ENABLED=true），管理类操作需要访问凭据
            </div>
            <a
              style={{ fontSize: 12 }}
              onClick={() => openSettings('general')}
            >
              前往 设置 → 通用 → 访问凭据 填入 Access Key
            </a>
          </div>
        ) : loading && skills.length === 0 ? (
          <div style={{ display: 'flex', justifyContent: 'center', padding: '32px 0' }}>
            <ReloadOutlined spin style={{ color: '#333', fontSize: 18 }} />
          </div>
        ) : skills.length === 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 8, color: '#555' }}>
            <ExperimentOutlined style={{ fontSize: 28, opacity: 0.4 }} />
            <div style={{ fontSize: 12 }}>暂无技能，可在下方导入压缩包</div>
          </div>
        ) : skills.map((s) => (
          <div
            key={s.name}
            style={{
              marginBottom: 3, borderRadius: 6, overflow: 'hidden',
              border: '1px solid #242424', background: 'rgba(255,255,255,0.02)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px' }}>
              <div
                style={{
                  width: 6, height: 6, borderRadius: '50%', flexShrink: 0,
                  background: s.enabled ? '#c084fc' : '#555',
                }}
                title={s.enabled ? '已启用' : '已禁用'}
              />
              <span
                title={s.name}
                style={{ fontSize: 12, fontWeight: 600, color: s.enabled ? '#d4d4d4' : '#666', fontFamily: 'Consolas,monospace', flexShrink: 0, maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
              >
                {s.name}
              </span>
              {!s.enabled && (
                <span style={{ fontSize: 10, color: '#666', background: 'rgba(255,255,255,0.05)', padding: '1px 6px', borderRadius: 4, flexShrink: 0 }}>禁用</span>
              )}
            </div>
            {s.description && (
              <div style={{ padding: '0 10px 8px 24px', fontSize: 11, color: '#6e7681', lineHeight: 1.5, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                {s.description}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* 导入区（可折叠） */}
      <div style={{ flexShrink: 0, borderTop: '1px solid #242424' }}>
        <Collapse
          ghost
          size="small"
          expandIcon={({ isActive }) => <UploadOutlined rotate={isActive ? 180 : 0} style={{ color: '#888', fontSize: 12 }} />}
          items={[{
            key: 'import',
            label: <span style={{ fontSize: 12, color: '#aaa' }}>导入压缩包</span>,
            children: <SkillImportPanel onImported={fetchData} />,
          }]}
        />
        {root && (
          <div style={{ padding: '2px 12px 8px', fontSize: 10, color: '#4a4a4a', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={root}>
            📁 {root}
          </div>
        )}
      </div>
    </div>
  )
}

export default SkillsPanel
