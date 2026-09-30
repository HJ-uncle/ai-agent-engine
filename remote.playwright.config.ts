import { defineConfig } from '@playwright/test'
export default defineConfig({ testDir: 'D:/dev/aether-code/e2e', timeout: 180000, expect:{timeout:20000}, workers:1, fullyParallel:false, retries:0, reporter:[['line']], outputDir:'D:/dev/ai-agent-engine/.e2e-aether-remote-results', use:{trace:'retain-on-failure'}})
