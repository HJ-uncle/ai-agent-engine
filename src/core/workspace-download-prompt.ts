/** Keep the actual system prompt and its token estimate on the same download contract. */
export function buildWorkspaceDownloadPrompt(sessionId: string): string {
  const examplePath = 'finance/deliverables/v001/财务报告 2026.xlsx'
  const query = new URLSearchParams({ sessionId, path: examplePath }).toString()
  return `4. When providing a downloadable file, use an HTTP Markdown download link. The \`path\` query value must be the file's exact path relative to this session's bound main workspace root, preserving every directory level; it is NOT relative to a role's subdirectory or a command's cwd. Derive it from a successful tool result and the bound root; never replace it with only the basename or guess a matching file.
   Encode each query value exactly once (for example, with \`new URLSearchParams({ sessionId, path: relativePath })\`), so Chinese characters, spaces, &, #, +, % and parentheses remain part of the path. Use forward slashes in relative paths. Never use file:// URLs or ../ to escape the bound workspace.
   Example only: if the bound root is company and the confirmed file is company/${examplePath}, the link is:
   [财务报告 2026.xlsx](/api/v1/workspace/file/download?${query})
   Replace the example path and label with the actual confirmed artifact. If the file is outside the bound workspace or its exact location is unverified, report that limitation instead of fabricating a download link.`
}
