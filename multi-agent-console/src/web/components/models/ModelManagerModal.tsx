import React, { useState, useEffect, useCallback } from 'react'
import { Modal, Form, Input, Button, Radio, Typography, message, Row, Col, Switch, Tooltip, Tag, Divider, Select } from 'antd'
import { ThunderboltOutlined } from '@ant-design/icons'
import { useForm, Controller } from 'react-hook-form'
import { yupResolver } from '@hookform/resolvers/yup'
import * as yup from 'yup'
import { useTranslation } from 'react-i18next'
import { modelsApi, type ModelCapabilities, type CapabilityDef } from '@core/api'
import '@core/i18n' // Ensure i18n is initialized

const { Title, Text, Paragraph } = Typography

interface ModelManagerModalProps {
  open: boolean
  onClose: () => void
  onSuccess: () => void
  editModel?: {
    id: string
    provider: 'openai' | 'anthropic' | 'custom'
    modelId: string
    displayName?: string
    baseUrl?: string
    capabilities?: ModelCapabilities | null
  } | null
}

interface FormData {
  provider: 'openai' | 'anthropic' | 'custom'
  modelId: string
  apiKey: string
  baseUrl: string
  displayName?: string
}

const GROUP_LABELS: Record<CapabilityDef['group'], string> = {
  multimodal: '多模态',
  reasoning: '推理',
  protocol: '协议',
  optimization: '优化',
}

