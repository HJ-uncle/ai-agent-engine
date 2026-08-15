/**
 * Skill 压缩包导入面板
 *
 * 三态流：上传（直传/分片，实时进度）→ 后端处理（轮询 stage）→ 结果
 * 成功/失败/取消均给出后续操作；失败保留会话支持断点续传重试。
 */

import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Upload, Button, Progress, Alert, Tag, Radio, Space, Tabs, Input, Checkbox, message } from 'antd'
import { InboxOutlined, ReloadOutlined, CheckCircleOutlined, FormOutlined } from '@ant-design/icons'
import type { UploadFile } from 'antd'
import { workspaceApi } from '../../../core/api/index'

const MAX_MB = 20

const ERROR_TEXT: Record<string, string> = {
  '41010': '压缩包格式非法（仅支持 .zip，且文件未损坏）',
  '41011': '压缩包超出大小限制',
  '41012': '包结构校验失败：请确认每个技能目录包含带 name/description 的 SKILL.md，且文件类型在白名单内',
  '41013': '存在同名技能且策略为拒绝冲突：可改用「版本化覆盖」后重试',
  '41014': '分片不完整：请点击「续传重试」补传缺失分片',
  '41015': '权限不足：需要 admin 或 skill-manager 角色',
  '50010': '服务内部错误，请查看服务端日志',
}

type Phase = 'idle' | 'uploading' | 'processing' | 'done' | 'failed'

interface ImportStatus {
  status: string
  progress: number
  stage: string | null
  skillNames: string[]
  errorCode: string | null
  errorMessage: string | null
}

