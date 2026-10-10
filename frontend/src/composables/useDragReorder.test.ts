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
