import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // Scratch probes and the legacy multi-agent-console package have their
    // own dependency/test runners.  Discovering them from the engine root
    // makes `npm test` execute Playwright helpers and UI tests with the wrong
    // dependency graph, producing false failures and hiding the engine
    // regression result.
    exclude: ['**/node_modules/**', '**/dist/**', '**/e2e/**', '**/.e2e-tmp/**', 'multi-agent-console/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      exclude: ['node_modules/', 'dist/', '**/*.test.ts'],
    },
  },
})
