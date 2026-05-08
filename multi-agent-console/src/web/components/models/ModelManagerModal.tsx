import React, { useState, useEffect } from 'react'
import { Modal, Form, Input, Button, Radio, Typography, message, Row, Col } from 'antd'
import { useForm, Controller } from 'react-hook-form'
import { yupResolver } from '@hookform/resolvers/yup'
import * as yup from 'yup'
import { useTranslation } from 'react-i18next'
import { modelsApi } from '@core/api'
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
  } | null
}

interface FormData {
  provider: 'openai' | 'anthropic' | 'custom'
  modelId: string
  apiKey: string
  baseUrl: string
  displayName?: string
}

export default function ModelManagerModal({ open, onClose, onSuccess, editModel }: ModelManagerModalProps) {
  const { t, i18n } = useTranslation()
  const [testing, setTesting] = useState(false)
  const [testOk, setTestOk] = useState(false)
  const [saving, setSaving] = useState(false)
  const isEdit = !!editModel

  const schema = yup.object({
    provider: yup.mixed<'openai' | 'anthropic' | 'custom'>().oneOf(['openai', 'anthropic', 'custom']).required(),
    modelId: yup.string().required(t('modelIdRequired')),
    // 编辑模式下 apiKey 可为空（保留原有），新增时必须填写且至少 16 位
    apiKey: isEdit
      ? yup.string().optional().test('key-length', t('keyLengthError'), (val) => !val || val.length === 0 || val.length >= 16)
      : yup.string().min(16, t('keyLengthError')).required(),
    baseUrl: yup.string().url(t('urlFormatError')).matches(/^https?:\/\/.+/, t('urlFormatError')).required(),
    displayName: yup.string().optional()
  })

  const { control, handleSubmit, watch, reset, setValue, trigger } = useForm<FormData>({
    resolver: yupResolver(schema) as any,
    defaultValues: {
      provider: 'openai',
      modelId: '',
      apiKey: '',
      baseUrl: 'https://api.openai.com/v1',
      displayName: ''
    },
    mode: 'onChange'
  })

  const watchedValues = watch()

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
        // 编辑模式下允许不重新测试直接保存（apiKey 可能未变）
        setTestOk(false)
      } else {
        reset()
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
        })
        message.success('模型更新成功')
      } else {
        await modelsApi.createModel({
          provider: data.provider,
          modelId: data.modelId,
          apiKey: data.apiKey,
          baseUrl: data.baseUrl,
          displayName: data.displayName || data.modelId,
          isEnabled: false
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
      width={800}
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
          <Col span={6} style={{ borderRight: '1px solid #f0f0f0' }}>
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

            <Form.Item
              label={t('apiKey')}
              required={!isEdit}
              extra={isEdit ? <Text type="secondary" style={{ fontSize: 12 }}>留空则保留原有 API Key</Text> : undefined}
            >
              <Controller
                name="apiKey"
                control={control}
                render={({ field, fieldState }) => (
                  <>
                    <Input.Password {...field} placeholder={isEdit ? '留空保留原有 Key，或输入新 Key' : 'sk-...'} status={fieldState.error ? 'error' : ''} autoComplete="new-password" />
                    {fieldState.error && !isEdit && <Text type="danger">{fieldState.error.message}</Text>}
                  </>
                )}
              />
            </Form.Item>

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
            <Paragraph type="secondary">
              {t('helpTextDesc')}
            </Paragraph>
            <Paragraph type="secondary">
              <ul>
                <li>OpenAI 兼容接口请选择自定义平台</li>
                <li>注意避免将内网 IP 作为请求地址</li>
              </ul>
            </Paragraph>
          </Col>
        </Row>
      </Form>
    </Modal>
  )
}