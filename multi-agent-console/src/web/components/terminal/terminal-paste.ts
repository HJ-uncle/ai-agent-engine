/**
 * Clipboard handling shared by the xterm terminal component and its tests.
 *
 * xterm's default key mapping turns Ctrl+V into a literal \x16 input on some
 * platforms.  We handle the shortcut before xterm sees it, then use xterm's
 * public paste() API so bracketed-paste and newline normalization stay in one
 * place.  A capture-phase DOM paste listener is kept as a fallback for
 * browsers/Electron builds where the Clipboard API is unavailable or denied.
 */

export interface PasteTerminal {
  paste: (text: string) => void
  focus?: () => void
}

export interface PasteShortcutEvent {
  type: string
  key: string
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
  altKey: boolean
}

export function isTerminalPasteShortcut(
  event: PasteShortcutEvent,
  platform = typeof navigator === 'undefined' ? '' : navigator.platform,
): boolean {
  if (event.type !== 'keydown' || event.altKey) return false
  const key = event.key.toLowerCase()
  const isMac = platform.toLowerCase().includes('mac')
  const primary = isMac
    ? event.metaKey && !event.ctrlKey
    : event.ctrlKey && !event.metaKey
  return (key === 'v' && primary) ||
    (key === 'insert' && event.shiftKey && !event.ctrlKey && !event.metaKey)
}

export interface PasteEventLike {
  clipboardData?: { getData: (format: string) => string } | null
  preventDefault: () => void
  stopPropagation: () => void
  stopImmediatePropagation?: () => void
}

export interface TerminalPasteController {
  requestClipboardPaste: () => void
  handlePasteEvent: (event: PasteEventLike) => void
}

type PendingPaste = { native: boolean; sent: boolean }

/**
 * Build a paste controller without coupling tests to React or xterm internals.
 * The pending marker prevents a native paste event and an async Clipboard API
 * read from inserting the same text twice.
 */
export function createTerminalPasteController(
  terminal: PasteTerminal,
  readClipboard: () => Promise<string> = () => {
    try {
      return navigator.clipboard?.readText?.() ?? Promise.resolve('')
    } catch {
      return Promise.resolve('')
    }
  },
): TerminalPasteController {
  let pending: PendingPaste | null = null

  const clearPending = (marker: PendingPaste): void => {
    // Keep the marker through the current event turn. If the browser emits a
    // native paste after the Clipboard promise resolves, it must be consumed
    // rather than inserted a second time.
    setTimeout(() => {
      if (pending === marker) pending = null
    }, 0)
  }

  const requestClipboardPaste = (): void => {
    const marker: PendingPaste = { native: false, sent: false }
    pending = marker
    terminal.focus?.()
    void readClipboard().then(text => {
      if (pending !== marker || marker.native || !text) return
      marker.sent = true
      terminal.paste(text)
    }).catch(() => {
      // The capture-phase paste event remains available as a fallback.
    }).finally(() => clearPending(marker))
  }

  const handlePasteEvent = (event: PasteEventLike): void => {
    event.preventDefault()
    event.stopPropagation()
    event.stopImmediatePropagation?.()
    const marker = pending
    if (marker?.sent) return
    if (marker) marker.native = true
    const text = event.clipboardData?.getData('text/plain') ?? ''
    if (!text) return
    terminal.focus?.()
    terminal.paste(text)
    if (marker) clearPending(marker)
  }

  return { requestClipboardPaste, handlePasteEvent }
}

