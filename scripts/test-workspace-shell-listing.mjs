/**
 * Focused regression check for the Workspace Shell `ll` presentation.
 *
 * The shell is an interactive process, so this intentionally uses a pipe as
 * the smallest deterministic harness.  PTY-specific resize coverage belongs
 * to the client terminal suite; this check locks the table order, compact
 * content width, and the responsive fallback's observable labels.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const shell = path.join(root, 'src', 'terminal', 'workspace-shell.mjs')
const tempRoot = fs.mkdtempSync(path.join(root, '.e2e-tmp', 'shell-listing-'))

function stripAnsi(value) {
  return value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\r/g, '')
}

function runShell(workspace, command) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [shell], {
      cwd: workspace,
      env: { ...process.env, WORKSPACE_ROOT: workspace, WORKSPACE_ROOTS: JSON.stringify([workspace]) },
      windowsHide: true,
      stdio: 'pipe',
    })
    let output = ''
    let settled = false
    let sent = false
    const finish = (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) reject(error); else resolve(stripAnsi(output))
    }
    const timer = setTimeout(() => {
      child.kill()
      finish(new Error('Workspace Shell listing test timed out'))
    }, 8000)
    child.stdout.on('data', chunk => {
      output += chunk.toString()
      if (!sent && output.includes('Tab 补全')) { sent = true; child.stdin.write(`${command}\n`) }
      if (output.includes('共 2 项')) {
        if (!child.stdin.destroyed) child.stdin.end()
        setTimeout(() => finish(), 20)
      }
    })
    child.stderr.on('data', chunk => { output += chunk.toString() })
    child.once('error', finish)
    child.once('exit', code => {
      if (!settled && code !== 0) finish(new Error(`Workspace Shell exited with ${code}: ${stripAnsi(output).slice(-500)}`))
    })
  })
}

try {
  fs.writeFileSync(path.join(tempRoot, 'alpha.txt'), 'alpha\n')
  fs.writeFileSync(path.join(tempRoot, 'beta.md'), 'beta\n')
  const output = await runShell(tempRoot, 'll')
  const lines = output.split('\n')
  const headerIndex = lines.findIndex(line => line.includes('名称') && line.includes('类型') && line.includes('大小') && line.includes('修改时间'))
  assert.ok(headerIndex >= 0, 'll should expose a labelled table header')
  assert.ok(lines[headerIndex].indexOf('名称') < lines[headerIndex].indexOf('类型'), 'name should remain the first column')
  const separator = lines[headerIndex + 1]?.trim() ?? ''
  assert.match(separator, /^─+$/, 'll should draw a visual separator below the header')
  assert.ok(separator.length < 79, 'separator should follow content width instead of filling the terminal')
  assert.ok(lines.some(line => line.includes('alpha.txt') && line.includes('文件')), 'first file row should align with its type')
  assert.ok(lines.some(line => line.includes('beta.md') && line.includes('文件')), 'second file row should align with its type')
  assert.ok(lines.some(line => line.includes('共 2 项')), 'listing count should remain visible')
  console.log('Workspace Shell ll listing presentation: PASS')
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true })
}
