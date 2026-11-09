/** Shared download contract for transmitted and accounted prompt text. */
export function buildWorkspaceDownloadPrompt(sessionId: string, rendering: 'links' | 'cards' = 'links'): string {
  const examplePath = 'finance/deliverables/v001/财务报告 2026.xlsx'
  const query = new URLSearchParams({ sessionId, path: examplePath }).toString()
  return (rendering === 'cards' ? 'Work用deliver_files登记的最终文件卡片提供预览/下载。成功登记后，正文只写内容摘要，不再列同文件的Markdown下载链接，不重复嵌入已有卡片图片。仅用户明确索要正文链接或没有卡片交付时，按以下规则生成链接。\n' : '')
    + 'Downloads use HTTP Markdown links. From successful receipts derive the full /-separated path relative to this session’s bound primary workspace, not a role folder/cwd or basename. URLSearchParams encodes each value once, preserving Chinese, spaces and &#+%(). No file:// or ../; disclose outside/unverified paths instead of inventing links.\n'
    + 'Example only: bound root company, file company/' + examplePath + ':\n'
    + '[财务报告 2026.xlsx](/api/v1/workspace/file/download?' + query + ')\n'
    + 'Replace with the confirmed artifact path and label.'
}
