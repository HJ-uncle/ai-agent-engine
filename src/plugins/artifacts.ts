import fs from 'node:fs'
import path from 'node:path'
import type { AgentContext, ToolResult } from '../core/agent-context/types.js'
import { workspaceManager } from '../workspace/index.js'
import { withFileLocks } from '../shared/file-version.js'
import { commitWriteChangeWithReceipt, readOldSnapshot } from '../tools/file/change-recorder.js'
import type { PluginArtifact } from './types.js'
import { throwIfAborted } from '../core/utils/abort.js'

/** Plugin output bytes use the same durable change ledger as built-in file writers. */
export async function emitPluginArtifacts(artifacts: PluginArtifact[], ctx: AgentContext): Promise<ToolResult> {
  if (!artifacts.length) return { success: true, output: '[]', changes: [] }
  const targets = artifacts.map(artifact => workspaceManager.resolveSafePath(ctx, artifact.path))
  const identities = targets.map(file => process.platform === 'win32' ? file.toLowerCase() : file)
  if (new Set(identities).size !== targets.length) return { success: false, output: '插件产物包含重复路径' }
  if (identities.some((file, index) => identities.some((other, otherIndex) => index !== otherIndex && other.startsWith(file + path.sep))))
    return { success: false, output: '插件产物的文件与目录路径互相冲突' }
  return withFileLocks(targets, async () => {
    const changes: Record<string, unknown>[] = [], receipts: unknown[] = []
    // Reject conflicts before creating any part of a multi-file result.
    for (const file of targets) {
      workspaceManager.resolveSafePath(ctx, file)
      if (fs.existsSync(file)) return { success: false, output: `插件产物不会覆盖已有文件：${file}`, changes }
    }
    try {
      for (let index = 0; index < artifacts.length; index++) {
        throwIfAborted(ctx.signal)
        const artifact = artifacts[index], file = targets[index]
        const snapshot = await readOldSnapshot(file)
        if (snapshot.exists) throw new Error(`插件产物路径已被其他操作创建：${artifact.path}`)
        fs.mkdirSync(path.dirname(file), { recursive: true })
        workspaceManager.resolveSafePath(ctx, file)
        fs.writeFileSync(file, Buffer.from(artifact.content, artifact.encoding === 'base64' ? 'base64' : 'utf8'), { flag: 'wx' })
        try {
          const recorded = await commitWriteChangeWithReceipt(ctx, artifact.path, file, snapshot)
          changes.push(recorded.change); receipts.push(recorded.receipt)
        } catch (error) {
          // A newly created file without a ledger entry must not become an invisible artifact.
          fs.unlinkSync(file)
          for (const directory of [...(snapshot.missingParents ?? [])].sort((a, b) => b.length - a.length)) {
            try { fs.rmdirSync(directory) } catch { /* Retain directories another writer is using. */ }
          }
          throw error
        }
      }
      return { success: true, output: JSON.stringify(receipts), changes }
    } catch (error) { return { success: false, output: error instanceof Error ? error.message : String(error), changes } }
  })
}
