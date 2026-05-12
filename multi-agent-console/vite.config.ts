import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import monacoEditorPlugin from 'vite-plugin-monaco-editor'
import tsconfigPaths from 'vite-tsconfig-paths'
import { resolve } from 'path'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    react(),
    tsconfigPaths(),
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
    proxy: {
      '/api': {
        target: 'http://localhost:12323',
        changeOrigin: true,
      },
    },
  },
  define: {
    'process.env': {},
  }
})
