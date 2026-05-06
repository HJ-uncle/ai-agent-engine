import { describe, it, expect, vi, beforeEach } from 'vitest'
import path from 'node:path'
import fs from 'node:fs'
import { smartReadFileTool } from '../smart-read.js'
import { workspaceManager } from '../../../workspace/index.js'

vi.mock('../../../workspace/index.js', () => ({
  workspaceManager: {
    resolveSafePath: vi.fn(),
  },
}))

describe('smartReadFileTool', () => {
  const mockCtx = {
    logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn() },
  } as any

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('should have correct name and description', () => {
    expect(smartReadFileTool.name).toBe('smart_read')
    expect(smartReadFileTool.displayName).toBe('智能文件读取')
  })

  it('should return error if file not found', async () => {
    vi.mocked(workspaceManager.resolveSafePath).mockReturnValue('/fake/path.txt')
    const result = await smartReadFileTool.execute({ path: 'path.txt' }, mockCtx)
    expect(result.success).toBe(false)
    expect(result.output).toContain('File not found')
  })
})
