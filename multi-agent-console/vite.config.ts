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
    })
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
    port: 3000,
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
