/**
 * Skill 压缩包导入面板
 *
 * 三态流：上传（直传/分片，实时进度）→ 后端处理（轮询 stage）→ 结果
 * 成功/失败/取消均给出后续操作；失败保留会话支持断点续传重试。
 */

import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Upload, Button, Progress, Alert, Tag, Radio, Space, message } from 'antd'
import { InboxOutlined, ReloadOutlined, CheckCircleOutlined } from '@ant-design/icons'
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
  const [percent, setPercent] = useState(0)
  const [stageText, setStageText] = useState('')
  const [result, setResult] = useState<ImportStatus | null>(null)
  const [error, setError] = useState<{ code: string | null; msg: string } | null>(null)
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
  }, [strategy, startPolling])

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
              <span style={{ color: '#999', fontSize: 12 }}>同名冲突策略：</span>
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
    </div>
  )
}
