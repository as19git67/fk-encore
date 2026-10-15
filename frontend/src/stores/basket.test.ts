import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import type { CollectionDetail, CollectionMember, MemberRef } from '../api/collections'

const api = vi.hoisted(() => ({
  getBasket: vi.fn(),
  addToBasket: vi.fn(),
  removeFromBasket: vi.fn(),
  clearBasket: vi.fn(),
  saveBasketAsCollection: vi.fn(),
}))
vi.mock('../api/collections', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/collections')>()),
  ...api,
}))

import { useBasketStore } from './basket'
import { useBasketMirror } from '../composables/useBasketMirror'
import { useSelection } from '../composables/useSelection'

function member(ref: MemberRef, title = `#${ref.entity_id}`): CollectionMember {
  return { ...ref, title, subtitle: null, date: null, amount: null, currency: null, joined_by: 'user', added_at: '2026-01-01' }
}

function detail(refs: MemberRef[]): CollectionDetail {
  return {
    id: 1, name: 'Basket', description: null, entity_type: null, kind: 'basket', visibility: 'private',
    group_id: null, archived_at: null, created_by: 'user', created_at: '', updated_at: '', favourite: false,
    last_opened_at: null, counts: {}, total: refs.length, can_administer: true,
    members: refs.map((r) => member(r)), hidden_count: 0,
  }
}

/** The server keeps whatever it was last told, like the real one. */
let server: MemberRef[] = []
const key = (r: MemberRef) => `${r.entity_type}:${r.entity_id}`

beforeEach(() => {
  setActivePinia(createPinia())
  window.sessionStorage.clear()
  server = []
  vi.clearAllMocks()
  api.getBasket.mockImplementation(async () => detail(server))
  api.addToBasket.mockImplementation(async (refs: MemberRef[]) => {
    for (const r of refs) if (!server.some((s) => key(s) === key(r))) server.push(r)
    return { added: refs.length, collection: detail(server) }
  })
  api.removeFromBasket.mockImplementation(async (refs: MemberRef[]) => {
    const drop = new Set(refs.map(key))
    server = server.filter((s) => !drop.has(key(s)))
    return detail(server)
  })
  api.clearBasket.mockImplementation(async (type?: string) => {
    server = type ? server.filter((s) => s.entity_type !== type) : []
    return detail(server)
  })
})

const photo = (id: number): MemberRef => ({ entity_type: 'photo', entity_id: id })

describe('basket store', () => {
  it('shows a change at once and sends a burst as one request', async () => {
    const basket = useBasketStore()
    await basket.load()
    basket.add([photo(1)])
    basket.add([photo(2), photo(3)])
    expect(basket.count).toBe(3)
    await basket.flush()
    expect(api.addToBasket).toHaveBeenCalledTimes(1)
    expect(api.addToBasket.mock.calls[0]![0]).toHaveLength(3)
  })

  it('cancels an add that is taken back before it was sent', async () => {
    const basket = useBasketStore()
    await basket.load()
    basket.add([photo(1)])
    basket.remove([photo(1)])
    await basket.flush()
    expect(api.addToBasket).not.toHaveBeenCalled()
    expect(api.removeFromBasket).not.toHaveBeenCalled()
    expect(basket.count).toBe(0)
  })

  it('reloads from the server when a write fails', async () => {
    server = [photo(9)]
    const basket = useBasketStore()
    await basket.load()
    api.addToBasket.mockRejectedValueOnce(new Error('offline'))
    basket.add([photo(1)])
    await basket.flush()
    expect(basket.members.map((m) => m.entity_id)).toEqual([9])
    expect(basket.error).toBe('offline')
  })

  it('empties one type', async () => {
    server = [photo(1), { entity_type: 'meter', entity_id: 2 }]
    const basket = useBasketStore()
    await basket.load()
    await basket.clear('photo')
    expect(basket.counts).toEqual({ meter: 1 })
  })
})

describe('useBasketMirror', () => {
  interface Item { id: number; name: string }
  const fetchOne = vi.fn(async (id: number): Promise<Item> => ({ id, name: `fetched ${id}` }))

  function mirror() {
    return useBasketMirror(useSelection<Item>({ storageKey: 'test.mirror.v1' }), {
      type: 'transaction',
      fetchOne,
      display: (item) => ({ title: item.name }),
    })
  }

  it('writes module changes through to the shared basket', async () => {
    const basket = useBasketStore()
    await basket.load()
    const store = mirror()
    store.add({ id: 5, name: 'Miete' })
    expect(basket.has({ entity_type: 'transaction', entity_id: 5 })).toBe(true)
    expect(basket.members[0]!.title).toBe('Miete')
    store.remove(5)
    expect(basket.count).toBe(0)
  })

  it('fetches what arrived elsewhere and drops what left', async () => {
    server = [{ entity_type: 'transaction', entity_id: 7 }]
    window.sessionStorage.setItem('basket.handedOver.transaction.v1', '1')
    window.sessionStorage.setItem('test.mirror.v1', JSON.stringify({ version: 1, items: [{ id: 3, name: 'alt' }] }))
    const store = mirror()
    const basket = useBasketStore()
    await basket.load()
    await vi.waitFor(() => expect(store.items.value.map((i) => i.id)).toEqual([7]))
    expect(fetchOne).toHaveBeenCalledWith(7)

    server = []
    await basket.load(true)
    await nextTick()
    await vi.waitFor(() => expect(store.items.value).toEqual([]))
  })

  it('hands a pile from before the server basket over once', async () => {
    window.sessionStorage.setItem('test.mirror.v1', JSON.stringify({ version: 1, items: [{ id: 4, name: 'Strom' }] }))
    const store = mirror()
    const basket = useBasketStore()
    await basket.load()
    await nextTick()
    await basket.flush()
    expect(server).toEqual([{ entity_type: 'transaction', entity_id: 4 }])
    expect(store.items.value.map((i) => i.id)).toEqual([4])
  })
})
