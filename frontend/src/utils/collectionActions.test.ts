import { describe, expect, it, vi } from 'vitest'
import { decodeMember, encodeMember, groupedSelectionActions } from './collectionActions'

describe('member keys', () => {
  it('round-trip type and id through one number', () => {
    for (const ref of [
      { entity_type: 'document' as const, entity_id: 1 },
      { entity_type: 'meter_reading' as const, entity_id: 9_876_543_210 },
      { entity_type: 'transaction' as const, entity_id: 42 },
    ]) {
      expect(decodeMember(encodeMember(ref))).toEqual(ref)
    }
    expect(encodeMember({ entity_type: 'photo', entity_id: 5 })).not.toBe(encodeMember({ entity_type: 'album', entity_id: 5 }))
  })
})

describe('groupedSelectionActions', () => {
  const generic = [{ key: 'remove', title: 'Aus der Sammelmappe nehmen', icon: 'pi pi-times', command: () => {} }]
  const reviewTx = vi.fn()
  const favPhoto = vi.fn()
  const catalog = {
    transaction: [{ key: 'reviewed', title: 'Als geprüft markieren', icon: 'pi pi-check', run: reviewTx }],
    photo: [{ key: 'favorite', title: 'Als Favorit markieren', icon: 'pi pi-heart', run: favPhoto }],
  }

  it('puts the generic actions first and names type and count when the selection is mixed', () => {
    const items = groupedSelectionActions(
      [
        { entity_type: 'transaction', entity_id: 1 },
        { entity_type: 'transaction', entity_id: 2 },
        { entity_type: 'photo', entity_id: 7 },
        { entity_type: 'meter', entity_id: 3 },
      ],
      generic,
      catalog,
    )
    expect(items.map((i) => i.title)).toEqual([
      'Aus der Sammelmappe nehmen',
      'Fotos (1): Als Favorit markieren',
      'Buchungen (2): Als geprüft markieren',
    ])
    items[2]!.command()
    expect(reviewTx).toHaveBeenCalledWith([1, 2])
  })

  it('reads like the module menu when only one type is selected', () => {
    const items = groupedSelectionActions([{ entity_type: 'photo', entity_id: 7 }], generic, catalog)
    expect(items.map((i) => i.title)).toEqual(['Aus der Sammelmappe nehmen', 'Als Favorit markieren'])
  })

  it('offers nothing without a selection', () => {
    expect(groupedSelectionActions([], generic, catalog)).toEqual([])
  })
})
