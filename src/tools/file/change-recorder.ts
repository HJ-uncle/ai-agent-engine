import fs from 'node:fs'
import path from 'node:path'
import type { AgentContext } from '../../core/agent-context/index.js'
import { ChangeStore } from '../../storage/changes/index.js'

/**
 * 文件改动快照：write_file / delete_file 执行前后记录旧/新内容，
 * 供客户端渲染 git 风格 diff 与「改动确认 / 撤回」面板。
 *
 * 设计约束：
 * - 内容超过 100KB 或二进制格式只记元数据（truncated=true），这类改动无法回退；
 * - 记录失败绝不影响工具本身的成功/失败（catch 后返回 undefined）。
 */

const changeStore = new ChangeStore()

const MAX_CONTENT_CHARS = 100_000

/** 内容没有文本比对意义的格式：只记改动发生这一事实 */
const BINARY_EXTENSIONS = new Set([
  '.xlsx', '.xls', '.docx', '.doc', '.pdf',
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp',
  '.zip', '.gz', '.7z', '.rar', '.tar',
  '.exe', '.dll', '.so', '.dylib', '.node',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.mp3', '.mp4', '.avi', '.mov', '.wav', '.flac'
])

export interface ChangeSnapshot {
  oldContent: string | null
  truncated: boolean
}

/** 执行前调用：读旧内容快照。文件不存在 → null（新建文件）；超限/二进制 → null + truncated */
export function readOldSnapshot(absPath: string): ChangeSnapshot {
  try {
    if (!fs.existsSync(absPath)) return { oldContent: null, truncated: false }
    const stat = fs.statSync(absPath)
    if (!stat.isFile()) return { oldContent: null, truncated: false }
    if (BINARY_EXTENSIONS.has(path.extname(absPath).toLowerCase()) || stat.size > MAX_CONTENT_CHARS) {
      return { oldContent: null, truncated: true }
    }
    return { oldContent: fs.readFileSync(absPath, 'utf-8'), truncated: false }
  } catch {
    return { oldContent: null, truncated: true }
  }
}

/** 写入 data 的可存档形态：仅纯文本字符串保留内容，其余（xlsx/docx 模板对象等）只记元数据 */
function pickNewContent(data: unknown): { newContent: string | null; truncated: boolean } {
  if (typeof data === 'string') {
    if (data.length > MAX_CONTENT_CHARS) return { newContent: null, truncated: true }
    return { newContent: data, truncated: false }
  }
  return { newContent: null, truncated: true }
}

/** write_file 成功后调用：落库 + 组装 ToolResult.change（含 isNew 供前端区分「新建/编辑」） */
export async function commitWriteChange(
  ctx: AgentContext,
  displayPath: string,
  absPath: string,
  data: unknown,
  snapshot: ChangeSnapshot
): Promise<Record<string, unknown> | undefined> {
  try {
    const picked = pickNewContent(data)
    const change = await changeStore.record(ctx.tenantId, {
      sessionId: ctx.sessionId,
      path: absPath,
      kind: 'write',
      oldContent: snapshot.oldContent,
      newContent: picked.newContent,
      truncated: snapshot.truncated || picked.truncated
    })
    return { ...change, displayPath, isNew: snapshot.oldContent === null && !snapshot.truncated }
  } catch (err) {
    ctx.logger.warn({ err }, '[change-recorder] 记录 write 改动失败（不影响工具结果）')
    return undefined
  }
}

/** delete_file 成功后调用：落库 + 组装 ToolResult.change */
export async function commitDeleteChange(
  ctx: AgentContext,
  displayPath: string,
  absPath: string
): Promise<Record<string, unknown> | undefined> {
  try {
    const snapshot = readOldSnapshot(absPath)
    const change = await changeStore.record(ctx.tenantId, {
      sessionId: ctx.sessionId,
      path: absPath,
      kind: 'delete',
      oldContent: snapshot.oldContent,
      newContent: null,
      truncated: snapshot.truncated
    })
    return { ...change, displayPath, isNew: false }
  } catch (err) {
    ctx.logger.warn({ err }, '[change-recorder] 记录 delete 改动失败（不影响工具结果）')
    return undefined
  }
}
