import path from 'node:path'
import { canonicalFilePathSync } from '../../shared/file-version.js'
import { workspaceManager } from '../../workspace/index.js'

type WorkspaceContext = Parameters<typeof workspaceManager.getPaths>[0]
type SavedWorkspace = { workspacePaths: readonly string[]; projectRoot?: string; cwd?: string }

export function workspaceContains(root: string, target: string): boolean {
  const relative = path.relative(canonicalFilePathSync(root), canonicalFilePathSync(target))
  return relative === '' || relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)
}

/** Request paths may be omitted after reconnect; persisted bindings remain authoritative. */
export function captureSubagentWorkspace(ctx: WorkspaceContext) {
  const guard = workspaceManager.bindingReadGuard(ctx)
  const roots = [...new Set(workspaceManager.getPaths(ctx).map(canonicalFilePathSync))]
  guard.assertCurrent()
  return { ...guard, roots }
}

export function continuationWorkspacePaths(saved: SavedWorkspace): string[] {
  return [...new Set([...saved.workspacePaths, ...(saved.projectRoot ? [saved.projectRoot] : []), ...(saved.cwd ? [saved.cwd] : [])])]
}

export function subagentWorkspaceMatches(saved: SavedWorkspace, ctx: WorkspaceContext,
  scope = captureSubagentWorkspace(ctx)): boolean {
  const prior = continuationWorkspacePaths(saved)
  scope.assertCurrent()
  // An empty legacy profile has no evidence of its original workspace.
  return prior.length > 0 && prior.every(root => scope.roots.some(allowed => workspaceContains(allowed, root)))
    && prior.some(root => workspaceContains(root, scope.snapshot.root))
}
