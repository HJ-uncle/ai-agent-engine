import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const configDirectory = dirname(fileURLToPath(import.meta.url))

// Playwright runs from the sibling frontend; the engine has no Playwright dependency.
export default {
  testDir: resolve(configDirectory, '../../../aether-code/e2e'),
  timeout: 180000,
  expect: { timeout: 20000 },
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [['line']],
  outputDir: resolve(configDirectory, '../../.e2e-tmp/remote-results'),
  use: { trace: 'retain-on-failure' },
}
