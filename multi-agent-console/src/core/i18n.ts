import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'

const resources = {
  en: {
    translation: {
      modelPlatform: 'Model Platform',
      modelId: 'Model ID',
      apiKey: 'API Key',
      endpoint: 'Endpoint',
      displayName: 'Display Name (Optional)',
      testConnection: 'Test Connection',
      save: 'Save',
      cancel: 'Cancel',
      openai: 'OpenAI',
      anthropic: 'Anthropic',
      custom: 'Custom',
      helpText: 'Help',
      helpTextDesc: 'Please select a platform and fill in the corresponding configuration. The model ID must be in the whitelist.',
      testSuccess: 'Connection successful',
      testFailed: 'Connection failed, please check endpoint and key',
      saveSuccess: 'Saved successfully',
      saveFailed: 'Failed to save',
      urlFormatError: 'Invalid URL format, must be https://.../v1/chat/completions or similar',
      keyLengthError: 'API Key must be at least 16 characters',
      modelIdRequired: 'Model ID is required',
      modelConflict: 'Model ID conflicts with existing ones',
      unnamedModel: 'Unnamed Model',
      reEnter: 'Re-enter',
      masked: '********',
    }
  },
  zh: {
    translation: {
      modelPlatform: '模型平台',
      modelId: '模型 ID',
      apiKey: 'API 密钥',
      endpoint: '请求地址',
      displayName: '自定义显示名称 (可选)',
      testConnection: '测试连接',
      save: '保存',
      cancel: '取消',
      openai: 'OpenAI',
      anthropic: 'Anthropic',
      custom: '自定义',
      helpText: '帮助说明',
      helpTextDesc: '请选择平台并填写对应配置。模型 ID 必须在白名单内。',
      testSuccess: '连接成功',
      testFailed: '无法连通，请检查 endpoint 与 key',
      saveSuccess: '保存成功',
      saveFailed: '保存失败',
      urlFormatError: '地址格式错误，通常为 https://.../v1/chat/completions',
      keyLengthError: '密钥长度最小 16 位',
      modelIdRequired: '模型 ID 必填',
      modelConflict: '模型 ID 与白名单冲突',
      unnamedModel: '未命名模型',
      reEnter: '重新输入',
      masked: '********',
    }
  }
}

i18n
  .use(initReactI18next)
  .init({
    resources,
    lng: 'zh',
    fallbackLng: 'en',
    interpolation: {
      escapeValue: false
    }
  })

export default i18n