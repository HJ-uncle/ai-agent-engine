import { useEffect, useState } from 'react'
import { App } from 'antd'
import { settingsApi } from '@core/api'

export type SettingsData = Record<string, any>

/**
 * 共享设置 hook — 所有 settings tab 共用一份数据，避免重复请求
 * 使用方式：const { settings, handleChange, saveKeys, saving } = useSettings()
 */
export function useSettings() {
  const { message } = App.useApp()
  const [settings, setSettings] = useState<SettingsData>({})
  const [saving, setSaving] = useState(false)

  const load = () => {
    settingsApi.get().then((data) => setSettings(data))
  }

  useEffect(() => { load() }, [])

  const handleChange = (key: string, value: any) => {
    setSettings((prev) => ({ ...prev, [key]: value }))
  }

  /**
   * 只保存指定的 keys（每个 tab 只保存自己的字段）
   */
  const saveKeys = async (keys: string[], successMsg = '已保存') => {
    setSaving(true)
    try {
      const payload = Object.fromEntries(
        keys
          .filter((k) => settings[k] !== undefined)
          .map((k) => [k, settings[k]])
      )
      await settingsApi.update(payload)
      message.success(successMsg)
    } catch {
      message.error('保存失败，请重试')
    } finally {
      setSaving(false)
    }
  }

  return { settings, handleChange, saveKeys, saving, reload: load }
}
