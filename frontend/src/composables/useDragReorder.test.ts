import { describe, it, expect, vi } from 'vitest'
import { createApp, defineComponent, nextTick, ref } from 'vue'
import { moveKey, reorderTargetIndex, useDragReorder } from './useDragReorder'

describe('reorderTargetIndex', () => {
  it('lands before every row whose middle the pointer has not passed', () => {
    const mids = [10, 30, 50]
    expect(reorderTargetIndex(mids, 0)).toBe(0)
    expect(reorderTargetIndex(mids, 20)).toBe(1)
    expect(reorderTargetIndex(mids, 49)).toBe(2)
    expect(reorderTargetIndex(mids, 99)).toBe(3)
  })
})

describe('moveKey', () => {
  it('moves a key to the given index of the result', () => {
    expect(moveKey([1, 2, 3, 4], 1, 2)).toEqual([2, 3, 1, 4])
    expect(moveKey([1, 2, 3, 4], 4, 0)).toEqual([4, 1, 2, 3])
  })

  it('clamps out-of-range targets and ignores unknown keys', () => {
    expect(moveKey([1, 2, 3], 1, 99)).toEqual([2, 3, 1])
    expect(moveKey([1, 2, 3], 2, -5)).toEqual([2, 1, 3])
    expect(moveKey([1, 2, 3], 9, 0)).toEqual([1, 2, 3])
  })
})

describe('useDragReorder keyboard', () => {
  function mount(ids: number[], commit: (keys: (string | number)[]) => Promise<void> | void) {
    const items = ref(ids.map((id) => ({ id })))
    let api!: ReturnType<typeof useDragReorder<{ id: number }>>
    const app = createApp(
      defineComponent({
        setup() {
          api = useDragReorder({ items, keyOf: (i) => i.id, commit })
          return () => null
        },
      }),
    )
    app.mount(document.createElement('div'))
    return { items, api, unmount: () => app.unmount() }
  }

  function key(k: string): KeyboardEvent {
    return new KeyboardEvent('keydown', { key: k, cancelable: true })
  }

  it('moves the row by one and commits the new order', async () => {
    const commit = vi.fn()
    const { api, unmount } = mount([1, 2, 3], commit)
    api.onGripKeydown(1, key('ArrowDown'))
    expect(commit).toHaveBeenCalledWith([2, 1, 3])
    unmount()
  })

  it('does nothing at the ends of the list', () => {
    const commit = vi.fn()
    const { api, unmount } = mount([1, 2, 3], commit)
    api.onGripKeydown(1, key('ArrowUp'))
    api.onGripKeydown(3, key('ArrowDown'))
    expect(commit).not.toHaveBeenCalled()
    unmount()
  })

  it('shows the new order until the saved one arrives', async () => {
    let resolve!: () => void
    const { items, api, unmount } = mount([1, 2, 3], () => new Promise<void>((r) => (resolve = r)))
    api.onGripKeydown(3, key('ArrowUp'))
    expect(api.ordered.value.map((i) => i.id)).toEqual([1, 3, 2])
    items.value = [{ id: 1 }, { id: 3 }, { id: 2 }]
    resolve()
    await nextTick()
    await Promise.resolve()
    expect(api.ordered.value.map((i) => i.id)).toEqual([1, 3, 2])
    unmount()
  })

  it('falls back to the saved order when the save fails', async () => {
    const { api, unmount } = mount([1, 2, 3], () => Promise.reject(new Error('nope')))
    api.onGripKeydown(1, key('ArrowDown'))
    expect(api.ordered.value.map((i) => i.id)).toEqual([2, 1, 3])
    await new Promise((r) => setTimeout(r, 0))
    expect(api.ordered.value.map((i) => i.id)).toEqual([1, 2, 3])
    unmount()
  })
})

describe('useDragReorder pointer drag', () => {
  /** A list of 40px rows with 8px gaps, laid out by hand (jsdom has no layout). */
  function mountList(ids: number[], commit: (keys: (string | number)[]) => Promise<void> | void) {
    const items = ref(ids.map((id) => ({ id })))
    let api!: ReturnType<typeof useDragReorder<{ id: number }>>
    const app = createApp(
      defineComponent({
        setup() {
          api = useDragReorder({ items, keyOf: (i) => i.id, commit })
          return () => null
        },
      }),
    )
    app.mount(document.createElement('div'))

    const list = document.createElement('ul')
    list.setAttribute('data-reorder-list', '')
    const grips = new Map<number, HTMLElement>()
    function layout() {
      list.replaceChildren()
      api.ordered.value.forEach((item, i) => {
        const row = document.createElement('li')
        row.dataset.reorderKey = String(item.id)
        row.getBoundingClientRect = () =>
          ({ top: i * 48, bottom: i * 48 + 40, height: 40, left: 0, right: 100, width: 100 }) as DOMRect
        const grip = document.createElement('button')
        row.appendChild(grip)
        list.appendChild(row)
        grips.set(item.id, grip)
      })
    }
    layout()
    document.body.appendChild(list)
    return {
      items,
      api,
      layout,
      unmount: () => {
        app.unmount()
        list.remove()
      },
      press(id: number, y: number) {
        const event = pointer('pointerdown', y)
        Object.defineProperty(event, 'currentTarget', { value: grips.get(id) })
        api.onGripPointerDown(id, event)
      },
    }
  }

  function pointer(type: string, y: number): PointerEvent {
    const event = new MouseEvent(type, { clientY: y, button: 0, cancelable: true }) as PointerEvent
    Object.defineProperty(event, 'pointerId', { value: 1 })
    Object.defineProperty(event, 'pointerType', { value: 'mouse' })
    return event
  }

  it('ends the drag on a release anywhere and allows the next one', async () => {
    const commit = vi.fn()
    const list = mountList([1, 2, 3], commit)

    list.press(1, 20)
    expect(list.api.draggingKey.value).toBe(1)
    window.dispatchEvent(pointer('pointermove', 125))
    // Row 1 follows the pointer, rows 2 and 3 make room.
    expect(list.api.rowStyle(1)?.transform).toBe('translateY(105px)')
    expect(list.api.rowStyle(2)?.transform).toBe('translateY(-48px)')
    window.dispatchEvent(pointer('pointerup', 125))
    expect(list.api.draggingKey.value).toBeNull()
    expect(commit).toHaveBeenLastCalledWith([2, 3, 1])
    expect(list.api.ordered.value.map((i) => i.id)).toEqual([2, 3, 1])

    // The server confirms; a second drag works just like the first.
    list.items.value = [{ id: 2 }, { id: 3 }, { id: 1 }]
    await nextTick()
    list.layout()
    list.press(1, 116)
    expect(list.api.draggingKey.value).toBe(1)
    window.dispatchEvent(pointer('pointermove', 10))
    window.dispatchEvent(pointer('pointerup', 10))
    expect(list.api.draggingKey.value).toBeNull()
    expect(commit).toHaveBeenLastCalledWith([1, 2, 3])
    list.unmount()
  })

  it('a cancelled drag leaves the order alone', () => {
    const commit = vi.fn()
    const list = mountList([1, 2, 3], commit)
    list.press(1, 20)
    window.dispatchEvent(pointer('pointermove', 125))
    window.dispatchEvent(pointer('pointercancel', 125))
    expect(list.api.draggingKey.value).toBeNull()
    expect(list.api.rowStyle(1)).toBeUndefined()
    expect(commit).not.toHaveBeenCalled()
    expect(list.api.ordered.value.map((i) => i.id)).toEqual([1, 2, 3])
    list.unmount()
  })
})
