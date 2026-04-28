export function esc(s: string) {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

export function page(title: string, body: string) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>${esc(
    title
  )}</title><style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial;max-width:480px;margin:40px auto;padding:0 16px}input,button{font-size:16px;padding:10px 12px;width:100%;box-sizing:border-box}button{cursor:pointer}form{display:flex;flex-direction:column;gap:12px}.hint{color:#555;font-size:13px}.err{color:#b00020;font-size:14px}</style></head><body>${body}</body></html>`
}

