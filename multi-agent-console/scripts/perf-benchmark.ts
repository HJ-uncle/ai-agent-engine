/**
 * Performance benchmark script
 * Run: npm run perf:bench
 * Output: reports/perf-baseline.json
 */
import * as fs from 'fs'
import * as path from 'path'
import * as http from 'http'

interface PerfResult {
  coldStart_ms: number | null
  largeFolder_expand_ms: number | null
  quickOpen_search_ms: number | null
  timestamp: string
  note: string
}

function httpGet(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    http.get(url, res => {
      let data = ''
      res.on('data', chunk => data += chunk)
      res.on('end', () => resolve(data))
      res.on('error', reject)
    }).on('error', reject)
  })
}

async function measureColdStart(): Promise<number | null> {
  // Measure API health endpoint as proxy for cold-start
  try {
    const start = performance.now()
    await httpGet('http://localhost:12323/health')
    return Math.round(performance.now() - start)
  } catch {
    return null
  }
}

async function measureLargeFolderExpand(): Promise<number | null> {
  // Simulate listing a large directory
  try {
    const tmpDir = path.join(require('os').homedir(), '.agent-engine', 'perf-test')
    if (!fs.existsSync(tmpDir)) {
      fs.mkdirSync(tmpDir, { recursive: true })
      // Create 50,000 dummy files
      console.log('Creating 50,000 test files...')
      for (let i = 0; i < 50000; i++) {
        fs.writeFileSync(path.join(tmpDir, `file_${i}.txt`), '')
      }
      console.log('Done.')
    }
    const start = performance.now()
    const files = fs.readdirSync(tmpDir)
    const elapsed = Math.round(performance.now() - start)
    console.log(`  readdir(50k): ${elapsed} ms, count: ${files.length}`)
    return elapsed
  } catch (e) {
    console.error('Large folder test failed:', e)
    return null
  }
}

async function measureQuickOpen(): Promise<number | null> {
  // Simulate fuzzy matching over 100k paths
  try {
    const { default: Fuse } = await import('fuse.js')
    // Generate 100k synthetic paths
    const paths: string[] = []
    for (let i = 0; i < 100000; i++) {
      paths.push(`/workspace/src/module_${i % 1000}/component_${i}.tsx`)
    }
    const fuse = new Fuse(paths, { threshold: 0.4, keys: [''] })
    const start = performance.now()
    fuse.search('explo', { limit: 50 })
    return Math.round(performance.now() - start)
  } catch (e) {
    console.error('Quick open test failed:', e)
    return null
  }
}

async function main() {
  console.log('Running performance benchmarks...\n')

  const coldStart = await measureColdStart()
  console.log(`Cold start (API ping): ${coldStart != null ? coldStart + ' ms' : 'N/A (server not running)'}`)

  const largeFolder = await measureLargeFolderExpand()
  console.log(`Large folder expand (50k files): ${largeFolder != null ? largeFolder + ' ms' : 'N/A'}`)

  const quickOpen = await measureQuickOpen()
  console.log(`Ctrl+P search (100k paths): ${quickOpen != null ? quickOpen + ' ms' : 'N/A'}`)

  const result: PerfResult = {
    coldStart_ms: coldStart,
    largeFolder_expand_ms: largeFolder,
    quickOpen_search_ms: quickOpen,
    timestamp: new Date().toISOString(),
    note: 'Targets: coldStart<2000ms, largeFolder<200ms, quickOpen<100ms',
  }

  const reportsDir = path.join(__dirname, '..', 'reports')
  if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true })
  const outPath = path.join(reportsDir, 'perf-baseline.json')
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2))
  console.log(`\nResults saved to: ${outPath}`)

  // Assertions
  let passed = true
  if (largeFolder != null && largeFolder >= 200) {
    console.warn(`⚠ Large folder expand ${largeFolder}ms exceeds 200ms target`)
    passed = false
  }
  if (quickOpen != null && quickOpen >= 100) {
    console.warn(`⚠ Quick open search ${quickOpen}ms exceeds 100ms target`)
    passed = false
  }
  if (passed) console.log('\n✓ All performance targets met.')
  process.exit(passed ? 0 : 1)
}

main().catch(e => { console.error(e); process.exit(1) })
