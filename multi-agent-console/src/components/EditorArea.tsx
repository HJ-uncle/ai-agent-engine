import React, { useEffect, useState } from 'react'
import { useSessionStore } from '../store/session'
import { workspaceApi } from '../api'
import hljs from 'highlight.js'

export default function EditorArea() {
  const activeSessionId = useSessionStore(s => s.activeSessionId)
  const activeFile = useSessionStore(s => s.activeFile)
  const [content, setContent] = useState('')
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!activeSessionId || !activeFile) {
      setContent('')
      return
    }

    let isMounted = true
    setLoading(true)
    workspaceApi.getFileContent(activeSessionId, activeFile)
      .then(res => {
        if (isMounted) {
          // Detect language from extension
          const ext = activeFile.split('.').pop() || 'txt'
          const langMap: Record<string, string> = {
            'js': 'javascript', 'ts': 'typescript', 'jsx': 'javascript', 'tsx': 'typescript',
            'json': 'json', 'md': 'markdown', 'html': 'xml', 'css': 'css', 'py': 'python'
          }
          const lang = langMap[ext] || 'plaintext'
          
          try {
            const highlighted = hljs.highlight(res, { language: lang }).value
            setContent(highlighted)
          } catch (e) {
            setContent(hljs.highlightAuto(res).value)
          }
        }
      })
      .catch(() => {
        if (isMounted) setContent('Failed to load file content.')
      })
      .finally(() => {
        if (isMounted) setLoading(false)
      })

    return () => { isMounted = false }
  }, [activeSessionId, activeFile])

  if (!activeFile) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#484f58', fontSize: 24, userSelect: 'none' }}>
        VS Code Editor View
      </div>
    )
  }

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', backgroundColor: '#1e1e1e', overflow: 'hidden' }}>
      {/* Editor Tabs */}
      <div style={{ display: 'flex', backgroundColor: '#252526', overflowX: 'auto', flexShrink: 0 }}>
        <div style={{ 
          padding: '8px 16px', 
          backgroundColor: '#1e1e1e', 
          color: '#d4d4d4', 
          fontSize: 13, 
          borderTop: '1px solid #007fd4',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          cursor: 'pointer'
        }}>
          {activeFile.split('/').pop()}
          <span 
            style={{ fontSize: 12, padding: '2px 4px', borderRadius: 3, cursor: 'pointer' }}
            onClick={(e) => {
              e.stopPropagation()
              useSessionStore.setState({ activeFile: null })
            }}
            onMouseOver={(e) => (e.currentTarget.style.backgroundColor = 'rgba(255,255,255,0.1)')}
            onMouseOut={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
          >
            ✕
          </span>
        </div>
      </div>

      {/* Editor Content */}
      <div style={{ flex: 1, overflow: 'auto', padding: '16px', position: 'relative' }}>
        {loading && <div style={{ position: 'absolute', top: 16, right: 16, color: '#888', fontSize: 12 }}>Loading...</div>}
        <pre style={{ margin: 0, padding: 0 }}>
          <code 
            className="hljs" 
            style={{ backgroundColor: 'transparent', padding: 0, fontSize: 13, fontFamily: "Consolas, 'Courier New', monospace", lineHeight: 1.5 }}
            dangerouslySetInnerHTML={{ __html: content || ' ' }}
          />
        </pre>
      </div>
    </div>
  )
}