export default function SkillImportPanel({ onImported }: { onImported?: () => void } = {}) {
  const [phase, setPhase] = useState<Phase>('idle')
  const [file, setFile] = useState<File | null>(null)
  const [strategy, setStrategy] = useState('versioned')
  const [scope, setScope] = useState<'project' | 'global'>('project')
  const [percent, setPercent] = useState(0)
  const [stageText, setStageText] = useState('')
  const [result, setResult] = useState<ImportStatus | null>(null)
  const [error, setError] = useState<{ code: string | null; msg: string } | null>(null)
  // 手动创建表单
  const [mName, setMName] = useState('')
  const [mDesc, setMDesc] = useState('')
  const [mContent, setMContent] = useState('')
  const [mCreating, setMCreating] = useState(false)
  const [mOverwrite, setMOverwrite] = useState(false)
  const [mConflict, setMConflict] = useState(false)
  const importIdRef = useRef<string | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const cancelledRef = useRef(false)

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
  }, [])

  useEffect(() => stopPolling, [stopPolling])

  const startPolling = useCallback((importId: string) => {
    stopPolling()
    pollRef.current = setInterval(async () => {
      try {
        const st = await workspaceApi.skillImportStatus(importId)
        if (!st) return
        setPercent(Math.max(50, st.progress))
        setStageText(st.stage ?? '')
        if (st.status === 'imported') {
          stopPolling()
          setResult(st)
          setPhase('done')
          setPercent(100)
          onImported?.()
        } else if (st.status === 'failed' || st.status === 'cancelled') {
          stopPolling()
          setError({ code: st.errorCode, msg: st.errorMessage ?? `导入已${st.status === 'cancelled' ? '取消' : '失败'}` })
          setPhase('failed')
        }
      } catch {
        /* 轮询瞬断忽略，下轮重试 */
      }
    }, 1000)
  }, [stopPolling, onImported])

  const beginImport = useCallback(async (resumeFile: File, resumeImportId: string | null) => {
    setPhase('uploading')
    setPercent(2)
    setError(null)
    setResult(null)
    cancelledRef.current = false
    try {
      const importId = await workspaceApi.skillImportUpload(resumeFile, {
        strategy,
        scope,
        resumeImportId,
        onProgress: (p, stage) => {
          setPercent(Math.min(p, 60))
          setStageText(stage)
        },
      })
      importIdRef.current = importId
      setPhase('processing')
      setStageText('服务端处理中')
      startPolling(importId)
    } catch (e) {
      if (cancelledRef.current) {
        setPhase('idle')
        setPercent(0)
        return
      }
      setError({ code: null, msg: (e as Error).message ?? '上传失败' })
      setPhase('failed')
    }
  }, [strategy, scope, startPolling])

  const onFileSelected = useCallback((f: File | null) => {
    if (!f) return
    if (!f.name.toLowerCase().endsWith('.zip')) {
      message.error('仅支持 .zip 压缩包')
      return
    }
    if (f.size > MAX_MB * 1024 * 1024) {
      message.error(`压缩包不能超过 ${MAX_MB}MB`)
      return
    }
    setFile(f)
  }, [])

  const onCancel = useCallback(async () => {
    cancelledRef.current = true
    stopPolling()
    const id = importIdRef.current
    if (id) {
      await workspaceApi.skillImportCancel(id).catch(() => undefined)
      importIdRef.current = null
    }
    setPhase('idle')
    setPercent(0)
    setStageText('')
  }, [stopPolling])

  const reset = useCallback(() => {
    stopPolling()
    importIdRef.current = null
    setPhase('idle')
    setFile(null)
    setPercent(0)
    setStageText('')
    setError(null)
    setResult(null)
  }, [stopPolling])

  // ── 手动创建 ────────────────────────────────────────────────────────────────
  const submitCreate = useCallback(async (overwrite: boolean) => {
    const name = mName.trim()
    if (!/^[a-z0-9][a-z0-9-_]*$/.test(name)) {
      message.error('技能名必须是小写字母、数字、连字符或下划线，且以字母或数字开头')
      return
    }
    if (!mDesc.trim()) { message.error('请填写技能描述'); return }
    if (!mContent.trim()) { message.error('请填写 SKILL.md 正文'); return }

    setMCreating(true)
    try {
      const { message: msg } = await workspaceApi.skillCreate({
        name,
        description: mDesc.trim(),
        content: mContent,
        scope,
        overwrite,
      })
      message.success(msg || `技能 "${name}" 创建成功`)
      setMName(''); setMDesc(''); setMContent(''); setMConflict(false); setMOverwrite(false)
      onImported?.()
    } catch (e: any) {
      const msg = e?.message ?? '创建失败'
      if (msg.includes('已存在')) {
        setMConflict(true)
        message.warning(msg)
      } else {
        message.error(msg)
      }
    } finally {
      setMCreating(false)
    }
  }, [mName, mDesc, mContent, scope, onImported])

  const uploadProps = {
    multiple: false,
    maxCount: 1,
    accept: '.zip',
    showUploadList: false,
    beforeUpload: (f: File) => {
      onFileSelected(f)
      return false // 阻止 antd 自动上传
    },
    onRemove: () => setFile(null),
  }

  return (
    <div data-testid="skill-import-panel">
      <Tabs
        defaultActiveKey="upload"
        size="small"
        items={[
          {
            key: 'upload',
            label: <span style={{ fontSize: 12 }}>上传压缩包</span>,
            children: (
              <>
                {phase === 'idle' && (
        <Space direction="vertical" style={{ width: '100%' }} size="middle">
          <Upload.Dragger {...uploadProps} data-testid="skill-import-dropzone">
            <p className="ant-upload-drag-icon"><InboxOutlined /></p>
            <p className="ant-upload-text">点击或拖拽 .zip 压缩包到此处</p>
            <p className="ant-upload-hint">
              单个压缩包 ≤ {MAX_MB}MB；≤5MB 直传，超过自动分片（支持断点续传）。
              包内每个技能目录需包含 SKILL.md（frontmatter 带 name/description）
            </p>
          </Upload.Dragger>
          {file && (
            <Space wrap>
              <Tag color="blue">{file.name}</Tag>
              <Tag>{(file.size / 1024).toFixed(1)} KB</Tag>
              <span style={{ color: '#999', fontSize: 12 }}>导入层级：</span>
              <Radio.Group value={scope} onChange={(e) => setScope(e.target.value)} size="small">
                <Radio.Button value="project">项目级</Radio.Button>
                <Radio.Button value="global">全局级</Radio.Button>
              </Radio.Group>
              <span style={{ color: '#999', fontSize: 12 }}>冲突策略：</span>
              <Radio.Group value={strategy} onChange={(e) => setStrategy(e.target.value)} size="small">
                <Radio.Button value="versioned">版本化备份</Radio.Button>
                <Radio.Button value="overwrite">直接覆盖</Radio.Button>
                <Radio.Button value="reject">拒绝冲突</Radio.Button>
              </Radio.Group>
              <Button type="primary" onClick={() => beginImport(file, null)} data-testid="skill-import-start">
                开始导入
              </Button>
            </Space>
          )}
        </Space>
      )}

      {(phase === 'uploading' || phase === 'processing') && (
        <Space direction="vertical" style={{ width: '100%' }} size="small">
          <Progress percent={percent} status="active" data-testid="skill-import-progress" />
          <div style={{ color: '#aaa', fontSize: 12 }}>
            {file?.name} — {stageText || '处理中'}…
          </div>
          <Button size="small" danger onClick={onCancel}>
            取消导入
          </Button>
        </Space>
      )}

      {phase === 'done' && result && (
        <Space direction="vertical" style={{ width: '100%' }} size="small">
          <Alert
            type="success"
            showIcon
            icon={<CheckCircleOutlined />}
            message={`成功导入 ${result.skillNames.length} 个技能`}
            description={
              <Space wrap>
                {result.skillNames.map((n) => <Tag key={n} color="green">{n}</Tag>)}
              </Space>
            }
          />
          <div style={{ color: '#999', fontSize: 12 }}>
            技能已通过热重载即时生效，可在对话中直接使用；无需重启服务。
          </div>
          <Button icon={<ReloadOutlined />} onClick={reset}>继续导入</Button>
        </Space>
      )}

      {phase === 'failed' && (
        <Space direction="vertical" style={{ width: '100%' }} size="small">
          <Alert
            type="error"
            showIcon
            message="导入失败"
            description={
              <>
                <div>{error?.code ? `${ERROR_TEXT[error.code] ?? '导入失败'}（错误码 ${error.code}）` : (error?.msg ?? '未知错误')}</div>
                {error?.msg && error.code && <div style={{ color: '#888', fontSize: 12 }}>详情：{error.msg}</div>}
              </>
            }
          />
          <Space>
            <Button
              type="primary"
              icon={<ReloadOutlined />}
              disabled={!file}
              onClick={() => file && beginImport(file, importIdRef.current)}
            >
              续传重试
            </Button>
            <Button onClick={reset}>重新选择文件</Button>
          </Space>
        </Space>
      )}
              </>
            ),
          },
          {
            key: 'manual',
            label: <span style={{ fontSize: 12 }}><FormOutlined style={{ marginRight: 4 }} />手动创建</span>,
            children: (
              <Space direction="vertical" style={{ width: '100%' }} size="small">
                <Input
                  value={mName}
                  onChange={(e) => { setMName(e.target.value); setMConflict(false) }}
                  placeholder="技能名，如 my-skill（小写字母/数字/-/_）"
                  style={{ fontFamily: 'Consolas,monospace' }}
                  data-testid="skill-create-name"
                />
                <Input
                  value={mDesc}
                  onChange={(e) => setMDesc(e.target.value)}
                  placeholder="一句话描述（供 Agent 检索匹配技能）"
                  data-testid="skill-create-desc"
                />
                <Input.TextArea
                  value={mContent}
                  onChange={(e) => setMContent(e.target.value)}
                  rows={8}
                  placeholder={'SKILL.md 正文（Markdown），例如：\n\n## 使用场景\n…\n\n## 执行步骤\n1. …\n\n## 约束\n- …'}
                  style={{ fontFamily: 'Consolas,monospace', fontSize: 12 }}
                  data-testid="skill-create-content"
                />
                <Space wrap>
                  <span style={{ color: '#999', fontSize: 12 }}>保存层级：</span>
                  <Radio.Group value={scope} onChange={(e) => setScope(e.target.value)} size="small">
                    <Radio.Button value="project">项目级</Radio.Button>
                    <Radio.Button value="global">全局级</Radio.Button>
                  </Radio.Group>
                  <Button
                    type="primary"
                    loading={mCreating}
                    onClick={() => submitCreate(mConflict && mOverwrite)}
                    data-testid="skill-create-submit"
                  >
                    创建技能
                  </Button>
                </Space>
                {mConflict && (
                  <Alert
                    type="warning"
                    showIcon
                    message={`技能 "${mName.trim()}" 已存在于${scope === 'global' ? '全局层' : '项目层'}`}
                    description={
                      <Checkbox
                        checked={mOverwrite}
                        onChange={(e) => setMOverwrite(e.target.checked)}
                        style={{ fontSize: 12 }}
                      >
                        覆盖已有版本（旧版本自动备份到 .versions/）
                      </Checkbox>
                    }
                  />
                )}
                <div style={{ color: '#888', fontSize: 11, lineHeight: 1.6 }}>
                  系统自动生成 frontmatter（name/description）与正文合并为 SKILL.md，落盘即热重载生效。
                </div>
              </Space>
            ),
          },
        ]}
      />
    </div>
  )
}
