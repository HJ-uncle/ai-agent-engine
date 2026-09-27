import React, { useRef } from 'react'
import { PictureOutline, FileOutline, CameraOutline, SoundOutline } from 'antd-mobile-icons'
import styles from './InputToolbox.module.css'

interface Tool {
  icon: React.ReactNode
  label: string
  onClick: () => void
  accept?: string
  capture?: 'user' | 'environment'
  multiple?: boolean
}

interface InputToolboxProps {
  visible: boolean
  onFileSelected: (files: File[]) => void
}

export function InputToolbox({ visible, onFileSelected }: InputToolboxProps) {
  const photoRef = useRef<HTMLInputElement>(null)
  const albumRef = useRef<HTMLInputElement>(null)
  const fileRef  = useRef<HTMLInputElement>(null)

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) onFileSelected(Array.from(e.target.files))
    e.target.value = ''
  }

  const tools: Tool[] = [
    {
      icon: <CameraOutline />,
      label: '拍照',
      onClick: () => photoRef.current?.click(),
    },
    {
      icon: <PictureOutline />,
      label: '图片',
      onClick: () => albumRef.current?.click(),
    },
    {
      icon: <FileOutline />,
      label: '文件',
      onClick: () => fileRef.current?.click(),
    },
    {
      icon: <SoundOutline />,
      label: '语音输入',
      onClick: () => {/* 待实现 */},
    },
  ]

  if (!visible) return null

  return (
    <div className={styles.toolbox}>
      <div className={styles.grid}>
        {tools.map((t) => (
          <button key={t.label} className={styles.toolItem} onClick={t.onClick}>
            <div className={styles.toolIcon}>{t.icon}</div>
            <div className={styles.toolLabel}>{t.label}</div>
          </button>
        ))}
      </div>

      {/* 隐藏 inputs */}
      <input ref={photoRef} type="file" accept="image/*" capture="environment" style={{ display: 'none' }} onChange={handleChange} />
      <input ref={albumRef} type="file" accept="image/*" multiple style={{ display: 'none' }} onChange={handleChange} />
      <input ref={fileRef}  type="file" multiple          style={{ display: 'none' }} onChange={handleChange} />
    </div>
  )
}
