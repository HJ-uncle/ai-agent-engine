import { useEffect, useRef, useState } from 'react'
import { App } from 'antd'
import { settingsApi } from '@core/api'
import { buildSettingsPatch } from './settings-patch'

export type SettingsData = Record<string, any>

/**
 * 共享设置 hook — 所有 settings tab 共用一份数据，避免重复请求
 * 使用方式：const { settings, handleChange, saveKeys, saving } = useSettings()
 */
export function useSettings() {
  const { message } = App.useApp()
  const [settings, setSettings] = useState<SettingsData>({})
  const [saving, setSaving] = useState(false)
  const baseline = useRef<SettingsData>({})

  const load = () => {
    settingsApi.get().then((data) => { baseline.current = data; setSettings(data) })
  }

  useEffect(() => { load() }, [])

  const handleChange = (key: string, value: any) => {
    setSettings((prev) => ({ ...prev, [key]: value }))
  }

  /**
   * 只保存指定的 keys（每个 tab 只保存自己的字段）
   * @param keys      需要保存的字段名列表
   * @param successMsg 成功提示
   * @param overrides  可选的覆盖值，合并写入 payload（用于 setState 未落盘时立即持久化）
   */
  const saveKeys = async (keys: string[], successMsg = '已保存', overrides?: Record<string, any>) => {
    setSaving(true)
    try {
      const payload = buildSettingsPatch(keys, settings, baseline.current, overrides)
      if (Object.keys(payload).length === 0) { message.info('没有需要保存的修改'); return }
      await settingsApi.update(payload)
      // A newer edit during the request remains dirty against the value actually saved.
      baseline.current = { ...baseline.current, ...payload }
      message.success(successMsg)
    } catch {
      message.error('保存失败，请重试')
    } finally {
      setSaving(false)
    }
  }

  return { settings, handleChange, saveKeys, saving, reload: load }
}
