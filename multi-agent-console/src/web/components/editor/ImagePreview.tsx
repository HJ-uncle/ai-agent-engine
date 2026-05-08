import React, { useCallback, useEffect, useRef, useState } from 'react'
import { MinusOutlined, PlusOutlined, ReloadOutlined, RotateLeftOutlined, RotateRightOutlined, FullscreenOutlined } from '@ant-design/icons'

interface ImagePreviewProps {
  src: string
  name: string
}

export function ImagePreview({ src, name }: ImagePreviewProps) {
  const [scale, setScale] = useState(1)
  const [rotation, setRotation] = useState(0)
  const [naturalSize, setNaturalSize] = useState({ w: 0, h: 0 })
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const [dragging, setDragging] = useState(false)
  const dragStart = useRef<{ mx: number; my: number; ox: number; oy: number } | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const imgRef = useRef<HTMLImageElement>(null)

  const onWheel = useCallback((e: WheelEvent) => {
    e.preventDefault()
    setScale(s => Math.max(0.1, Math.min(16, s * (e.deltaY < 0 ? 1.1 : 0.9))))
  }, [])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [onWheel])

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return
    e.preventDefault()
    setDragging(true)
    dragStart.current = { mx: e.clientX, my: e.clientY, ox: offset.x, oy: offset.y }
  }, [offset])

  const onMouseMove = useCallback((e: React.MouseEvent) => {
    if (!dragging || !dragStart.current) return
    const dx = e.clientX - dragStart.current.mx
    const dy = e.clientY - dragStart.current.my
    setOffset({ x: dragStart.current.ox + dx, y: dragStart.current.oy + dy })
  }, [dragging])

  const onMouseUp = useCallback(() => {
    setDragging(false)
    dragStart.current = null
  }, [])

  const fitToWindow = () => {
    const container = containerRef.current
    const img = imgRef.current
    if (!container || !img || !naturalSize.w || !naturalSize.h) return
    const { clientWidth: cw, clientHeight: ch } = container
    const { w, h } = naturalSize
    setScale(Math.min(1, cw / w, ch / h))
    setOffset({ x: 0, y: 0 })
  }

  const resetAll = () => {
    setScale(1)
    setOffset({ x: 0, y: 0 })
  }

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: '#1a1a1a' }}>
      {/* Toolbar */}
      <div style={{ display: 'flex', gap: 8, padding: '6px 12px', borderBottom: '1px solid #2a2a2a', flexShrink: 0, alignItems: 'center' }}>
        <button onClick={() => setScale(s => Math.min(16, s * 1.2))} style={btnStyle} title="放大"><PlusOutlined /></button>
        <button onClick={() => setScale(s => Math.max(0.1, s * 0.8))} style={btnStyle} title="缩小"><MinusOutlined /></button>
        <button onClick={resetAll} style={btnStyle} title="原始大小 1:1"><ReloadOutlined /></button>
        <button onClick={fitToWindow} style={btnStyle} title="适应窗口"><FullscreenOutlined /></button>
        <span style={{ color: '#555', fontSize: 11, marginLeft: 4 }}>{Math.round(scale * 100)}%</span>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          <button onClick={() => setRotation(r => r - 90)} style={btnStyle} title="逆时针旋转"><RotateLeftOutlined /></button>
          <button onClick={() => setRotation(r => r + 90)} style={btnStyle} title="顺时针旋转"><RotateRightOutlined /></button>
          <button onClick={() => setRotation(0)} style={btnStyle} title="重置旋转">↺</button>
        </div>
      </div>

      {/* Canvas */}
      <div
        ref={containerRef}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        onMouseLeave={onMouseUp}
        style={{
          flex: 1,
          overflow: 'hidden',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          backgroundImage: 'linear-gradient(45deg,#222 25%,transparent 25%),linear-gradient(-45deg,#222 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#222 75%),linear-gradient(-45deg,transparent 75%,#222 75%)',
          backgroundSize: '16px 16px',
          backgroundPosition: '0 0,0 8px,8px -8px,-8px 0',
          backgroundColor: '#1c1c1c',
          cursor: dragging ? 'grabbing' : 'grab',
          userSelect: 'none',
        }}
      >
        <img
          ref={imgRef}
          src={src}
          alt={name}
          draggable={false}
          onLoad={e => {
            const img = e.currentTarget
            setNaturalSize({ w: img.naturalWidth, h: img.naturalHeight })
          }}
          style={{
            transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale}) rotate(${rotation}deg)`,
            transformOrigin: 'center center',
            transition: dragging ? 'none' : 'transform 0.1s ease',
            maxWidth: 'none',
            maxHeight: 'none',
            display: 'block',
            pointerEvents: 'none',
          }}
        />
      </div>

      {/* Status bar */}
      <div style={{ padding: '4px 12px', borderTop: '1px solid #2a2a2a', fontSize: 11, color: '#555', flexShrink: 0 }}>
        {name} {naturalSize.w > 0 && `— ${naturalSize.w}×${naturalSize.h}px`}
      </div>
    </div>
  )
}

const btnStyle: React.CSSProperties = {
  background: 'transparent',
  border: '1px solid #3a3a3a',
  color: '#aaa',
  padding: '3px 8px',
  borderRadius: 3,
  cursor: 'pointer',
  fontSize: 12,
}