/** A final result is explicit delivery, independent of the file-operation ledger. */
export interface FinalResultItem {
  id: string
  name: string
  path: string
  mimeType: string
  size: number
  sha256: string
  assetId: string
  kind: 'image' | 'file'
}

export interface FinalResult {
  schemaVersion: 1
  sessionId: string
  turnId: string
  runId: string
  assistantMessageId: string
  text: string
  items: FinalResultItem[]
  publishedAt: number
}

export const MAX_RESULT_ASSET_BYTES = 32 * 1024 * 1024
export const MAX_RESULT_TOTAL_BYTES = 128 * 1024 * 1024
export const MAX_RESULT_ITEMS = 16
