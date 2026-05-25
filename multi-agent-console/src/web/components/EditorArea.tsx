import React, { Suspense, lazy, useEffect, useState, useRef } from 'react'
import { Button } from 'antd'
import { useExplorerStore } from '@core/store/explorer'
import { useSessionStore } from '@core/store/session'
import { useTerminalStore } from '@core/store/terminal'
import { workspaceApi } from '@core/api'
import { EditorTabs } from './editor/EditorTabs'
import { ImagePreview } from './editor/ImagePreview'
import { VideoPreview } from './editor/VideoPreview'

// Monaco / Terminal 懒加载，减小初始 chunk 体积
const MonacoEditor = lazy(() =>
  import('./editor/MonacoEditor').then(m => ({ default: m.MonacoEditor }))
)
const TerminalPanel = lazy(() => import('./terminal/TerminalPanel'))

const MAX_FILE_SIZE = 1024 * 1024 * 5 // 5MB

// ─── File type detection ──────────────────────────────────────────────────────

const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'ico'])
const VIDEO_EXTS = new Set(['mp4', 'webm', 'ogg'])

function getExt(name: string) {
  return name.split('.').pop()?.toLowerCase() ?? ''
}

const editorLoading = (
  <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#555', fontSize: 12 }}>
    加载编辑器…
  </div>
)

// ─── EditorArea ───────────────────────────────────────────────────────────────

export default function EditorArea() {
  const activeTabPath = useExplorerStore(s => s.activeTabPath)
  const activeTabName = useExplorerStore(s => s.tabs.find(t => t.path === s.activeTabPath)?.name ?? '')
  const activeTabType = useExplorerStore(s => s.tabs.find(t => t.path === s.activeTabPath)?.type ?? 'text')

  const activeTab = activeTabPath ? {
    path: activeTabPath,
    name: activeTabName,
    type: activeTabType,
  } : null

  const sessionId = useSessionStore(s => s.activeSessionId) ?? ''
  const panelVisible = useTerminalStore(s => s.panelVisible)

  // For image: build a URL via API proxy or direct path
  const [imageSrc, setImageSrc] = useState<string>('')

  // For binary/hex: raw bytes
  const [hexData, setHexData] = useState<Uint8Array>(new Uint8Array(0))

  const [fileInfo, setFileInfo] = useState<{ size: number; type: string } | null>(null)
  const [loading, setLoading] = useState(false)

  // Using a ref to prevent infinite loops if dependencies change too frequently
  const loadedPathRef = useRef<string | null>(null)

  useEffect(() => {
    if (!activeTab) {
      setFileInfo(null)
      loadedPathRef.current = null
      return
    }

    if (loadedPathRef.current === activeTab.path) {
      return // Already loaded this file's info, skip fetching again to prevent infinite loops
    }
    
    loadedPathRef.current = activeTab.path
    setLoading(true)
    workspaceApi.getFileInfo(sessionId, activeTab.path)
      .then(info => {
        if (!info) return
        setFileInfo(info)
        const ext = getExt(activeTab.name)

        if (info.size > MAX_FILE_SIZE) {
          setLoading(false)
          return
        }

        if (IMAGE_EXTS.has(ext)) {
          workspaceApi.readFileBinary(sessionId, activeTab.path).then(b64 => {
            const mimeMap: Record<string, string> = {
              jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
              gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
              bmp: 'image/bmp', ico: 'image/x-icon',
            }
            setImageSrc(`data:${mimeMap[ext] ?? 'image/png'};base64,${b64}`)
          }).catch(() => setImageSrc(''))
        } else if (activeTab.type === 'binary') {
          workspaceApi.readFileBinary(sessionId, activeTab.path).then(b64 => {
            const binary = atob(b64)
            const bytes = new Uint8Array(binary.length)
            for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
            setHexData(bytes)
          }).catch(() => setHexData(new Uint8Array(0)))
        }
      })
      .finally(() => setLoading(false))
  }, [activeTab, sessionId])

  const handleDownload = () => {
    if (!activeTab) return
    const url = `/api/v1/workspace/file/download?sessionId=${encodeURIComponent(sessionId)}&path=${encodeURIComponent(activeTab.path)}`
    window.open(url, '_blank')
  }

  const ext = activeTab ? getExt(activeTab.name) : ''

  const renderContent = () => {
    if (loading) return editorLoading

    if (fileInfo && fileInfo.size > MAX_FILE_SIZE) {
      return (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#ccc', fontSize: 14, flexDirection: 'column', gap: 12 }}>
          <span style={{ fontSize: 40 }}>⚠️</span>
          <span>文件过大 ({Math.round(fileInfo.size / 1024 / 1024 * 100) / 100}MB)，为了性能考虑暂不支持直接打开。</span>
          <Button
            type="primary"
            onClick={handleDownload}
            style={{ background: '#0e639c', borderColor: '#0e639c' }}
          >下载文件</Button>
        </div>
      )
    }

    if (activeTab?.type === 'binary' && !IMAGE_EXTS.has(ext) && !VIDEO_EXTS.has(ext)) {
      return (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#ccc', fontSize: 14, flexDirection: 'column', gap: 12 }}>
          <span style={{ fontSize: 40 }}>🚫</span>
          <span>暂不支持打开该类型的文件，直接打开可能会导致乱码。</span>
          <Button
            type="primary"
            onClick={handleDownload}
            style={{ background: '#0e639c', borderColor: '#0e639c' }}
          >下载查看</Button>
        </div>
      )
    }

    return (
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        {IMAGE_EXTS.has(ext) ? (
          <ImagePreview src={imageSrc} name={activeTab!.name} />
        ) : VIDEO_EXTS.has(ext) ? (
          <VideoPreview
            src={`/api/v1/workspace/file/stream?sessionId=${encodeURIComponent(sessionId)}&path=${encodeURIComponent(activeTab!.path)}`}
            name={activeTab!.name}
          />
        ) : (
          <Suspense fallback={editorLoading}>
            <MonacoEditor />
          </Suspense>
        )}
      </div>
    )
  }

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: '#1e1e1e' }}>

      {/* ── 上方：编辑器区 ─────────────────────────────────────────────── */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minHeight: 0 }}>
        {!activeTab ? (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#555', fontSize: 14, flexDirection: 'column', gap: 8 }}>
            <span style={{ fontSize: 48 }}>📁</span>
            <span>在左侧资源管理树中选择文件打开</span>
            {/* <span style={{ fontSize: 12, color: '#444' }}>Ctrl+P 快速打开文件</span> */}
          </div>
        ) : (
          <>
            <EditorTabs />
            {renderContent()}
          </>
        )}
      </div>

      {/* ── 下方：终端面板（panelVisible 控制显示） ────────────────────── */}
      {panelVisible && (
        <Suspense fallback={null}>
          <TerminalPanel sessionId={sessionId} />
        </Suspense>
      )}
    </div>
  )
}