export default function ModelManagerModal({ open, onClose, onSuccess, editModel }: ModelManagerModalProps) {
  const { t, i18n } = useTranslation()
  const [testing, setTesting] = useState(false)
  const [testOk, setTestOk] = useState(false)
  const [saving, setSaving] = useState(false)
  const [capDefs, setCapDefs] = useState<CapabilityDef[]>([])
  const [capabilities, setCapabilities] = useState<ModelCapabilities>({})
  const [autoDetected, setAutoDetected] = useState(false)
  const [detecting, setDetecting] = useState(false)
  const isEdit = !!editModel

  const schema = yup.object({
    provider: yup.mixed<'openai' | 'anthropic' | 'custom'>().oneOf(['openai', 'anthropic', 'custom']).required(),
    modelId: yup.string().required(t('modelIdRequired')),
    // 编辑模式下 apiKey 可为空（保留原有），新增时必须填写且至少 16 位
    apiKey: isEdit
      ? yup.string().optional().test('key-length', t('keyLengthError'), (val) => !val || val.length === 0 || val.length >= 16)
      : yup.string().min(16, t('keyLengthError')).required(),
    baseUrl: yup.string().url(t('urlFormatError')).matches(/^https?:\/\/.+/, t('urlFormatError')).required(),
    displayName: yup.string().optional(),
    authType: yup.string().optional()
  })

  const { control, handleSubmit, watch, reset, setValue, trigger } = useForm<FormData & { authType?: string }>({
    resolver: yupResolver(schema) as any,
    defaultValues: {
      provider: 'openai',
      modelId: '',
      apiKey: '',
      baseUrl: 'https://api.openai.com/v1',
      displayName: '',
      authType: 'apiKey'
    },
    mode: 'onChange'
  })

  const watchedValues = watch()

  // 加载能力元数据（一次）
  useEffect(() => {
    if (open && capDefs.length === 0) {
      modelsApi.getCapabilityDefs().then(setCapDefs).catch(() => setCapDefs([]))
    }
  }, [open, capDefs.length])

  useEffect(() => {
    setTestOk(false)
  }, [watchedValues.provider, watchedValues.modelId, watchedValues.apiKey, watchedValues.baseUrl])

  useEffect(() => {
    if (open) {
      if (editModel) {
        // 编辑模式：回填已有数据，apiKey 留空让用户重新输入
        reset({
          provider: editModel.provider,
          modelId: editModel.modelId,
          displayName: editModel.displayName || editModel.modelId,
          baseUrl: editModel.baseUrl || '',
          apiKey: '',
        })
        setCapabilities(editModel.capabilities ?? {})
        setAutoDetected(false)
        setTestOk(false)
      } else {
        reset()
        setCapabilities({})
        setAutoDetected(false)
        setTestOk(false)
      }
    }
  }, [open, editModel, reset])

  const onProviderChange = (e: any) => {
    const provider = e.target.value
    setValue('provider', provider)
    if (provider === 'openai') {
      setValue('baseUrl', 'https://api.openai.com/v1')
    } else if (provider === 'anthropic') {
      setValue('baseUrl', 'https://api.anthropic.com/v1')
    } else {
      setValue('baseUrl', '')
    }
  }

  const handleAutoDetect = useCallback(async () => {
    const values = watch()
    if (!values.modelId) {
      message.warning('请先填写模型 ID')
      return
    }
    setDetecting(true)
    try {
      const detected = await modelsApi.detectCapabilities({
        provider: values.provider,
        modelId: values.modelId,
        baseUrl: values.baseUrl,
      })
      setCapabilities(detected)
      setAutoDetected(true)
      const enabled = Object.entries(detected).filter(([_, v]) => v === true).length
      message.success(`已识别 ${enabled} 项能力`)
    } catch (err: any) {
      message.error('能力检测失败：' + err.message)
    } finally {
      setDetecting(false)
    }
  }, [watch])

  const handleCapToggle = (key: keyof ModelCapabilities, val: boolean) => {
    setCapabilities((prev) => ({ ...prev, [key]: val }))
    setAutoDetected(false) // 用户手动调整后取消"自动识别"标记
  }

  const handleTest = async () => {
    const isValid = await trigger(['provider', 'modelId', 'apiKey', 'baseUrl'])
    if (!isValid) return

    setTesting(true)
    try {
      const values = watch()
      // Send temporary test request using new route parameter
      const res = await modelsApi.testModel('new', {
        provider: values.provider,
        modelId: values.modelId,
        apiKey: values.apiKey,
        baseUrl: values.baseUrl
      })
      if (res?.success) {
        message.success(t('testSuccess') + (res.latency ? ` (${res.latency}ms)` : ''))
        setTestOk(true)
        // 测试成功后，如果用户还没配置能力，自动触发一次检测
        if (Object.keys(capabilities).length === 0) {
          handleAutoDetect()
        }
      } else {
        message.error(t('testFailed') + (res?.error ? `: ${res.error}` : ''))
        setTestOk(false)
      }
    } catch (err: any) {
      message.error(t('testFailed') + `: ${err.message}`)
      setTestOk(false)
    } finally {
      setTesting(false)
    }
  }

  const onSubmit = async (data: FormData) => {
    if (!testOk && !isEdit) {
      message.warning('请先通过连接测试')
      return
    }

    // 只持久化用户明确设置过的能力（true/false 都保留，undefined 跳过）
    const capsToSave: ModelCapabilities = {}
    for (const [k, v] of Object.entries(capabilities)) {
      if (typeof v === 'boolean') (capsToSave as any)[k] = v
    }

    setSaving(true)
    try {
      if (isEdit && editModel) {
        // 编辑模式：调 updateModel，apiKey 为空时不更新（保留原有）
        await modelsApi.updateModel(editModel.id, {
          provider: data.provider,
          modelId: data.modelId,
          apiKey: data.apiKey || undefined,  // 空则不更新
          baseUrl: data.baseUrl,
          displayName: data.displayName || data.modelId,
          capabilities: Object.keys(capsToSave).length > 0 ? capsToSave : null,
        })
        message.success('模型更新成功')
      } else {
        await modelsApi.createModel({
          provider: data.provider,
          modelId: data.modelId,
          apiKey: data.apiKey,
          baseUrl: data.baseUrl,
          displayName: data.displayName || data.modelId,
          isEnabled: false,
          capabilities: Object.keys(capsToSave).length > 0 ? capsToSave : undefined,
        })
        message.success(t('saveSuccess'))
      }
      onSuccess()
      onClose()
    } catch (err: any) {
      message.error(t('saveFailed') + `: ${err.message}`)
    } finally {
      setSaving(false)
    }
  }

  // 按 group 分组渲染能力开关
  const groupedDefs = capDefs.reduce<Record<string, CapabilityDef[]>>((acc, d) => {
    (acc[d.group] = acc[d.group] || []).push(d)
    return acc
  }, {})

  return (
    <Modal
      title={
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>{isEdit ? '编辑模型' : '添加模型'}</span>
          <Button size="small" onClick={() => i18n.changeLanguage(i18n.language === 'zh' ? 'en' : 'zh')}>
            {i18n.language === 'zh' ? 'EN' : '中文'}
          </Button>
        </div>
      }
      open={open}
      onCancel={onClose}
      width={900}
      footer={[
        <Button key="cancel" onClick={onClose}>
          {t('cancel')}
        </Button>,
        <Button key="test" type="dashed" onClick={handleTest} loading={testing}>
          {t('testConnection')}
        </Button>,
        <Button key="submit" type="primary" onClick={handleSubmit(onSubmit)} loading={saving} disabled={!testOk && !isEdit}>
          {t('save')}
        </Button>
      ]}
    >
      <Form layout="vertical">
        <Row gutter={24}>
          {/* 左侧：平台选择 */}
          <Col span={6} style={{ borderRight: '1px solid rgba(255,255,255,0.08)' }}>
            <Title level={5}>{t('modelPlatform')}</Title>
            <Controller
              name="provider"
              control={control}
              render={({ field }) => (
                <Radio.Group {...field} onChange={onProviderChange} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  <Radio.Button value="openai" style={{ width: '100%', textAlign: 'center' }}>{t('openai')}</Radio.Button>
                  <Radio.Button value="anthropic" style={{ width: '100%', textAlign: 'center' }}>{t('anthropic')}</Radio.Button>
                  <Radio.Button value="custom" style={{ width: '100%', textAlign: 'center' }}>{t('custom')}</Radio.Button>
                </Radio.Group>
              )}
            />
          </Col>

          {/* 中间：表单输入 */}
          <Col span={12}>
            <Form.Item label={t('modelId')} required>
              <Controller
                name="modelId"
                control={control}
                render={({ field, fieldState }) => (
                  <>
                    <Input {...field} placeholder="e.g. deepseek-chat" status={fieldState.error ? 'error' : ''} />
                    {fieldState.error && <Text type="danger">{fieldState.error.message}</Text>}
                  </>
                )}
              />
            </Form.Item>

            <Row gutter={16}>
              <Col span={8}>
                <Form.Item label="认证类型 (Auth)">
                  <Controller
                    name="authType"
                    control={control}
                    render={({ field }) => (
                      <Select
                        {...field}
                        options={[
                          { value: 'apiKey', label: 'API Key (默认)' },
                          { value: 'oauth', label: 'OAuth / JWT' },
                          { value: 'bedrock', label: 'AWS Bedrock' }
                        ]}
                      />
                    )}
                  />
                </Form.Item>
              </Col>
              <Col span={16}>
                <Form.Item
                  label="API Key / 凭证"
                  required={!isEdit}
                  extra={isEdit ? <Text type="secondary" style={{ fontSize: 12 }}>留空则保留原有 API Key</Text> : undefined}
                >
                  <Controller
                    name="apiKey"
                    control={control}
                    render={({ field, fieldState }) => (
                      <>
                        <Input.Password
                          {...field}
                          placeholder={isEdit ? '留空保留原有 Key，或输入新 Key' : (watchedValues.authType === 'bedrock' ? 'AKIA...:SecretKey' : 'sk-...')}
                          status={fieldState.error ? 'error' : ''}
                          autoComplete="new-password"
                        />
                        {fieldState.error && !isEdit && <Text type="danger">{fieldState.error.message}</Text>}
                      </>
                    )}
                  />
                </Form.Item>
              </Col>
            </Row>

            <Form.Item label={t('endpoint')} required>
              <Controller
                name="baseUrl"
                control={control}
                render={({ field, fieldState }) => (
                  <>
                    <Input {...field} placeholder="https://api.example.com/v1" status={fieldState.error ? 'error' : ''} />
                    {fieldState.error && <Text type="danger">{fieldState.error.message}</Text>}
                  </>
                )}
              />
            </Form.Item>

            <Form.Item label={t('displayName')}>
              <Controller
                name="displayName"
                control={control}
                render={({ field }) => (
                  <Input {...field} placeholder="e.g. My DeepSeek" />
                )}
              />
            </Form.Item>
          </Col>

          {/* 右侧：帮助信息 */}
          <Col span={6}>
            <Title level={5}>{t('helpText')}</Title>
            <Paragraph type="secondary" style={{ fontSize: 12 }}>
              {t('helpTextDesc')}
            </Paragraph>
            <Paragraph type="secondary" style={{ fontSize: 12 }}>
              <ul style={{ paddingLeft: 16, margin: 0 }}>
                <li>OpenAI 兼容接口请选择自定义平台</li>
                <li>注意避免将内网 IP 作为请求地址</li>
                <li>能力开关用于陌生模型；填好后点"自动识别"快速预填</li>
              </ul>
            </Paragraph>
          </Col>
        </Row>

        {/* ── 能力配置区 ───────────────────────────────────────── */}
        <Divider style={{ margin: '20px 0 12px', borderColor: 'rgba(255,255,255,0.1)' }}>
          <span style={{ fontSize: 13, color: 'rgba(255,255,255,0.55)' }}>模型能力</span>
        </Divider>
        <div style={{ marginBottom: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Text style={{ fontSize: 12, color: 'rgba(255,255,255,0.45)' }}>
            配置模型支持哪些能力。优先级：API 请求 &gt; 此处配置 &gt; 内置规则。
            {autoDetected && <Tag color="geekblue" style={{ marginLeft: 8, fontSize: 11 }}>已自动识别</Tag>}
          </Text>
          <Button
            size="small"
            icon={<ThunderboltOutlined />}
            loading={detecting}
            onClick={handleAutoDetect}
            style={{ fontSize: 12 }}
          >
            自动识别
          </Button>
        </div>

        {capDefs.length === 0 ? (
          <Text style={{ color: 'rgba(255,255,255,0.35)', fontSize: 12 }}>加载能力定义中...</Text>
        ) : (
          <Row gutter={[12, 12]}>
            {Object.entries(groupedDefs).map(([group, defs]) => (
              <Col span={12} key={group}>
                <div style={{
                  padding: '10px 14px',
                  background: 'rgba(255,255,255,0.04)',
                  border: '1px solid rgba(255,255,255,0.08)',
                  borderRadius: 8,
                }}>
                  <div style={{
                    fontSize: 11,
                    fontWeight: 600,
                    color: 'rgba(255,255,255,0.4)',
                    letterSpacing: 1,
                    textTransform: 'uppercase',
                    marginBottom: 8,
                  }}>
                    {GROUP_LABELS[group as CapabilityDef['group']]}
                  </div>
                  {defs.map((d, idx) => (
                    <div
                      key={d.key}
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        padding: '5px 0',
                        borderBottom: idx < defs.length - 1 ? '1px solid rgba(255,255,255,0.05)' : 'none',
                      }}
                    >
                      <Tooltip title={d.description} placement="left">
                        <span style={{ fontSize: 13, color: 'rgba(255,255,255,0.75)', cursor: 'default', display: 'flex', alignItems: 'center', gap: 6 }}>
                          <span style={{ fontSize: 14, lineHeight: 1 }}>{d.icon}</span>
                          {d.label}
                        </span>
                      </Tooltip>
                      <Switch
                        size="small"
                        checked={!!capabilities[d.key]}
                        onChange={(v) => handleCapToggle(d.key, v)}
                      />
                    </div>
                  ))}
                </div>
              </Col>
            ))}
          </Row>
        )}
      </Form>
    </Modal>
  )
}
