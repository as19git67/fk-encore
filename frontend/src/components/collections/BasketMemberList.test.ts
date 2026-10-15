import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import { createApp, h } from 'vue'
import PrimeVue from 'primevue/config'
import type { CollectionMember, MemberRef } from '../../api/collections'

vi.mock('vue-router', () => ({ useRouter: () => ({ push: vi.fn() }) }))

import BasketMemberList from './BasketMemberList.vue'
import { useBasketStore } from '../../stores/basket'

function member(ref: MemberRef, title: string): CollectionMember {
  return { ...ref, title, subtitle: null, date: null, amount: null, currency: null, joined_by: 'user', added_at: '' }
}

let pinia: Pinia

function mountList(first?: 'document' | 'transaction', slots: Record<string, () => ReturnType<typeof h>> = {}) {
  const el = document.createElement('div')
  createApp({ render: () => h('ul', [h(BasketMemberList, { first }, slots)]) })
    .use(pinia)
    .use(PrimeVue)
    .mount(el)
  return el
}

const groupsOf = (el: HTMLElement) => [...el.querySelectorAll('.basket-group')].map((g) => g.textContent?.trim())

beforeEach(() => {
  pinia = createPinia()
  setActivePinia(pinia)
  const basket = useBasketStore()
  basket.members = [
    member({ entity_type: 'photo', entity_id: 1 }, 'IMG_0001.jpg'),
    member({ entity_type: 'transaction', entity_id: 7 }, 'Handwerk Muster'),
    member({ entity_type: 'document', entity_id: 3 }, 'Rechnung'),
  ]
})

describe('BasketMemberList', () => {
  it('lists every kind in the shared basket under the same headers', () => {
    const groups = groupsOf(mountList())
    expect(groups).toEqual(['Dokument (1)', 'Foto (1)', 'Buchung (1)'])
  })

  it('puts the module\'s own kind first', () => {
    const groups = groupsOf(mountList('transaction'))
    expect(groups[0]).toBe('Buchung (1)')
  })

  it('lets a module draw its own rows and keeps the shared rows for the rest', () => {
    const el = mountList('document', {
      'rows-document': () => h('li', { class: 'basket-row own-row' }, 'eigene Zeile'),
    })
    expect(el.querySelector('.own-row')).not.toBeNull()
    expect(el.textContent).not.toContain('Rechnung')
    expect(el.textContent).toContain('IMG_0001.jpg')
    expect(el.textContent).toContain('Handwerk Muster')
  })
})
