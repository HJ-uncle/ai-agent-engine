import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

/** Lightweight unit-test config for the console's framework-independent core. */
export default defineConfig({
  resolve: {
    alias: {
      '@core': resolve(__dirname, 'src/core'),
      '@web': resolve(__dirname, 'src/web'),
      '@mobile': resolve(__dirname, 'src/mobile'),
    },
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
})

