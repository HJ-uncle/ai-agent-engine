import React from 'react';
import ReactDOM from 'react-dom/client';
import './tokens.css';
import './index.css';
import App from './App';

// ── 同步应用主题（在 React 挂载前）— 避免 FOUC ───────────────────
(function initTheme() {
  try {
    const saved = localStorage.getItem('ui.themeMode') as 'dark' | 'light' | 'system' | null
    const mode = saved ?? 'dark'
    let applied: 'dark' | 'light'
    if (mode === 'system') {
      applied = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
    } else {
      applied = mode
    }
    document.documentElement.setAttribute('data-theme', applied)
  } catch {
    document.documentElement.setAttribute('data-theme', 'dark')
  }
})()

const root = ReactDOM.createRoot(
  document.getElementById('root') as HTMLElement
);
root.render(
    <App />
);
