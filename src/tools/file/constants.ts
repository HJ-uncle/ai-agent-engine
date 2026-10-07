// Format handlers still materialize their decoded representation. 64 MiB is a
// practical default for a long-running agent; deployments handling larger
// artifacts can raise this explicitly without changing code.
const configuredFileSize = Number.parseInt(process.env.MAX_FILE_SIZE_BYTES ?? '67108864', 10)
export const MAX_FILE_SIZE = Number.isSafeInteger(configuredFileSize) && configuredFileSize > 0
  ? configuredFileSize
  : 67_108_864

export const IMAGE_MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.tiff': 'image/tiff',
  '.svg': 'image/svg+xml',
}

export const IMAGE_MAGIC_BYTES: { ext: string; signature: number[] }[] = [
  { ext: 'png',  signature: [0x89, 0x50, 0x4E, 0x47] },
  { ext: 'jpg',  signature: [0xFF, 0xD8, 0xFF] },
  { ext: 'gif',  signature: [0x47, 0x49, 0x46] },
  { ext: 'bmp',  signature: [0x42, 0x4D] },
  { ext: 'webp', signature: [0x52, 0x49, 0x46, 0x46] },
  { ext: 'tiff', signature: [0x49, 0x49, 0x2A, 0x00] },
  { ext: 'tiff', signature: [0x4D, 0x4D, 0x00, 0x2A] },
]
