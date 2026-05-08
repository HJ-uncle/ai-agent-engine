import React from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { MobileLayout } from './components/MobileLayout'
import ChatPage from './pages/ChatPage'
import SessionsPage from './pages/SessionsPage'
import AgentsPage from './pages/AgentsPage'
import MeSettingsPage from './pages/MeSettingsPage'
import { SettingsRoutes } from './pages/SettingsRoutes'
import './styles/index.css'

export default function MobileApp() {
  return (
    <BrowserRouter basename="/m">
      <Routes>
        {/* 默认跳转到对话页 */}
        <Route path="/" element={<Navigate to="/chat" replace />} />

        {/* TabBar 主路由 */}
        <Route element={<MobileLayout />}>
          <Route path="/chat"     element={<ChatPage />} />
          <Route path="/sessions" element={<SessionsPage />} />
          <Route path="/agents"   element={<AgentsPage />} />
          <Route path="/me"       element={<MeSettingsPage />} />
        </Route>

        {/* 设置二级路由（无 TabBar）*/}
        <Route path="/settings/*" element={<SettingsRoutes />} />
      </Routes>
    </BrowserRouter>
  )
}
