import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Editor, { OnMount } from '@monaco-editor/react'
import type * as MonacoType from 'monaco-editor'
import { App } from 'antd'
import { workspaceApi } from '../../api'
import { useExplorerStore, dirtyContentCache, type TabItem } from '../../store/explorer'
import { useSessionStore } from '../../store/session'
import { UnsavedDialog } from './UnsavedDialog'

// ─── Extension → Monaco language mapping ──────────────────────────────────────

const EXT_LANG: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
  json: 'json', html: 'html', css: 'css', scss: 'scss', less: 'less',
  md: 'markdown', markdown: 'markdown', py: 'python', rb: 'ruby',
  go: 'go', rs: 'rust', java: 'java', cs: 'csharp', cpp: 'cpp',
  c: 'c', h: 'cpp', hpp: 'cpp', sh: 'shell', bash: 'shell',
  ps1: 'powershell', sql: 'sql', xml: 'xml', yaml: 'yaml', yml: 'yaml',
  toml: 'ini', dockerfile: 'dockerfile', graphql: 'graphql', proto: 'proto',
  tf: 'hcl', kt: 'kotlin', swift: 'swift', dart: 'dart', r: 'r',
  lua: 'lua', php: 'php', pl: 'perl', ex: 'elixir', erl: 'erlang',
  hs: 'haskell', clj: 'clojure', fs: 'fsharp', vb: 'vb', groovy: 'groovy',
}

function getLanguage(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  return EXT_LANG[ext] ?? 'plaintext'
}

// ─── MonacoEditor component ───────────────────────────────────────────────────

