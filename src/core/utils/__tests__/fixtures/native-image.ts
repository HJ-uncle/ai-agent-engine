import { deflateSync } from 'node:zlib'

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = crc >>> 1 ^ (crc & 1 ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Buffer): Buffer {
  const name = Buffer.from(type), size = Buffer.alloc(4), crc = Buffer.alloc(4)
  size.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(Buffer.concat([name, data])))
  return Buffer.concat([size, name, data, crc])
}

/** Valid 256x256 RGBA PNG, deliberately encoded without deflate compression. */
export function largeNativePng(): { buffer: Buffer; base64: string; url: string } {
  const width = 256, height = 256, header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6
  const pixels = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const offset = y * (width * 4 + 1) + 1 + x * 4
    pixels[offset] = x; pixels[offset + 1] = y; pixels[offset + 2] = 127; pixels[offset + 3] = 255
  }
  const buffer = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header),
    chunk('IDAT', deflateSync(pixels, { level: 0 })), chunk('IEND', Buffer.alloc(0))])
  const base64 = buffer.toString('base64')
  return { buffer, base64, url: 'data:image/png;base64,' + base64 }
}
