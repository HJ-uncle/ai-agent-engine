import React, { useEffect, useRef } from 'react'

interface UnsavedDialogProps {
  path: string
  onSave: () => Promise<void>
  onDiscard: () => void
  onCancel: () => void
}

export function UnsavedDialog({ path, onSave, onDiscard, onCancel }: UnsavedDialogProps) {
  const name = path.split('/').pop() ?? path
  const saveButtonRef = useRef<HTMLButtonElement>(null)

  // Default focus on "保存"
  useEffect(() => {
    saveButtonRef.current?.focus()
  }, [])

  // Keyboard: Enter = Save, Escape = Cancel
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onCancel])

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 10000,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'rgba(0,0,0,0.5)',
      }}
    >
      <div
        style={{
          background: '#252526',
          border: '1px solid #454545',
          borderRadius: 6,
          padding: '24px 28px',
          minWidth: 360,
          boxShadow: '0 8px 32px rgba(0,0,0,0.6)',
        }}
      >
        <div style={{ fontSize: 14, color: '#ccc', marginBottom: 8, fontWeight: 600 }}>
          是否保存对 "{name}" 的更改？
        </div>
        <div style={{ fontSize: 12, color: '#888', marginBottom: 24 }}>
          你的更改尚未保存。如果不保存，你的更改将会丢失。
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button
            onClick={onDiscard}
            style={{
              padding: '5px 14px', background: 'transparent',
              border: '1px solid #555', color: '#ccc',
              borderRadius: 4, cursor: 'pointer', fontSize: 13,
            }}
          >
            不保存
          </button>
          <button
            onClick={onCancel}
            style={{
              padding: '5px 14px', background: 'transparent',
              border: '1px solid #555', color: '#ccc',
              borderRadius: 4, cursor: 'pointer', fontSize: 13,
            }}
          >
            取消
          </button>
          <button
            ref={saveButtonRef}
            onClick={onSave}
            autoFocus
            style={{
              padding: '5px 14px', background: '#0e639c',
              border: 'none', color: '#fff',
              borderRadius: 4, cursor: 'pointer', fontSize: 13,
              outline: '2px solid #007acc',
            }}
          >
            保存
          </button>
        </div>
      </div>
    </div>
  )
}
