/** @vitest-environment jsdom */
import { describe, expect, it, vi } from 'vitest'
import {
  createTerminalPasteController,
  isTerminalPasteShortcut,
} from './terminal-paste'

describe('terminal paste controller', () => {
  it('recognizes platform paste shortcuts without treating AltGr as paste', () => {
    expect(isTerminalPasteShortcut({ type: 'keydown', key: 'v', ctrlKey: true, metaKey: false, shiftKey: false, altKey: false }, 'Win32')).toBe(true)
    expect(isTerminalPasteShortcut({ type: 'keydown', key: 'V', ctrlKey: false, metaKey: true, shiftKey: true, altKey: false }, 'MacIntel')).toBe(true)
    expect(isTerminalPasteShortcut({ type: 'keydown', key: 'Insert', ctrlKey: false, metaKey: false, shiftKey: true, altKey: false }, 'Linux')).toBe(true)
    expect(isTerminalPasteShortcut({ type: 'keydown', key: 'v', ctrlKey: true, metaKey: false, shiftKey: false, altKey: true }, 'Win32')).toBe(false)
    expect(isTerminalPasteShortcut({ type: 'keyup', key: 'v', ctrlKey: true, metaKey: false, shiftKey: false, altKey: false }, 'Win32')).toBe(false)
  })

  it('reads the OS clipboard and sends text through term.paste exactly once', async () => {
    const paste = vi.fn()
    const focus = vi.fn()
    const controller = createTerminalPasteController({ paste, focus }, async () => 'touch proof.txt')

    controller.requestClipboardPaste()
    await Promise.resolve()

    expect(focus).toHaveBeenCalledTimes(1)
    expect(paste).toHaveBeenCalledTimes(1)
    expect(paste).toHaveBeenCalledWith('touch proof.txt')
  })

  it('uses the native paste event as fallback and suppresses a duplicate async read', async () => {
    let resolveRead!: (value: string) => void
    const paste = vi.fn()
    const controller = createTerminalPasteController(
      { paste },
      () => new Promise<string>(resolve => { resolveRead = resolve }),
    )
    const event = {
      clipboardData: { getData: vi.fn(() => '中文 粘贴') },
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
      stopImmediatePropagation: vi.fn(),
    }

    controller.requestClipboardPaste()
    controller.handlePasteEvent(event)
    resolveRead('中文 粘贴')
    await Promise.resolve()

    expect(event.preventDefault).toHaveBeenCalledTimes(1)
    expect(event.stopImmediatePropagation).toHaveBeenCalledTimes(1)
    expect(paste).toHaveBeenCalledTimes(1)
    expect(paste).toHaveBeenCalledWith('中文 粘贴')
  })
})

