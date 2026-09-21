import { describe, it, expect, beforeEach } from 'vitest'
import { createApp, defineComponent, nextTick } from 'vue'
import { useListSelection } from './useListSelection'

/**
 * One selection behaviour for every list (issue #1272, stage 5): the same
 * gestures have to mean the same thing whether the rows are photos in a
 * virtual grid, transactions on a page, or documents in a split view.
 */

const LOADED = [1, 2, 3, 4, 5]

function plainList() {
  return useListSelection({ loadedIds: () => LOADED, hotkeys: false })
}

function virtualList(total = 12) {
  return useListSelection({
    loadedIds: () => LOADED,
    total: () => total,
    // A virtual grid resolves a position to its row, page by page.
    loadEntryAt: async (index: number) => (index >= 0 && index < total ? { id: index + 1 } : null),
    fetchAllIds: async () => Array.from({ length: total }, (_, i) => i + 1),
    hotkeys: false,
  })
}

describe('useListSelection', () => {
  it('starts outside select mode with nothing selected', () => {
    const s = plainList()
    expect(s.selectMode.value).toBe(false)
    expect(s.selectedCount.value).toBe(0)
    expect(s.selectAllState.value).toBe(false)
  })

  it('drops the selection when select mode ends', async () => {
    const s = plainList()
    s.enter()
    await s.toggle({ id: 3 })
    expect(s.has(3)).toBe(true)
    s.toggleMode()
    expect(s.selectMode.value).toBe(false)
    expect(s.selectedCount.value).toBe(0)
  })

  it('starts a fresh selection every time the mode is entered', async () => {
    const s = plainList()
    s.enter()
    await s.toggle({ id: 1 })
    s.exit()
    s.enter()
    expect(s.selectedCount.value).toBe(0)
  })

  it('toggles a row on and off again', async () => {
    const s = plainList()
    await s.toggle({ id: 2 })
    expect(s.has(2)).toBe(true)
    await s.toggle({ id: 2 })
    expect(s.has(2)).toBe(false)
  })

  it('takes an explicit state from a checkbox', () => {
    const s = plainList()
    s.toggleId(4, true)
    s.toggleId(4, true)
    expect(s.selectedCount.value).toBe(1)
    s.toggleId(4, false)
    expect(s.has(4)).toBe(false)
  })

  it('spans a range from the last click when shift is held', async () => {
    const s = virtualList()
    await s.toggle({ id: 2 }, { index: 1, range: false })
    await s.toggle({ id: 5 }, { index: 4, range: true })
    expect([...s.selectedIds.value].sort((a, b) => a - b)).toEqual([2, 3, 4, 5])
  })

  it('keeps the anchor so a second shift-click re-spans instead of walking', async () => {
    const s = virtualList()
    await s.toggle({ id: 2 }, { index: 1, range: false })
    await s.toggle({ id: 5 }, { index: 4, range: true })
    await s.toggle({ id: 3 }, { index: 2, range: true })
    // Still measured from row 2, so the span shrank rather than moving on.
    expect([...s.selectedIds.value].sort((a, b) => a - b)).toEqual([2, 3, 4, 5])
  })

  it('treats a shift-click without an anchor as a plain toggle', async () => {
    const s = virtualList()
    await s.toggle({ id: 3 }, { index: 2, range: true })
    expect([...s.selectedIds.value]).toEqual([3])
  })

  it('falls back to a plain toggle on a list that cannot resolve positions', async () => {
    const s = plainList()
    await s.toggle({ id: 1 }, { index: 0, range: false })
    await s.toggle({ id: 4 }, { index: 3, range: true })
    expect([...s.selectedIds.value].sort((a, b) => a - b)).toEqual([1, 4])
  })

  it('selects the whole result, not just the loaded page', async () => {
    const s = virtualList(12)
    await s.selectAll()
    expect(s.selectedCount.value).toBe(12)
    expect(s.allSelected.value).toBe(true)
    expect(s.selectAllState.value).toBe(true)
  })

  it('selects only what is loaded when asked for that', () => {
    const s = virtualList(12)
    s.selectAllLoaded()
    expect(s.selectedCount.value).toBe(LOADED.length)
    // Loaded is not all, so the tristate box stays in between.
    expect(s.selectAllState.value).toBeNull()
  })

  it('keeps the list usable when the backend cannot deliver the ids', async () => {
    const s = useListSelection({
      loadedIds: () => LOADED,
      fetchAllIds: async () => {
        throw new Error('offline')
      },
      hotkeys: false,
    })
    s.toggleId(1, true)
    await s.selectAll()
    expect(s.selectedCount.value).toBe(1)
    expect(s.selectAllBusy.value).toBe(false)
  })

  it('inverts within what is loaded', () => {
    const s = plainList()
    s.toggleId(2, true)
    s.toggleId(4, true)
    s.invert()
    expect([...s.selectedIds.value].sort((a, b) => a - b)).toEqual([1, 3, 5])
  })

  it('reports a tristate for a checkbox', () => {
    const s = plainList()
    expect(s.selectAllState.value).toBe(false)
    s.toggleId(1, true)
    expect(s.selectAllState.value).toBeNull()
    s.selectAllLoaded()
    expect(s.selectAllState.value).toBe(true)
  })

  it('is not "all selected" while the list is empty', () => {
    const s = useListSelection({ loadedIds: () => [], hotkeys: false })
    expect(s.allSelected.value).toBe(false)
  })

  it('is the transient pick, so exiting clears it and nothing else', async () => {
    const s = plainList()
    s.enter()
    await s.toggle({ id: 1 })
    const idsWhileOpen = [...s.selectedIds.value]
    s.exit()
    expect(idsWhileOpen).toEqual([1])
    expect(s.selectedCount.value).toBe(0)
  })
})

