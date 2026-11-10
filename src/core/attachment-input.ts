export interface ChatAttachmentInput {
  name: string
  type?: string
  content?: string
  encoding?: 'utf-8' | 'base64'
  attachmentId?: string
  referenceLabel?: string
  displayName?: string
  size?: number
}

/** Persist only replay metadata, never inline file bytes. Older clients need no new fields. */
export function attachmentHistoryMetadata(file: ChatAttachmentInput): Omit<ChatAttachmentInput, 'content' | 'encoding'> {
  return { name: file.name, ...(typeof file.type === 'string' ? { type: file.type } : {}),
    ...(typeof file.attachmentId === 'string' && file.attachmentId && file.attachmentId.length <= 4096 ? { attachmentId: file.attachmentId } : {}),
    ...(typeof file.referenceLabel === 'string' && file.referenceLabel && file.referenceLabel.length <= 512 ? { referenceLabel: file.referenceLabel } : {}),
    ...(typeof file.displayName === 'string' && file.displayName.length <= 512 ? { displayName: file.displayName } : {}),
    ...(typeof file.size === 'number' && Number.isSafeInteger(file.size) && file.size >= 0 ? { size: file.size } : {}) }
}

export function attachmentDescription(file: ChatAttachmentInput): string {
  const metadata = attachmentHistoryMetadata(file)
  return metadata.referenceLabel ? `${metadata.referenceLabel}（文件：${file.name}）` : `文件 ${file.name}`
}
