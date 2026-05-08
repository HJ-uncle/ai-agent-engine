/**
 * explorerStore unit tests
 * Run: npm test -- --testPathPattern=explorer.store
 */
import { renderHook, act } from '@testing-library/react'
import { useExplorerStore } from '../explorer'

// Reset store between tests
beforeEach(() => {
  useExplorerStore.setState({
    tabs: [],
    activeTabPath: null,
    undoLog: [],
    quickOpenVisible: false,
  })
})

// ─── Tab management ────────────────────────────────────────────────────────────

describe('Tab management', () => {
  test('openTab adds a new tab and sets it active', () => {
    const { result } = renderHook(() => useExplorerStore())
    act(() => {
      result.current.openTab({ path: '/ws/src/index.ts', name: 'index.ts', type: 'text' })
    })
    expect(result.current.tabs).toHaveLength(1)
    expect(result.current.activeTabPath).toBe('/ws/src/index.ts')
    expect(result.current.tabs[0].isDirty).toBe(false)
  })

  test('openTab on existing path just activates it (no duplicate)', () => {
    const { result } = renderHook(() => useExplorerStore())
    act(() => {
      result.current.openTab({ path: '/ws/a.ts', name: 'a.ts', type: 'text' })
      result.current.openTab({ path: '/ws/b.ts', name: 'b.ts', type: 'text' })
      result.current.openTab({ path: '/ws/a.ts', name: 'a.ts', type: 'text' })
    })
    expect(result.current.tabs).toHaveLength(2)
    expect(result.current.activeTabPath).toBe('/ws/a.ts')
  })

  test('closeTab removes tab and activates neighbor', () => {
    const { result } = renderHook(() => useExplorerStore())
    act(() => {
      result.current.openTab({ path: '/ws/a.ts', name: 'a.ts', type: 'text' })
      result.current.openTab({ path: '/ws/b.ts', name: 'b.ts', type: 'text' })
      result.current.closeTab('/ws/a.ts')
    })
    expect(result.current.tabs).toHaveLength(1)
    expect(result.current.tabs[0].path).toBe('/ws/b.ts')
    expect(result.current.activeTabPath).toBe('/ws/b.ts')
  })

  test('closeTab last tab sets activeTabPath to null', () => {
    const { result } = renderHook(() => useExplorerStore())
    act(() => {
      result.current.openTab({ path: '/ws/a.ts', name: 'a.ts', type: 'text' })
      result.current.closeTab('/ws/a.ts')
    })
    expect(result.current.tabs).toHaveLength(0)
    expect(result.current.activeTabPath).toBeNull()
  })

  test('markDirty sets isDirty=true on matching tab', () => {
    const { result } = renderHook(() => useExplorerStore())
    act(() => {
      result.current.openTab({ path: '/ws/a.ts', name: 'a.ts', type: 'text' })
      result.current.markDirty('/ws/a.ts')
    })
    expect(result.current.tabs[0].isDirty).toBe(true)
  })

  test('markSaved sets isDirty=false and stores content', () => {
    const { result } = renderHook(() => useExplorerStore())
    act(() => {
      result.current.openTab({ path: '/ws/a.ts', name: 'a.ts', type: 'text' })
      result.current.markDirty('/ws/a.ts')
      result.current.markSaved('/ws/a.ts', 'const x = 1')
    })
    expect(result.current.tabs[0].isDirty).toBe(false)
    expect(result.current.tabs[0].savedContent).toBe('const x = 1')
  })
})

// ─── File type detection ───────────────────────────────────────────────────────

describe('File type auto-detection via openTab', () => {
  test('image extensions → type=image', () => {
    const { result } = renderHook(() => useExplorerStore())
    act(() => {
      result.current.openTab({ path: '/ws/logo.png', name: 'logo.png', type: undefined as any })
    })
    expect(result.current.tabs[0].type).toBe('image')
  })

  test('video extensions → type=video', () => {
    const { result } = renderHook(() => useExplorerStore())
    act(() => {
      result.current.openTab({ path: '/ws/demo.mp4', name: 'demo.mp4', type: undefined as any })
    })
    expect(result.current.tabs[0].type).toBe('video')
  })

  test('ts extension → type=text', () => {
    const { result } = renderHook(() => useExplorerStore())
    act(() => {
      result.current.openTab({ path: '/ws/foo.ts', name: 'foo.ts', type: undefined as any })
    })
    expect(result.current.tabs[0].type).toBe('text')
  })

  test('unknown binary extension → type=binary', () => {
    const { result } = renderHook(() => useExplorerStore())
    act(() => {
      result.current.openTab({ path: '/ws/app.exe', name: 'app.exe', type: undefined as any })
    })
    expect(result.current.tabs[0].type).toBe('binary')
  })
})

// ─── Undo log ──────────────────────────────────────────────────────────────────

describe('Undo log', () => {
  test('pushLog adds entry with timestamp', () => {
    const { result } = renderHook(() => useExplorerStore())
    act(() => {
      result.current.pushLog({ type: 'delete', path: '/ws/a.ts' })
    })
    expect(result.current.undoLog).toHaveLength(1)
    expect(result.current.undoLog[0].type).toBe('delete')
    expect(result.current.undoLog[0].path).toBe('/ws/a.ts')
    expect(result.current.undoLog[0].timestamp).toBeGreaterThan(0)
  })

  test('popLog removes and returns last entry (LIFO)', () => {
    const { result } = renderHook(() => useExplorerStore())
    act(() => {
      result.current.pushLog({ type: 'delete', path: '/ws/a.ts' })
      result.current.pushLog({ type: 'rename', path: '/ws/b.ts', prevPath: '/ws/a.ts' })
    })
    let popped: any
    act(() => {
      popped = result.current.popLog()
    })
    expect(popped.path).toBe('/ws/b.ts')
    expect(result.current.undoLog).toHaveLength(1)
  })

  test('popLog on empty log returns undefined', () => {
    const { result } = renderHook(() => useExplorerStore())
    let popped: any
    act(() => {
      popped = result.current.popLog()
    })
    expect(popped).toBeUndefined()
  })

  test('log is capped at 50 entries', () => {
    const { result } = renderHook(() => useExplorerStore())
    act(() => {
      for (let i = 0; i < 55; i++) {
        result.current.pushLog({ type: 'delete', path: `/ws/file_${i}.ts` })
      }
    })
    expect(result.current.undoLog).toHaveLength(50)
    // Oldest entries should have been discarded
    expect(result.current.undoLog[0].path).toBe('/ws/file_5.ts')
    expect(result.current.undoLog[49].path).toBe('/ws/file_54.ts')
  })
})

// ─── Quick open ────────────────────────────────────────────────────────────────

describe('Quick open visibility', () => {
  test('setQuickOpenVisible toggles visibility', () => {
    const { result } = renderHook(() => useExplorerStore())
    expect(result.current.quickOpenVisible).toBe(false)
    act(() => result.current.setQuickOpenVisible(true))
    expect(result.current.quickOpenVisible).toBe(true)
    act(() => result.current.setQuickOpenVisible(false))
    expect(result.current.quickOpenVisible).toBe(false)
  })
})
