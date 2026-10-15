import { describe, expect, it } from 'vitest'
import { collectionRoute, memberRoute, typeListRoute } from './collectionRoute'

describe('collectionRoute', () => {
  it('opens a typed collection in its module list, limited to it', () => {
    expect(collectionRoute({ id: 4, entity_type: 'photo' })).toEqual({ name: 'fotos-gallery', query: { collection: '4' } })
    expect(collectionRoute({ id: 4, entity_type: 'meter' })).toEqual({ name: 'zaehler-list', query: { collection: '4' } })
    expect(collectionRoute({ id: 4, entity_type: 'transaction' })).toEqual({
      name: 'finance-collection-transactions',
      params: { collectionId: 4 },
    })
  })

  it('keeps document folders and dossiers on their folder page', () => {
    expect(collectionRoute({ id: 7, entity_type: 'document' })).toEqual({ name: 'dokumente-mappe', params: { id: 7 } })
    expect(collectionRoute({ id: 7, entity_type: 'document', kind: 'dossier' })).toEqual({ name: 'dokumente-mappe', params: { id: 7 } })
  })

  it('opens mixed collections and types without a list on the collection page', () => {
    for (const entity_type of [null, 'security', 'meter_reading'] as const) {
      expect(collectionRoute({ id: 9, entity_type })).toEqual({ name: 'sammelmappe-detail', params: { id: 9 } })
    }
  })
})

describe('typeListRoute and memberRoute', () => {
  it('name the module list and the item page where there is one', () => {
    expect(typeListRoute('document', 3)).toEqual({ name: 'dokumente-list', query: { collection: '3' } })
    expect(typeListRoute('security', 3)).toBeNull()
    expect(memberRoute('photo', 12)).toEqual({ name: 'fotos-gallery', query: { photoId: '12' } })
    expect(memberRoute('meter_reading', 12)).toBeNull()
  })
})
