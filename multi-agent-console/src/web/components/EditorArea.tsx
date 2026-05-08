import React, { Suspense, lazy, useEffect, useState } from 'react'
import { useExplorerStore, selectActiveTab } from '@core/store/explorer'
import { useSessionStore } from '@core/store/session'
import { useTerminalStore } from '@core/store/terminal'
import { workspaceApi } from '@core/api'
import { EditorTabs } from './editor/EditorTabs'
import { ImagePreview } from './editor/ImagePreview'
import { VideoPreview } from './editor/VideoPreview'
import { HexEditor } from './editor/HexEditor'

// Monaco / Terminal 懒加载，减小初始 chunk 体积
const MonacoEditor = lazy(() =>
  import('./editor/MonacoEditor').then(m => ({ default: m.MonacoEditor }))
)
const TerminalPanel = lazy(() => import('./terminal/TerminalPanel'))

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
  const activeTab = useExplorerStore(selectActiveTab)
  const sessionId = useSessionStore(s => s.activeSessionId) ?? ''
  const panelVisible = useTerminalStore(s => s.panelVisible)

  // For image: build a URL via API proxy or direct path
  const [imageSrc, setImageSrc] = useState<string>('')

  // For binary/hex: raw bytes
  const [hexData, setHexData] = useState<Uint8Array>(new Uint8Array(0))

  useEffect(() => {
    if (!activeTab) return

    const ext = getExt(activeTab.name)

    if (IMAGE_EXTS.has(ext)) {
      // Fetch as base64 then convert to data URL
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
  }, [activeTab, sessionId])

  const ext = activeTab ? getExt(activeTab.name) : ''

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
            <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
              {IMAGE_EXTS.has(ext) ? (
                <ImagePreview src={imageSrc} name={activeTab.name} />
              ) : VIDEO_EXTS.has(ext) ? (
                <VideoPreview
                  src={`/api/v1/workspace/file/stream?sessionId=${encodeURIComponent(sessionId)}&path=${encodeURIComponent(activeTab.path)}`}
                  name={activeTab.name}
                />
              ) : activeTab.type === 'binary' ? (
                <HexEditor data={hexData} name={activeTab.name} />
              ) : (
                <Suspense fallback={editorLoading}>
                  <MonacoEditor />
                </Suspense>
              )}
            </div>
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
