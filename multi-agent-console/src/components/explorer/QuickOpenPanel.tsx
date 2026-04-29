import React, { useEffect, useRef, useState } from 'react'
import Fuse from 'fuse.js'
import { useExplorerStore } from '../../store/explorer'
import { useFileIndex } from '../../hooks/useFileIndex'

interface QuickOpenPanelProps {
  files: string[]
  onClose: () => void
}

export function QuickOpenPanel({ files, onClose }: QuickOpenPanelProps) {
  const openTab = useExplorerStore(s => s.openTab)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<string[]>([])
  const [activeIdx, setActiveIdx] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  // Web Worker-backed index (fast for large repos)
  const { search: workerSearch } = useFileIndex({ files })

  // Fallback Fuse.js for immediate results while worker builds
  const fuse = useRef(
    new Fuse(files, { threshold: 0.4, includeScore: true, keys: [''] })
  )

  useEffect(() => {
    fuse.current = new Fuse(files, { threshold: 0.4, includeScore: true, keys: [''] })
  }, [files])

  useEffect(() => {
    let cancelled = false
    const run = async () => {
      if (!query.trim()) {
        if (!cancelled) setResults(files.slice(0, 50))
        return
      }
      // Use worker search (async, < 10 ms for 100k files)
      const r = await workerSearch(query, 50)
      if (!cancelled) setResults(r)
    }
    setActiveIdx(0)
    run()
    return () => { cancelled = true }
  }, [query, files, workerSearch])

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  const openFile = (path: string) => {
    const name = path.split('/').pop() ?? path
    openTab({ path, name, type: 'text' as any })
    onClose()
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIdx(i => Math.min(i + 1, results.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIdx(i => Math.max(i - 1, 0))
    } else if (e.key === 'Enter' && results[activeIdx]) {
      openFile(results[activeIdx])
    }
  }

  // Highlight matched chars
  const highlight = (path: string, q: string) => {
    if (!q) return <span style={{ color: '#ccc' }}>{path}</span>
    const parts = path.split(new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'i'))
    return (
      <span>
        {parts.map((p, i) =>
          p.toLowerCase() === q.toLowerCase()
            ? <mark key={i} style={{ background: 'transparent', color: '#f9c513', fontWeight: 700 }}>{p}</mark>
            : <span key={i} style={{ color: '#ccc' }}>{p}</span>
        )}
      </span>
    )
  }

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 9998,
        display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
        paddingTop: '15vh',
        background: 'rgba(0,0,0,0.5)',
      }}
      onClick={onClose}
    >
      <div
        style={{
          background: '#252526',
          border: '1px solid #454545',
          borderRadius: 6,
          width: 600,
          maxHeight: 480,
          display: 'flex',
          flexDirection: 'column',
          boxShadow: '0 8px 32px rgba(0,0,0,0.6)',
          overflow: 'hidden',
        }}
        onClick={e => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          value={query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="输入文件名快速打开..."
          style={{
            background: 'transparent',
            border: 'none',
            borderBottom: '1px solid #454545',
            outline: 'none',
            padding: '10px 16px',
            fontSize: 14,
            color: '#ccc',
            width: '100%',
            boxSizing: 'border-box',
          }}
        />
        <div style={{ overflowY: 'auto', maxHeight: 400 }}>
          {results.map((path, i) => {
            const name = path.split('/').pop() ?? path
            const dir = path.substring(0, path.lastIndexOf('/'))
            return (
              <div
                key={path}
                onClick={() => openFile(path)}
                style={{
                  padding: '6px 16px',
                  cursor: 'pointer',
                  background: i === activeIdx ? '#094771' : 'transparent',
                  display: 'flex',
                  flexDirection: 'column',
                }}
                onMouseEnter={() => setActiveIdx(i)}
              >
                <span style={{ fontSize: 13 }}>{highlight(name, query)}</span>
                <span style={{ fontSize: 11, color: '#666', marginTop: 1 }}>{dir}</span>
              </div>
            )
          })}
          {results.length === 0 && (
            <div style={{ padding: '16px', color: '#666', fontSize: 13, textAlign: 'center' }}>
              无匹配结果
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
