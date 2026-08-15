/**
 * SkillsPanel — 技能管理侧栏面板
 *
 * 上：技能列表（实时来自 SkillsRegistry，导入落盘后热重载自动出现）
 * 下：压缩包导入（复用 SkillImportPanel，成功后自动刷新列表）
 */

import React, { useCallback, useEffect, useState } from 'react'
import { Tooltip, Collapse, Modal, Tag, Popconfirm, message } from 'antd'
import { ReloadOutlined, ExperimentOutlined, UploadOutlined, KeyOutlined, FileTextOutlined, FolderOpenOutlined, DeleteOutlined } from '@ant-design/icons'
import { workspaceApi } from '@core/api'
import { useSessionStore } from '@core/store/session'
import SkillImportPanel from '../settings/SkillImportPanel'

interface SkillItem {
  name: string
  description: string
  enabled: boolean
  order: number
  scope: 'project' | 'global'
}

interface SkillDetail extends SkillItem {
  dir: string
  content: string | null
  files: { path: string; size: number }[]
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export function SkillsPanel() {
  const [skills, setSkills] = useState<SkillItem[]>([])
  const [root, setRoot] = useState('')
  const [globalRoot, setGlobalRoot] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [authError, setAuthError] = useState(false)
  const [detail, setDetail] = useState<SkillDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const openSettings = useSessionStore((s) => s.openSettings)

  const openDetail = useCallback(async (name: string) => {
    setDetailLoading(true)
    setDetail(null)
    try {
      const data = await workspaceApi.skillDetail(name)
      if (data) setDetail(data)
    } catch { /* 详情拉取失败静默（列表仍可用） */ } finally { setDetailLoading(false) }
  }, [])

  const fetchData = useCallback(async (reload = false) => {
    setLoading(true)
    setAuthError(false)
    try {
      const data = await workspaceApi.skillsList({ reload })
      if (data) {
        setSkills(data.list)
        setRoot(data.root)
        setGlobalRoot(data.globalRoot)
      }
    } catch (err: any) {
      // 41015：服务器开启鉴权且本机无有效凭据
      if (err?.message && (err.message.includes('需要登录') || err.message.includes('权限不足'))) {
        setAuthError(true)
      }
    } finally { setLoading(false) }
  }, [])

  useEffect(() => { fetchData() }, [fetchData])

  const handleDelete = useCallback(async (s: SkillItem) => {
    try {
      const msg = await workspaceApi.skillDelete(s.name)
      message.success(msg || `技能 "${s.name}" 已删除`)
      if (detail?.name === s.name) setDetail(null)
      fetchData()
    } catch (err: any) {
      message.error(err?.message || '删除失败')
    }
  }, [detail, fetchData])

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
        <Tooltip title="刷新（强制重扫磁盘）">
          <div
            onClick={() => fetchData(true)}
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
            onClick={() => openDetail(s.name)}
            style={{
              marginBottom: 3, borderRadius: 6, overflow: 'hidden',
              border: '1px solid #242424', background: 'rgba(255,255,255,0.02)',
              cursor: 'pointer',
            }}
            onMouseEnter={e => { e.currentTarget.style.borderColor = '#3d3d3d'; e.currentTarget.style.background = 'rgba(255,255,255,0.045)' }}
            onMouseLeave={e => { e.currentTarget.style.borderColor = '#242424'; e.currentTarget.style.background = 'rgba(255,255,255,0.02)' }}
            title={`点击查看 ${s.name} 详情`}
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
              {s.scope === 'global' && (
                <Tooltip title={`全局技能（${globalRoot ?? '~/.aether/skills'}），对所有项目生效`}>
                  <span style={{ fontSize: 10, color: '#58a6ff', background: 'rgba(88,166,255,0.12)', padding: '1px 6px', borderRadius: 4, flexShrink: 0 }}>全局</span>
                </Tooltip>
              )}
              {!s.enabled && (
                <span style={{ fontSize: 10, color: '#666', background: 'rgba(255,255,255,0.05)', padding: '1px 6px', borderRadius: 4, flexShrink: 0 }}>禁用</span>
              )}
              <div style={{ flex: 1 }} />
              <Popconfirm
                title="删除技能"
                description={
                  <span style={{ fontSize: 12 }}>
                    将删除{s.scope === 'global' ? '全局层' : '项目层'}的 <b>{s.name}</b> 及其版本备份
                    {s.scope === 'global' ? '，影响所有项目' : ''}
                  </span>
                }
                okText="删除"
                okButtonProps={{ danger: true }}
                cancelText="取消"
                onConfirm={(e) => { e?.stopPropagation(); handleDelete(s) }}
                onCancel={(e) => e?.stopPropagation()}
              >
                <Tooltip title="删除">
                  <div
                    onClick={(e) => e.stopPropagation()}
                    style={{ width: 22, height: 22, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 4, cursor: 'pointer', color: '#555', fontSize: 12, flexShrink: 0 }}
                    onMouseEnter={e => { e.currentTarget.style.background = 'rgba(248,81,73,0.15)'; e.currentTarget.style.color = '#f85149' }}
                    onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = '#555' }}
                  ><DeleteOutlined /></div>
                </Tooltip>
              </Popconfirm>
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

      {/* 技能详情弹层 */}
      <Modal
        open={detailLoading || detail !== null}
        onCancel={() => { setDetail(null); setDetailLoading(false) }}
        footer={detail ? (
          <Popconfirm
            title="删除技能"
            description={`将删除${detail.scope === 'global' ? '全局层' : '项目层'}的 ${detail.name} 及其版本备份${detail.scope === 'global' ? '，影响所有项目' : ''}`}
            okText="删除"
            okButtonProps={{ danger: true }}
            cancelText="取消"
            onConfirm={() => handleDelete(detail)}
          >
            <button
              style={{ background: 'transparent', border: '1px solid rgba(248,81,73,0.5)', color: '#f85149', borderRadius: 6, padding: '4px 14px', fontSize: 12, cursor: 'pointer' }}
              onMouseEnter={e => { e.currentTarget.style.background = 'rgba(248,81,73,0.12)' }}
              onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
            >
              <DeleteOutlined style={{ marginRight: 5 }} />删除技能
            </button>
          </Popconfirm>
        ) : null}
        width={680}
        title={detail ? (
          <span style={{ fontFamily: 'Consolas,monospace' }}>
            {detail.name}
            <Tag style={{ marginLeft: 8 }} color={detail.scope === 'global' ? 'blue' : 'default'}>
              {detail.scope === 'global' ? '全局' : '项目级'}
            </Tag>
            {!detail.enabled && <Tag>禁用</Tag>}
          </span>
        ) : '技能详情'}
      >
        {!detail ? (
          <div style={{ display: 'flex', justifyContent: 'center', padding: '32px 0', color: '#888' }}>
            <ReloadOutlined spin style={{ fontSize: 16 }} />
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {/* 元信息 */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {detail.description && (
                <div style={{ fontSize: 12, color: '#aaa', lineHeight: 1.6 }}>{detail.description}</div>
              )}
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: '#666' }}>
                <FolderOpenOutlined />
                <span style={{ fontFamily: 'Consolas,monospace', wordBreak: 'break-all' }} title={detail.dir}>{detail.dir}</span>
              </div>
            </div>

            {/* SKILL.md 全文 */}
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, fontWeight: 600, color: '#888', marginBottom: 6 }}>
                <FileTextOutlined /> SKILL.md
              </div>
              <pre style={{
                margin: 0, padding: 12, maxHeight: '42vh', overflow: 'auto',
                background: 'rgba(0,0,0,0.45)', borderRadius: 8, border: '1px solid rgba(255,255,255,0.08)',
                fontSize: 11.5, lineHeight: 1.7, color: '#ccc', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                fontFamily: 'Consolas,monospace',
              }}>
                {detail.content ?? '（无内容）'}
              </pre>
            </div>

            {/* 附件清单 */}
            {detail.files.length > 1 && (
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, fontWeight: 600, color: '#888', marginBottom: 6 }}>
                  <FolderOpenOutlined /> 目录文件（{detail.files.length}）
                </div>
                <div style={{ maxHeight: 140, overflowY: 'auto', borderRadius: 8, border: '1px solid rgba(255,255,255,0.08)' }}>
                  {detail.files.map((f) => (
                    <div key={f.path} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '4px 10px', fontSize: 11, fontFamily: 'Consolas,monospace', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                      <span style={{ color: '#999', wordBreak: 'break-all' }}>{f.path}</span>
                      <span style={{ color: '#555', flexShrink: 0 }}>{formatSize(f.size)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </Modal>
    </div>
  )
}

export default SkillsPanel