export function MonacoEditor() {
  const { message } = App.useApp()
  const sessionId = useSessionStore(s => s.activeSessionId) ?? ''
  // 订阅 activeTabPath（稳定字符串），切换文件时触发重渲
  const activeTabPath = useExplorerStore(s => s.activeTabPath)
  // 订阅当前 tab 的各个原始字段（原始类型比较稳定，不会产生新引用）
  // 这样 isDirty/name 变化时能正常更新 UI，而不会因 tabs 数组整体变化循环
  const activeTabName    = useExplorerStore(s => s.tabs.find(t => t.path === s.activeTabPath)?.name    ?? '')
  const activeTabType    = useExplorerStore(s => s.tabs.find(t => t.path === s.activeTabPath)?.type    ?? 'text') as TabItem['type']
  const activeTabIsDirty = useExplorerStore(s => s.tabs.find(t => t.path === s.activeTabPath)?.isDirty ?? false)
  // 组合成稳定对象 — 用 useMemo 确保只有字段真正变化时才产生新引用
  // 这样 useCallback / useEffect 的依赖比较才能精确，不会每次渲染都触发
  const activeTab: TabItem | null = useMemo(
    () => activeTabPath
      ? { path: activeTabPath, name: activeTabName, type: activeTabType, isDirty: activeTabIsDirty }
      : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeTabPath, activeTabName, activeTabType, activeTabIsDirty]
  )
  const markDirty = useExplorerStore(s => s.markDirty)
  const markSaved = useExplorerStore(s => s.markSaved)
  // dirtyTabs 仅供 saveAllFiles 用，通过 getState() 在回调里读，不订阅响应式
  const closeTab = useExplorerStore(s => s.closeTab)

  // 用 ref 存储当前编辑内容，避免 value 受控循环
  const [initialContent, setInitialContent] = useState<string>('')
  const [loadingContent, setLoadingContent] = useState(false)
  const editorRef = useRef<MonacoType.editor.IStandaloneCodeEditor | null>(null)
  // Track which path we've already loaded, to prevent double-load
  const loadedPathRef = useRef<string | null>(null)

  // UnsavedDialog state
  const [unsavedPath, setUnsavedPath] = useState<string | null>(null)

  // ── Load file content when active tab changes ────────────────────────────

  useEffect(() => {
    if (!activeTab || activeTab.type !== 'text') return
    // Already loaded this path — skip
    if (loadedPathRef.current === activeTab.path) return
    loadedPathRef.current = activeTab.path
    setLoadingContent(true)
    workspaceApi.readFileText(sessionId, activeTab.path)
      .then(text => {
        setInitialContent(text)
        // Store original text for "save all" comparison — use getState to avoid triggering re-render
        useExplorerStore.getState().markSaved(activeTab.path, text)
      })
      .catch(() => setInitialContent('// 无法加载文件内容'))
      .finally(() => setLoadingContent(false))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab?.path])

  // ── Editor mount: register shortcuts ─────────────────────────────────────

  const handleMount: OnMount = useCallback((editor, monaco) => {
    editorRef.current = editor

    // Ctrl+S — save current file
    editor.addCommand(
      monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS,
      () => saveCurrentFile(),
    )

    // Ctrl+K S — save all
    editor.addCommand(
      monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyK,
      () => {
        // Queue save-all on next tick (Ctrl+K S is a chord)
        setTimeout(() => saveAllFiles(), 0)
      },
    )
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Save helpers ─────────────────────────────────────────────────────────

  const saveCurrentFile = useCallback(async () => {
    if (!activeTab || activeTab.type !== 'text' || !sessionId) return
    // 优先从 cache 读（每键实时更新），fallback 到 editor.getValue()
    const currentContent = dirtyContentCache.get(activeTab.path) ?? editorRef.current?.getValue() ?? ''
    try {
      let finalContent = currentContent
      try {
        finalContent = await workspaceApi.formatFile(sessionId, activeTab.path, currentContent)
      } catch {
        // formatter not available — save raw
      }
      await workspaceApi.writeFile(sessionId, activeTab.path, finalContent)
      markSaved(activeTab.path, finalContent)
      if (finalContent !== currentContent) {
        editorRef.current?.setValue(finalContent)
      }
    } catch (e: any) {
      message.error(e.message ?? '保存失败')
    }
  }, [activeTab, sessionId, markSaved, message])

  const saveAllFiles = useCallback(async () => {
    // 通过 getState() 读取最新 tabs，不订阅响应式，避免将 dirtyTabs 加入依赖
    const dirtyTabs = useExplorerStore.getState().tabs.filter(t => t.isDirty)
    for (const tab of dirtyTabs) {
      if (tab.type !== 'text') continue
      try {
        // 优先从 cache 读最新内容（用户可能在 save-all 前持续编辑）
        const raw = dirtyContentCache.get(tab.path) ?? tab.savedContent ?? ''
        let finalContent = raw
        try {
          finalContent = await workspaceApi.formatFile(sessionId, tab.path, raw)
        } catch { /* ignore */ }
        await workspaceApi.writeFile(sessionId, tab.path, finalContent)
        useExplorerStore.getState().markSaved(tab.path, finalContent)
      } catch (e: any) {
        message.error(`保存 ${tab.name} 失败: ${e.message}`)
      }
    }
  }, [sessionId, message])

  // ── Listen for close-dirty-tab event ─────────────────────────────────────

  useEffect(() => {
    const handler = (e: Event) => {
      const { path } = (e as CustomEvent).detail
      setUnsavedPath(path)
    }
    window.addEventListener('editor:close-dirty-tab', handler)
    return () => window.removeEventListener('editor:close-dirty-tab', handler)
  }, [])

  // ── Sync document title ───────────────────────────────────────────────────

  useEffect(() => {
    if (!activeTab) {
      document.title = 'Agent Engine'
      return
    }
    document.title = activeTab.isDirty
      ? `${activeTab.name}（已编辑） — Agent Engine`
      : `${activeTab.name} — Agent Engine`
  }, [activeTab])

  // ─────────────────────────────────────────────────────────────────────────

  if (!activeTab || activeTab.type !== 'text') return null

  return (
    <>
      {loadingContent ? (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#666' }}>
          加载中...
        </div>
      ) : (
        // key={activeTab.path} 确保切换文件时 Monaco 实例完全重建，
        // defaultValue（非受控）避免 value → onChange → setState → re-render 循环
        <Editor
          key={activeTab.path}
          height="100%"
          language={getLanguage(activeTab.name)}
          defaultValue={initialContent}
          theme="vs-dark"
          onMount={handleMount}
          onChange={val => {
            // 仅通知 store 该 tab 有未保存内容，不回写 state
            markDirty(activeTab.path)
            // 同步到 savedContent ref（供 save-all 使用）
            useExplorerStore.getState().updateDirtyContent(activeTab.path, val ?? '')
          }}
          options={{
            fontSize: 13,
            fontFamily: "'Cascadia Code', 'Fira Code', Consolas, monospace",
            lineNumbers: 'on',
            minimap: { enabled: true },
            scrollBeyondLastLine: false,
            wordWrap: 'off',
            tabSize: 2,
            insertSpaces: true,
            automaticLayout: true,
            smoothScrolling: true,
            cursorBlinking: 'phase',
          }}
        />
      )}

      {/* UnsavedDialog */}
      {unsavedPath && (
        <UnsavedDialog
          path={unsavedPath}
          onSave={async () => {
            const tab = useExplorerStore.getState().tabs.find(t => t.path === unsavedPath)
            if (tab?.savedContent) {
              await workspaceApi.writeFile(sessionId, unsavedPath, tab.savedContent)
              markSaved(unsavedPath)
            }
            closeTab(unsavedPath)
            setUnsavedPath(null)
          }}
          onDiscard={() => {
            closeTab(unsavedPath)
            setUnsavedPath(null)
          }}
          onCancel={() => setUnsavedPath(null)}
        />
      )}
    </>
  )
}
