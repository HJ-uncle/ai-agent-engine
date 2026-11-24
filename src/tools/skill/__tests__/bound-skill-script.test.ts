// Real script side effects, binding rejection and canonical path escape; no external model or service.
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentContext } from '../../../core/agent-context/types.js'
import { createBoundSkillScriptTool } from '../bound-skill-script.js'
import { runSkillScriptTool } from '../run-skill-script.js'
import { clearSecurityMode, setSecurityMode } from '../../../security/policy-engine.js'

const parentDir = path.resolve('.e2e-tmp', 'bound-skill-scripts')
let fixture: string
let skillsRoot: string
let parent: AgentContext
let tool: ReturnType<typeof createBoundSkillScriptTool>
beforeEach(() => {
  fs.mkdirSync(parentDir, { recursive: true })
  fixture = fs.mkdtempSync(path.join(parentDir, 'aether-bound-skill-'))
  vi.stubEnv('AETHER_GLOBAL_DIR', path.join(fixture, 'global'))
  skillsRoot = path.join(fixture, 'skills')
  for (const name of ['bound', 'unbound']) {
    fs.mkdirSync(path.join(skillsRoot, name, 'scripts'), { recursive: true })
    fs.writeFileSync(path.join(skillsRoot, name, 'SKILL.md'), '# ' + name)
    fs.writeFileSync(path.join(skillsRoot, name, 'scripts', 'write.cjs'), "require('node:fs').writeFileSync(process.argv[2], process.argv[3] || 'script effect');")
  }
  vi.stubEnv('SKILLS_ROOT', skillsRoot)
  parent = { tenantId: 'skill-tenant', sessionId: 'skill-parent', projectRoot: fixture } as AgentContext
  setSecurityMode(parent.tenantId, parent.sessionId, 'standard')
  tool = createBoundSkillScriptTool([{ name: 'bound', description: 'Selected skill', enabled: true, order: 1, skillMdPath: path.join(skillsRoot, 'bound', 'SKILL.md') }])
})
afterEach(() => {
  clearSecurityMode(parent.tenantId, parent.sessionId)
  vi.unstubAllEnvs()
  if (path.dirname(fs.realpathSync(fixture)) !== fs.realpathSync(parentDir) || !path.basename(fixture).startsWith('aether-bound-skill-')) throw new Error('Unsafe fixture cleanup')
  fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 3 })
})
describe('bound custom-Agent script capabilities', () => {
  it.each([
    'node "$SKILLS_ROOT/unbound/scripts/write.cjs"',
    'node "$SKILLS_ROOT/bound/../unbound/scripts/write.cjs"',
    'node -e "require(\'fs\').writeFileSync(\'UNEXPECTED\',\'effect\')"',
    'node "$SKILLS_ROOT/bound/scripts/write.cjs"; node "$SKILLS_ROOT/unbound/scripts/write.cjs"',
    'node "$SKILLS_ROOT/bound/scripts/write.cjs" | node "$SKILLS_ROOT/unbound/scripts/write.cjs"',
  ])('rejects unbound scripts or shell programs before any process side effect: %s', async command => {
    const output = path.join(fixture, 'forbidden.txt')
    const result = await tool.execute({ command: `${command} "${output}"` }, parent)
    expect(result).toMatchObject({ success: false, metadata: { blocked: true, code: 'SKILL_BINDING_REQUIRED' } })
    expect(fs.existsSync(output)).toBe(false)
  })
  it('rejects a bound path whose junction resolves into an unbound skill', async context => {
    const link = path.join(skillsRoot, 'bound', 'linked')
    try { fs.symlinkSync(path.join(skillsRoot, 'unbound'), link, process.platform === 'win32' ? 'junction' : 'dir') }
    catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'EPERM') { context.skip(); return }
      throw error
    }
    const output = path.join(fixture, 'escaped.txt')
    const result = await tool.execute({ command: `node "$SKILLS_ROOT/bound/linked/scripts/write.cjs" "${output}"` }, parent)
    expect(result).toMatchObject({ success: false, metadata: { code: 'SKILL_BINDING_REQUIRED' } })
    expect(fs.existsSync(output)).toBe(false)
  })
  it('executes an actual bound script while quoting shell-like arguments literally', async () => {
    if (process.platform === 'win32') vi.stubEnv('BASH_PATH', path.join(fixture, 'no-bash.exe'))
    const output = path.join(fixture, 'bound-result.txt')
    const quoted = `quoted ; $(touch escaped) ' value`
    const result = await tool.execute({ command: `node "$SKILLS_ROOT/bound/scripts/write.cjs" "${output.replace(/\\/g, '/')}" "${quoted}"` }, parent)
    expect(result.success, result.output).toBe(true)
    expect(fs.readFileSync(output, 'utf8')).toBe(quoted)
    expect(fs.existsSync(path.join(skillsRoot, 'escaped'))).toBe(false)
  }, 15_000)

  it.skipIf(process.platform !== 'win32')('runs a plain Node skill without Bash and preserves shell evaluation for expressions', async () => {
    vi.stubEnv('BASH_PATH', path.join(fixture, 'no-bash.exe'))
    const output = path.join(fixture, '普通 result.txt').replace(/\\/g, '/')
    const command = 'node "$SKILLS_ROOT/bound/scripts/write.cjs" "' + output + '"'
    const result = await runSkillScriptTool.execute({ command: command + ' "space & literal"' }, parent)
    expect(result.success, result.output).toBe(true)
    expect(fs.readFileSync(output, 'utf8')).toBe('space & literal')
    for (const suffix of [' | cat', ' "$HOME"', ' > ignored', ' *.cjs', '\nnext_line']) {
      const attempt = await runSkillScriptTool.execute({ command: command + suffix }, parent)
      expect(attempt).toMatchObject({ success: false, output: expect.stringContaining('no-bash.exe') })
    }
  })

  it.skipIf(process.platform !== 'win32' || !process.env.AETHER_TEST_PYTHON)('runs both ordinary and bound Python skills on the selected real Python without Bash', async () => {
    const python = fs.realpathSync(process.env.AETHER_TEST_PYTHON!)
    vi.stubEnv('PATH', [path.dirname(python), process.env.PATH].join(path.delimiter))
    vi.stubEnv('BASH_PATH', path.join(fixture, 'no-bash.exe'))
    fs.writeFileSync(path.join(skillsRoot, 'bound', 'scripts', 'echo.py'), 'import json, sys\nprint(json.dumps([sys.executable, *sys.argv[1:]]))')
    for (const runner of [tool, runSkillScriptTool]) {
      const result = await runner.execute({ command: 'python "$SKILLS_ROOT/bound/scripts/echo.py" "space & 中文"' }, parent)
      expect(result.success, result.output).toBe(true)
      expect(JSON.parse(result.output)).toEqual([python, 'space & 中文'])
    }
  })
})