describe('useListSelection hotkeys', () => {
  /** Mounted for real, because the shortcut is bound in `onMounted`. */
  function mountSelection(options: Parameters<typeof useListSelection>[0]) {
    let exposed!: ReturnType<typeof useListSelection>
    const app = createApp(
      defineComponent({
        setup() {
          exposed = useListSelection(options)
          return () => null
        },
      }),
    )
    app.mount(document.createElement('div'))
    return { selection: exposed, unmount: () => app.unmount() }
  }

  function pressCtrlA(target: EventTarget) {
    const event = new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, cancelable: true })
    Object.defineProperty(event, 'target', { value: target })
    document.dispatchEvent(event)
    return event
  }

  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('selects everything on Ctrl+A while select mode is on', async () => {
    const { selection, unmount } = mountSelection({
      loadedIds: () => LOADED,
      fetchAllIds: async () => [1, 2, 3, 4, 5, 6],
    })
    selection.enter()
    pressCtrlA(document.body)
    await nextTick()
    await Promise.resolve()
    expect(selection.selectedCount.value).toBe(6)
    unmount()
  })

  it('leaves the shortcut to the browser inside a text field', async () => {
    const { selection, unmount } = mountSelection({
      loadedIds: () => LOADED,
      fetchAllIds: async () => [1, 2, 3, 4, 5, 6],
    })
    selection.enter()
    const input = document.createElement('input')
    document.body.appendChild(input)
    const event = pressCtrlA(input)
    await nextTick()
    expect(selection.selectedCount.value).toBe(0)
    expect(event.defaultPrevented).toBe(false)
    unmount()
  })

  it('ignores the shortcut outside select mode', async () => {
    const { selection, unmount } = mountSelection({
      loadedIds: () => LOADED,
      fetchAllIds: async () => [1, 2, 3, 4, 5, 6],
    })
    pressCtrlA(document.body)
    await nextTick()
    expect(selection.selectedCount.value).toBe(0)
    unmount()
  })

  it('stops listening once the list is gone', async () => {
    const { selection, unmount } = mountSelection({
      loadedIds: () => LOADED,
      fetchAllIds: async () => [1, 2, 3, 4, 5, 6],
    })
    selection.enter()
    unmount()
    pressCtrlA(document.body)
    await nextTick()
    await Promise.resolve()
    expect(selection.selectedCount.value).toBe(0)
  })
})
