import { describe, it, expect, beforeEach } from 'vitest'
import { nextTick } from 'vue'
import { useSelection } from './useSelection'

interface Item {
  id: number
  name: string
}

beforeEach(() => {
  window.sessionStorage.clear()
})

describe('useSelection — basic set operations', () => {
  it('starts empty when no storage key is given', () => {
    const sel = useSelection<Item>()
    expect(sel.count.value).toBe(0)
    expect(sel.ids.value).toEqual([])
  })

  it('add / has / remove / clear', () => {
    const sel = useSelection<Item>()
    sel.add({ id: 1, name: 'a' })
    expect(sel.has(1)).toBe(true)
    expect(sel.count.value).toBe(1)
    sel.add({ id: 2, name: 'b' })
    expect(sel.ids.value).toEqual([1, 2])
    sel.remove(1)
    expect(sel.has(1)).toBe(false)
    expect(sel.ids.value).toEqual([2])
    sel.clear()
    expect(sel.count.value).toBe(0)
  })

  it('add is idempotent on existing ids', () => {
    const sel = useSelection<Item>()
    sel.add({ id: 1, name: 'a' })
    sel.add({ id: 1, name: 'a-clone' })
    expect(sel.count.value).toBe(1)
    // First entry stays; we don't replace on duplicate add.
    expect(sel.items.value[0]?.name).toBe('a')
  })

  it('toggle flips membership', () => {
    const sel = useSelection<Item>()
    sel.toggle({ id: 1, name: 'a' })
    expect(sel.has(1)).toBe(true)
    sel.toggle({ id: 1, name: 'a' })
    expect(sel.has(1)).toBe(false)
  })

  it('set replaces the whole list', () => {
    const sel = useSelection<Item>()
    sel.add({ id: 1, name: 'a' })
    sel.set([{ id: 5, name: 'e' }, { id: 6, name: 'f' }])
    expect(sel.ids.value).toEqual([5, 6])
  })

  it('supports string ids', () => {
    const sel = useSelection<{ id: string }>()
    sel.add({ id: 'a' })
    sel.add({ id: 'b' })
    expect(sel.has('a')).toBe(true)
    sel.remove('a')
    expect(sel.ids.value).toEqual(['b'])
  })
})

const KEY = 'test.selection.v1'

describe('useSelection — sessionStorage persistence', () => {
  it('hydrates from storage on first call', () => {
    window.sessionStorage.setItem(
      KEY,
      JSON.stringify({ version: 1, items: [{ id: 1, name: 'a' }] }),
    )
    const sel = useSelection<Item>({ storageKey: KEY })
    expect(sel.ids.value).toEqual([1])
  })

  it('persists on every mutation', async () => {
    const sel = useSelection<Item>({ storageKey: KEY })
    sel.add({ id: 1, name: 'a' })
    await nextTick()
    const parsed = JSON.parse(window.sessionStorage.getItem(KEY)!) as {
      version: number
      items: Item[]
    }
    expect(parsed.version).toBe(1)
    expect(parsed.items.map((i) => i.id)).toEqual([1])
  })

  it('clears storage when the selection becomes empty', async () => {
    const sel = useSelection<Item>({ storageKey: KEY })
    sel.add({ id: 1, name: 'a' })
    await nextTick()
    sel.clear()
    await nextTick()
    expect(window.sessionStorage.getItem(KEY)).toBeNull()
  })

  it('ignores stored payloads with the wrong version', () => {
    window.sessionStorage.setItem(
      KEY,
      JSON.stringify({ version: 999, items: [{ id: 1 }] }),
    )
    const sel = useSelection<Item>({ storageKey: KEY })
    expect(sel.items.value).toEqual([])
  })

  it('ignores malformed JSON', () => {
    window.sessionStorage.setItem(KEY, '{not json')
    const sel = useSelection<Item>({ storageKey: KEY })
    expect(sel.items.value).toEqual([])
  })

  it('filters out entries without a valid id', () => {
    window.sessionStorage.setItem(
      KEY,
      JSON.stringify({
        version: 1,
        items: [{ id: 1 }, null, { foo: 'bar' }, { id: 2 }],
      }),
    )
    const sel = useSelection<Item>({ storageKey: KEY })
    expect(sel.ids.value).toEqual([1, 2])
  })

  it('survives a quota error without throwing', async () => {
    const sel = useSelection<Item>({ storageKey: KEY })
    const original = Storage.prototype.setItem
    Storage.prototype.setItem = function () {
      throw new DOMException('QuotaExceededError', 'QuotaExceededError')
    }
    try {
      expect(() => sel.add({ id: 99, name: 'big' })).not.toThrow()
      await nextTick()
      expect(sel.ids.value).toEqual([99])
    } finally {
      Storage.prototype.setItem = original
    }
  })

  it('without a storageKey, no storage access happens', async () => {
    const setSpy = Storage.prototype.setItem
    let calls = 0
    Storage.prototype.setItem = function (...args) {
      calls++
      return setSpy.apply(this, args as Parameters<typeof setSpy>)
    }
    try {
      const sel = useSelection<Item>()
      sel.add({ id: 1, name: 'a' })
      await nextTick()
      expect(calls).toBe(0)
    } finally {
      Storage.prototype.setItem = setSpy
    }
  })
})
