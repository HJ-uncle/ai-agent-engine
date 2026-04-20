import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import electron from 'vite-plugin-electron'
import renderer from 'vite-plugin-electron-renderer'
import path from 'path'

export default defineConfig({
  plugins: [
    react(),
    electron([
      {
        // Main process — 负责启动 Electron
        entry: 'src/main/index.ts',
        vite: {
          build: { outDir: 'dist-electron' },
        },
      },
      {
        // Preload script — 仅编译，不触发 Electron 启动/reload
        entry: 'src/main/preload.ts',
        vite: {
          build: { outDir: 'dist-electron' },
        },
        onstart() {
          // 什么都不做：preload 变化只需重新编译，由主窗口的 webContents 自动使用新 preload
        },
      },
    ]),
    renderer(),
  ],
  server: {
    port: 5600,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
        // 禁用代理缓冲，确保 SSE 数据实时转发
        configure: (proxy) => {
          proxy.on('proxyReq', (_proxyReq, _req, res) => {
            res.setHeader('X-Accel-Buffering', 'no')
          })
          proxy.on('proxyRes', (proxyRes) => {
            proxyRes.headers['cache-control'] = 'no-cache'
            proxyRes.headers['x-accel-buffering'] = 'no'
          })
        },
      },
    },
  },
  resolve: {
    alias: { '@': path.resolve(__dirname, 'src/renderer') },
  },
})
