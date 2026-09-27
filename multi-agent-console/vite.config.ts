import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import monacoEditorPlugin from 'vite-plugin-monaco-editor'
import { resolve } from 'path'

// https://vitejs.dev/config/
export default defineConfig({
  resolve: {
    tsconfigPaths: true,
    alias: {
      '@core': resolve(__dirname, 'src/core'),
      '@web': resolve(__dirname, 'src/web'),
      '@mobile': resolve(__dirname, 'src/mobile'),
    },
  },
  plugins: [
    react(),
    monacoEditorPlugin({
      languageWorkers: [
        'typescript', 'editorWorkerService', 'json', 'html', 'css'
      ]
    }),
    // ── 移动端路由历史回退支持 ──────────────────────────────────
    // 当访问 /m/* 且不是静态资源时，重写到 /m.html 以支持移动端 SPA
    {
      name: 'mobile-history-fallback',
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (req.url && req.url.startsWith('/m/') && !req.url.includes('.')) {
            req.url = '/m.html'
          }
          next()
        })
      }
    }
  ],
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        mobile: resolve(__dirname, 'm.html'),
      },
    },
    outDir: 'dist',
  },
  server: {
    port: 3010,
    host: true,
    proxy: {
      '/api': {
        target: 'http://localhost:12323',
        changeOrigin: true,
      },
    },
  },
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV),
  }
})
