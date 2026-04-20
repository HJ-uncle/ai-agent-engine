import React from 'react'
import ReactDOM from 'react-dom/client'
import { ConfigProvider, theme } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import App from './App'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ConfigProvider
      locale={zhCN}
      theme={{
        algorithm: theme.darkAlgorithm,
        token: {
          colorPrimary: '#1677ff',
          colorBgBase: '#0d1117',
          colorBgContainer: '#161b22',
          colorBgLayout: '#0d1117',
          borderRadius: 8,
          fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, "Microsoft YaHei", sans-serif',
        },
        components: {
          Conversations: { colorBgContainer: 'transparent' },
        },
      }}
    >
      <App />
    </ConfigProvider>
  </React.StrictMode>,
)
