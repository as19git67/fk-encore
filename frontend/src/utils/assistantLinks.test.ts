import { describe, expect, it } from 'vitest'
import { linkEntities, mentionedIds } from './assistantLinks'

describe('linkEntities', () => {
  it('links "Dokument mit der ID …" as one mention', () => {
    expect(linkEntities('(Der Text wurde aus dem Dokument mit der ID 123 extrahiert.)')).toEqual([
      { text: '(Der Text wurde aus dem ' },
      { text: 'Dokument mit der ID 123', to: '/dokumente/123' },
      { text: ' extrahiert.)' },
    ])
  })

  it('links a kind followed by its bare number', () => {
    expect(linkEntities('Buchung 4711 und Foto #12 passen.')).toEqual([
      { text: 'Buchung 4711', to: '/finanzen/umsaetze/4711' },
      { text: ' und ' },
      { text: 'Foto #12', to: '/fotos/galerie?photoId=12' },
      { text: ' passen.' },
    ])
  })

  it('links the id after a title and every id of a list', () => {
    expect(linkEntities('Dokument „Stromrechnung 2025“ (ID 31)')).toEqual([
      { text: 'Dokument „Stromrechnung 2025“ (' },
      { text: 'ID 31', to: '/dokumente/31' },
      { text: ')' },
    ])
    expect(linkEntities('Alben mit den IDs 3, 4 und 5.')).toEqual([
      { text: 'Alben mit den IDs 3', to: '/fotos/alben/3' },
      { text: ', ' },
      { text: '4', to: '/fotos/alben/4' },
      { text: ' und ' },
      { text: '5', to: '/fotos/alben/5' },
      { text: '.' },
    ])
  })

  it('knows meters, businesses, collections, accounts and persons', () => {
    const to = (s: string) => linkEntities(s).find((r) => r.to)?.to
    expect(to('Zähler 3')).toBe('/zaehler/3')
    expect(to('Betrieb 2')).toBe('/finanzen/betriebe/2')
    expect(to('Sammelmappe 5')).toBe('/sammelmappen/5')
    expect(to('Konto (ID 9)')).toBe('/finanzen/uebersicht/konto/9')
    expect(to('Person mit der ID 14')).toBe('/fotos/personen?personId=14')
  })

  it('leaves numbers that are no ids alone', () => {
    for (const s of [
      'Rechnung 2024 vom Juli',
      'Rechnung Nr. 4711',
      'Konto 1234567',
      'Fotos 2023',
      'Dokument 3,5 Seiten',
      'ID 123',
      'Das Dokument kam am 3. Mai. ID 7 gehört zu nichts.',
    ]) {
      expect(linkEntities(s).some((r) => r.to), s).toBe(false)
    }
  })

  it('keeps an id with the noun nearest before it', () => {
    expect(linkEntities('Das Foto aus der Buchung 8')).toEqual([
      { text: 'Das Foto aus der ' },
      { text: 'Buchung 8', to: '/finanzen/umsaetze/8' },
    ])
  })

  it('links Markdown links to app pages and leaves other links as text', () => {
    expect(linkEntities('Siehe [die Rechnung](/dokumente/7) oder [hier](https://example.test).')).toEqual([
      { text: 'Siehe ' },
      { text: 'die Rechnung', to: '/dokumente/7' },
      { text: ' oder [hier](https://example.test).' },
    ])
  })
})

describe('mentionedIds', () => {
  it('collects the ids of one kind in the order the answer names them', () => {
    const text = 'Am besten ist **Foto 12**, danach [das hier](/fotos/galerie?photoId=7&ids=1) und Bilder mit den IDs 5 und 12; dazu Dokument 99.'
    expect(mentionedIds(text, 'photo')).toEqual([12, 7, 5])
    expect(mentionedIds(text, 'document')).toEqual([99])
    expect(mentionedIds('Im Jahr 2020 gab es 300 Fotos.', 'photo')).toEqual([])
  })
})
