import React, { useMemo } from 'react'

interface HexEditorProps {
  data: Uint8Array
  name: string
}

const BYTES_PER_ROW = 16

export function HexEditor({ data, name }: HexEditorProps) {
  const rows = useMemo(() => {
    const result: Array<{ offset: number; bytes: number[] }> = []
    for (let i = 0; i < data.length; i += BYTES_PER_ROW) {
      result.push({
        offset: i,
        bytes: Array.from(data.slice(i, i + BYTES_PER_ROW)),
      })
    }
    return result
  }, [data])

  const pad = (n: number, len: number) => n.toString(16).toUpperCase().padStart(len, '0')

  const toAscii = (b: number) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '·')

  return (
    <div style={{ flex: 1, overflow: 'auto', background: 'var(--color-bg-primary)', padding: '12px 16px', fontFamily: 'var(--font-mono)', fontSize: 13 }}>
      {/* Header */}
      <div style={{ display: 'flex', color: '#555', marginBottom: 4, paddingBottom: 4, borderBottom: '1px solid #333', userSelect: 'none' }}>
        <span style={{ width: 80, display: 'inline-block', flexShrink: 0 }}>Offset</span>
        <span style={{ flex: 1 }}>
          {Array.from({ length: BYTES_PER_ROW }, (_, i) => pad(i, 2)).join(' ')}
        </span>
        <span style={{ marginLeft: 16, color: '#555' }}>ASCII</span>
      </div>

      {/* Rows */}
      {rows.map(row => (
        <div key={row.offset} style={{ display: 'flex', lineHeight: '20px' }}>
          {/* Offset */}
          <span style={{ width: 80, color: '#858585', flexShrink: 0 }}>{pad(row.offset, 8)}</span>

          {/* Hex bytes */}
          <span style={{ flex: 1, color: '#9cdcfe' }}>
            {row.bytes.map((b, i) => (
              <span key={i} style={{ marginRight: 4 }}>{pad(b, 2)}</span>
            ))}
            {/* Padding for incomplete last row */}
            {row.bytes.length < BYTES_PER_ROW && (
              <span style={{ visibility: 'hidden' }}>
                {Array.from({ length: BYTES_PER_ROW - row.bytes.length }, (_, i) => (
                  <span key={i} style={{ marginRight: 4 }}>{'  '}</span>
                ))}
              </span>
            )}
          </span>

          {/* ASCII */}
          <span style={{ marginLeft: 16, color: '#ce9178', letterSpacing: 1 }}>
            {row.bytes.map(toAscii).join('')}
          </span>
        </div>
      ))}

      {data.length === 0 && (
        <div style={{ color: '#666', padding: '16px 0' }}>（空文件）</div>
      )}

      {/* Footer */}
      <div style={{ marginTop: 12, color: '#555', fontSize: 11, borderTop: '1px solid #333', paddingTop: 8 }}>
        {name} — {data.length.toLocaleString()} bytes
      </div>
    </div>
  )
}
