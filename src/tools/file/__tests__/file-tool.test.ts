import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { vi } from 'vitest'

// ─── Setup temp workspace ──────────────────────────────────────────────────────

let tmpDir: string

// We mock workspaceManager before importing the tools
vi.mock('../../../workspace/index.js', () => {
  return {
    workspaceManager: {
      resolveSafePath: (_ctx: unknown, userPath: string) => {
        // Replicate safe-path logic against tmpDir
        const resolved = path.resolve(tmpDir, userPath)
        if (!resolved.startsWith(tmpDir + path.sep) && resolved !== tmpDir) {
          throw new Error(`Path traversal detected: "${userPath}" resolves outside workspace`)
        }
        return resolved
      },
      init: (_ctx: unknown) => {
        return tmpDir
      },
    },
  }
})

// Import after mock
const { readFileTool, writeFileTool, listFilesTool, deleteFileTool, createDirTool } =
  await import('../file-tool.js')

// ─── Minimal AgentContext stub ─────────────────────────────────────────────────

function makeCtx(tenantId = 'tenant-1', sessionId = 'session-1') {
  return { tenantId, sessionId } as any
}

// ─── Lifecycle ─────────────────────────────────────────────────────────────────

beforeEach(() => {
  // Create a unique temp directory for each test
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-engine-test-'))
})

afterEach(() => {
  // Clean up temp directory
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('write_file + read_file', () => {
  it('writes a file and reads back the same content', async () => {
    const ctx = makeCtx()
    const content = 'Hello, Agent Engine!'

    const writeResult = await writeFileTool.execute({ path: 'hello.txt', content }, ctx)
    expect(writeResult.success).toBe(true)

    const readResult = await readFileTool.execute({ path: 'hello.txt' }, ctx)
    expect(readResult.success).toBe(true)
    expect(readResult.output).toBe(content)
  })
})

describe('read_file', () => {
  it('returns success:false when reading a non-existent file', async () => {
    const ctx = makeCtx()
    const result = await readFileTool.execute({ path: 'nonexistent.txt' }, ctx)
    expect(result.success).toBe(false)
  })
})

describe('list_files', () => {
  it('lists files in the workspace directory', async () => {
    const ctx = makeCtx()

    // Create a couple of files
    fs.writeFileSync(path.join(tmpDir, 'a.txt'), 'a')
    fs.writeFileSync(path.join(tmpDir, 'b.txt'), 'b')

    const result = await listFilesTool.execute({ path: '.' }, ctx)
    expect(result.success).toBe(true)
    expect(result.output).toContain('a.txt')
    expect(result.output).toContain('b.txt')
  })

  it('recursively lists files when recursive=true', async () => {
    const ctx = makeCtx()

    // Create nested structure
    const subDir = path.join(tmpDir, 'subdir')
    fs.mkdirSync(subDir, { recursive: true })
    fs.writeFileSync(path.join(tmpDir, 'root.txt'), 'root')
    fs.writeFileSync(path.join(subDir, 'nested.txt'), 'nested')

    const result = await listFilesTool.execute({ path: '.', recursive: true }, ctx)
    expect(result.success).toBe(true)
    expect(result.output).toContain('root.txt')
    expect(result.output).toContain('nested.txt')
  })
})

describe('delete_file', () => {
  it('deletes a file so that subsequent read returns success:false', async () => {
    const ctx = makeCtx()

    // Write a file first
    fs.writeFileSync(path.join(tmpDir, 'to-delete.txt'), 'bye')

    const deleteResult = await deleteFileTool.execute({ path: 'to-delete.txt' }, ctx)
    expect(deleteResult.success).toBe(true)

    const readResult = await readFileTool.execute({ path: 'to-delete.txt' }, ctx)
    expect(readResult.success).toBe(false)
  })
})

describe('create_dir', () => {
  it('creates a directory in the workspace', async () => {
    const ctx = makeCtx()

    const result = await createDirTool.execute({ path: 'my-new-dir' }, ctx)
    expect(result.success).toBe(true)

    const dirPath = path.join(tmpDir, 'my-new-dir')
    expect(fs.existsSync(dirPath)).toBe(true)
    expect(fs.statSync(dirPath).isDirectory()).toBe(true)
  })
})

describe('read_file path traversal', () => {
  it('returns success:false on path traversal attack (does not throw)', async () => {
    const ctx = makeCtx()
    const result = await readFileTool.execute({ path: '../../etc/passwd' }, ctx)
    expect(result.success).toBe(false)
    expect(result.output).toMatch(/Path traversal detected/)
  })
})
