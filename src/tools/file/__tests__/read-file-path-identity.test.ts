/** Regresses real office reviewers receiving another role/version's issues.json
 * when their absolute requested v002 file had not been generated yet. */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentContext } from '../../../core/agent-context/index.js'
import { clearSecurityMode, setSecurityMode } from '../../../security/policy-engine.js'
import { hashFileContent } from '../../../shared/file-version.js'
import { readFileTool } from '../super-file-tool.js'

let root: string, ctx: AgentContext
function fixture(relative: string, value: string) {
  const file = path.join(root, relative)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, value)
  return file
}
beforeEach(() => {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'aether-read-identity-')))
  vi.stubEnv('AUTH_ENABLED', 'false')
  ctx = { tenantId: 'read-identity-tenant', sessionId: path.basename(root), workspacePaths: [root], projectRoot: root, cwd: root,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } } as unknown as AgentContext
  setSecurityMode(ctx.tenantId, ctx.sessionId, 'safe')
})
afterEach(() => {
  clearSecurityMode(ctx.tenantId, ctx.sessionId)
  vi.restoreAllMocks(); vi.unstubAllEnvs()
  if (path.dirname(root) !== fs.realpathSync.native(os.tmpdir()) || !path.basename(root).startsWith('aether-read-identity-')) throw new Error('Unsafe fixture cleanup')
  fs.rmSync(root, {recursive:true, force:true, maxRetries:3, retryDelay:20})
})

describe('read_file keeps requested path identity in every read mode', () => {
  it.each(['auto','full','summary','vision','ocr','exact'])('does not replace a missing absolute v002 file with another role/version in %s', async mode => {
    fixture('sales/evidence/v001/issues.json', '{"owner":"SALES_OLD"}')
    const other = fixture('people/evidence/v002/issues.json', '{"owner":"PEOPLE_PRIVATE"}')
    fs.utimesSync(other, new Date(), new Date(Date.now()+60_000))
    const requested = path.join(root, 'sales/evidence/v002/issues.json')
    const enumeration = vi.spyOn(fs, 'readdirSync')
    const result = await readFileTool.execute({path:requested,mode},ctx)
    expect(result).toMatchObject({success:false,error:'FILE_NOT_FOUND',metadata:{requestedPath:requested}})
    expect(result.output).not.toMatch(/PEOPLE_PRIVATE|SALES_OLD/)
    expect(result.metadata).not.toHaveProperty('expectedHash')
    expect(enumeration).not.toHaveBeenCalled()
    expect(fs.existsSync(requested)).toBe(false)
  })
  it.each(['sales/evidence/v002/issues.json','issues.json','issues','issue'])('does not guess relative paths, basenames, stems or substrings: %s', async requested => {
    fixture('people/evidence/v002/issues.json', '{"owner":"PEOPLE_PRIVATE"}')
    expect(await readFileTool.execute({path:requested},ctx)).toMatchObject({success:false,error:'FILE_NOT_FOUND'})
  })
  it('reads the selected older revision even when a same-name newer file exists', async () => {
    const selectedText = '{"owner":"sales","revision":"v001"}'
    const selected = fixture('sales/evidence/v001/issues.json', selectedText)
    const other = fixture('people/evidence/v002/issues.json', '{"owner":"PEOPLE_PRIVATE"}')
    fs.utimesSync(other, new Date(), new Date(Date.now()+60_000))
    for (const requested of [selected, 'sales/evidence/v001/issues.json']) {
      const result=await readFileTool.execute({path:requested},ctx)
      expect(result).toMatchObject({success:true,metadata:{path:selected,expectedHash:hashFileContent(selectedText)}})
      expect(result.output).toContain('sales'); expect(result.output).not.toContain('PEOPLE_PRIVATE')
    }
  })
  it('returns a path authorization failure rather than reading an in-root namesake', async () => {
    fixture('allowed/issues.json','{"owner":"WRONG_SUBSTITUTE"}')
    const enumeration=vi.spyOn(fs,'readdirSync')
    const result=await readFileTool.execute({path:path.join(root,'..','outside','issues.json')},ctx)
    expect(result.success).toBe(false)
    expect(result.output).toContain('outside any bound workspace')
    expect(result.output).not.toContain('WRONG_SUBSTITUTE')
    expect(enumeration).not.toHaveBeenCalled()
  })
  it('does not search another bound workspace for a missing primary path', async () => {
    const first=path.join(root,'first'), second=path.join(root,'second')
    fs.mkdirSync(first)
    fixture('second/issues.json','{"owner":"SECOND_WORKSPACE"}')
    const multi={...ctx,workspacePaths:[first,second],projectRoot:first,cwd:first}
    expect(await readFileTool.execute({path:'issues.json'},multi)).toMatchObject({success:false,error:'FILE_NOT_FOUND'})
  })
})
