import React, { useEffect, useRef, useState } from 'react'

interface VideoPreviewProps {
  src: string
  name: string
}

const SPEEDS = [0.5, 1, 1.5, 2]

export function VideoPreview({ src, name }: VideoPreviewProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [playing, setPlaying] = useState(false)
  const [muted, setMuted] = useState(false)
  const [speed, setSpeed] = useState(1)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)

  const fmt = (t: number) => {
    const m = Math.floor(t / 60)
    const s = Math.floor(t % 60).toString().padStart(2, '0')
    return `${m}:${s}`
  }

  const toggle = () => {
    const v = videoRef.current
    if (!v) return
    if (v.paused) { v.play(); setPlaying(true) }
    else { v.pause(); setPlaying(false) }
  }

  const toggleMute = () => {
    const v = videoRef.current
    if (!v) return
    v.muted = !v.muted
    setMuted(v.muted)
  }

  const changeSpeed = (s: number) => {
    const v = videoRef.current
    if (!v) return
    v.playbackRate = s
    setSpeed(s)
  }

  const stepFrame = (dir: 1 | -1) => {
    const v = videoRef.current
    if (!v) return
    v.pause()
    setPlaying(false)
    v.currentTime = Math.max(0, Math.min(v.duration, v.currentTime + dir / 30))
  }

  const fullscreen = () => videoRef.current?.requestFullscreen()

  // Keyboard shortcuts (Space/F/M/←/→)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (['INPUT', 'TEXTAREA'].includes((e.target as HTMLElement).tagName)) return
      if (e.key === ' ') { e.preventDefault(); toggle() }
      else if (e.key === 'f' || e.key === 'F') { e.preventDefault(); fullscreen() }
      else if (e.key === 'm' || e.key === 'M') { e.preventDefault(); toggleMute() }
      else if (e.key === 'ArrowRight') { e.preventDefault(); stepFrame(1) }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); stepFrame(-1) }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const mimeType = (() => {
    const ext = src.split('.').pop()?.toLowerCase()
    if (ext === 'mp4') return 'video/mp4'
    if (ext === 'webm') return 'video/webm'
    return 'video/ogg'
  })()

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', background: '#000', overflow: 'hidden' }}>
      <video
        ref={videoRef}
        style={{ flex: 1, width: '100%', objectFit: 'contain' }}
        onTimeUpdate={e => setCurrentTime(e.currentTarget.currentTime)}
        onLoadedMetadata={e => setDuration(e.currentTarget.duration)}
        onEnded={() => setPlaying(false)}
      >
        <source src={src} type={mimeType} />
      </video>

      {/* Controls */}
      <div style={{ background: 'var(--material-chrome)', backdropFilter: 'saturate(1.8) blur(20px)', WebkitBackdropFilter: 'saturate(1.8) blur(20px)', padding: '8px 12px', borderTop: 'var(--border-hairline)', flexShrink: 0 }}>
        {/* Progress bar */}
        <input
          type="range"
          min={0}
          max={duration || 1}
          step={0.1}
          value={currentTime}
          onChange={e => {
            const v = videoRef.current
            if (v) v.currentTime = Number(e.target.value)
            setCurrentTime(Number(e.target.value))
          }}
          style={{ width: '100%', marginBottom: 8, accentColor: '#007acc' }}
        />
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <button onClick={toggle} style={btnStyle}>{playing ? '⏸' : '▶'}</button>
          <span style={{ color: '#888', fontSize: 12 }}>{fmt(currentTime)} / {fmt(duration)}</span>
          <button onClick={() => stepFrame(-1)} style={btnStyle} title="逐帧后退 (←)">⏮</button>
          <button onClick={() => stepFrame(1)} style={btnStyle} title="逐帧前进 (→)">⏭</button>
          <button onClick={toggleMute} style={btnStyle}>{muted ? '🔇' : '🔊'}</button>
          <select
            value={speed}
            onChange={e => changeSpeed(Number(e.target.value))}
            style={{ background: '#2d2d2d', border: '1px solid #444', color: '#ccc', borderRadius: 3, padding: '2px 4px', fontSize: 12 }}
          >
            {SPEEDS.map(s => <option key={s} value={s}>{s}×</option>)}
          </select>
          <button onClick={fullscreen} style={{ ...btnStyle, marginLeft: 'auto' }} title="全屏 (F)">⛶</button>
        </div>
      </div>
    </div>
  )
}

const btnStyle: React.CSSProperties = {
  background: 'transparent',
  border: '1px solid #444',
  color: '#ccc',
  padding: '3px 8px',
  borderRadius: 3,
  cursor: 'pointer',
  fontSize: 13,
}
