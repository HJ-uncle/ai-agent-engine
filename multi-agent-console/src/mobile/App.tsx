import React, { useEffect } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import ChatPage from './pages/ChatPage'
import MeSettingsPage from './pages/MeSettingsPage'
import { SettingsRoutes } from './pages/SettingsRoutes'
import { useSessionStore } from '@core/store/session'
import { useAgentStore } from '@core/store/agents'
import { conversationApi, deepseekApi, agentApi } from '@core/api'
import './styles/index.css'

/**
 * 移动端路由架构（千问风格）：
 *
 *   /       → /chat（重定向）
 *   /chat   → ChatPage（主界面，内置左抽屉会话历史 + Agent Popup）
 *   /me     → MeSettingsPage（个人/设置，从 NavBar 头像进入）
 *   /settings/* → 设置子路由
 *
 * SessionsDrawer / AgentPicker 作为 ChatPage 内的 Popup/Drawer，
 * 不独立成路由，避免不必要的页面跳转。
 */
export default function MobileApp() {
  // ── 启动时拉取远端会话列表，补全本地未同步的历史会话 ──────────────────────
  useEffect(() => {
    ;(async () => {
      try {
        const result = await conversationApi.listSessions()
        const remote = result.list ?? []
        if (remote.length === 0) return

        useSessionStore.setState((state) => {
          const msgMap   = { ...state.messageMap }
          const usageMap = { ...state.usageMap }

          remote.forEach((r) => {
            if (r.totalUsage) {
              usageMap[r.sessionId] = r.totalUsage as any
            }
          })

          const existingIds = new Set(state.sessions.map((s) => s.id))
          const newSessions = remote
            .filter((s) => !existingIds.has(s.sessionId))
            .map((s) => ({
              id: s.sessionId,
              title: s.lastMessage
                ? s.lastMessage.slice(0, 24) + (s.lastMessage.length > 24 ? '...' : '')
                : '历史对话',
              createdAt: s.lastAt,
              lastMessage: s.lastMessage,
            }))

          if (!newSessions.length) return { usageMap }

          const merged = [...newSessions, ...state.sessions].sort(
            (a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0)
          )
          newSessions.forEach((s) => {
            if (!msgMap[s.id])   msgMap[s.id]   = []
            if (!usageMap[s.id]) usageMap[s.id] = null
          })
          return { sessions: merged, messageMap: msgMap, usageMap }
        })
      } catch {
        /* 离线时静默失败 */
      }
    })()
  }, [])

  // ── 启动时拉取 DeepSeek 有效价格（供成本估算使用） ─────────────────────────
  useEffect(() => {
    ;(async () => {
      try {
        const data = await deepseekApi.getPrices()
        if (data?.models) {
          const priceMap: Record<string, any> = {}
          for (const m of data.models) {
            if (m.effectivePrice) priceMap[m.modelId] = m.effectivePrice
          }
          useSessionStore.getState().setDeepSeekPrices(priceMap)
        }
      } catch {
        /* DeepSeek 未配置，忽略 */
      }
    })()
  }, [])

  // ── 启动时拉取 Agent 列表（确保 AgentPicker 有数据，不依赖本地缓存）───────
  useEffect(() => {
    ;(async () => {
      try {
        useAgentStore.getState().setLoading(true)
        const { list } = await agentApi.list({ pageSize: 100 })
        if (list && list.length > 0) {
          useAgentStore.getState().setAgents(list)
        }
      } catch {
        /* 离线时使用 localStorage 缓存 */
      } finally {
        useAgentStore.getState().setLoading(false)
      }
    })()
  }, [])

  return (
    <BrowserRouter basename="/m">
      <Routes>
        <Route path="/"           element={<Navigate to="/chat" replace />} />
        <Route path="/chat"       element={<ChatPage />} />
        <Route path="/me"         element={<MeSettingsPage />} />
        <Route path="/settings/*" element={<SettingsRoutes />} />
        {/* 404 → 回主页 */}
        <Route path="*"           element={<Navigate to="/chat" replace />} />
      </Routes>
    </BrowserRouter>
  )
}
