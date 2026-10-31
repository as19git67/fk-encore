/**
 * Links in an answer to the things it names by id: "Dokument mit der ID
 * 123", "Buchung 4711", "Foto #12", "Alben mit den IDs 3 und 5". The reader
 * taps the mention and lands on that item's page instead of searching for
 * the number.
 *
 * Only a mention with its kind is linked: an id alone ("ID 123") could be
 * anything, and a reference number ("Rechnung Nr. 4711") is no id. A
 * Markdown link to a page of the app (`[Rechnung](/dokumente/123)`) — the
 * routes the tools print — is linked as written; any other link stays text.
 */

export type EntityKind =
  | 'document'
  | 'photo'
  | 'transaction'
  | 'album'
  | 'person'
  | 'collection'
  | 'meter'
  | 'business'
  | 'account'

export interface LinkedText {
  text: string
  /** The page the text opens, an app path; absent for plain text. */
  to?: string
}

/** The page of one item. */
export function entityPath(kind: EntityKind, id: string): string {
  switch (kind) {
    case 'document': return `/dokumente/${id}`
    case 'photo': return `/fotos/galerie?photoId=${id}`
    case 'transaction': return `/finanzen/umsaetze/${id}`
    case 'album': return `/fotos/alben/${id}`
    case 'person': return `/fotos/personen?personId=${id}`
    case 'collection': return `/sammelmappen/${id}`
    case 'meter': return `/zaehler/${id}`
    case 'business': return `/finanzen/betriebe/${id}`
    case 'account': return `/finanzen/uebersicht/konto/${id}`
  }
}

/**
 * The words that name a kind, with their usual German endings (and the
 * English ones, since the model sometimes slips). `direct` marks the words
 * whose bare number is an id too ("Dokument 123"); the others need "ID" or
 * "#" in front of the number — "Rechnung 2024" is a year, "Konto 1234" an
 * account number.
 */
const NOUNS: Array<{ kind: EntityKind; words: string; direct?: string }> = [
  { kind: 'document', words: 'Dokument(?:e|s|es|en)?|Belege?s?|Briefe?s?|Schreiben|Rechnung(?:en)?|Vertrag|Verträge|Vertrags|Bescheide?s?|Notiz(?:en)?|documents?', direct: 'Dokument|document' },
  { kind: 'photo', words: 'Fotos?|Bild(?:er|es|s)?|photos?', direct: 'Foto|photo' },
  { kind: 'transaction', words: 'Buchung(?:en)?|Umsatz|Umsätze|Umsatzes|Transaktion(?:en)?|Lastschrift(?:en)?|Überweisung(?:en)?|transactions?|bookings?', direct: 'Buchung|Transaktion|transaction|booking' },
  { kind: 'album', words: 'Albums?|Alben', direct: 'Album' },
  { kind: 'person', words: 'Person(?:en)?', direct: 'Person' },
  { kind: 'collection', words: 'Sammelmappen?|Mappen?|Akten?', direct: 'Sammelmappe' },
  { kind: 'meter', words: 'Zählers?|Zählern|meters?', direct: 'Zähler' },
  { kind: 'business', words: 'Betriebe?s?|Betrieben', direct: 'Betrieb' },
  { kind: 'account', words: 'Kontos?|Konten|accounts?' },
]

const NOT_LETTER = '(?<![\\p{L}\\d])'
const NOUN_RE = new RegExp(`${NOT_LETTER}(?:${NOUNS.map((n) => `(${n.words})`).join('|')})(?![\\p{L}\\d])`, 'giu')
const DIRECT_RE = new RegExp(`^(?:${NOUNS.flatMap((n) => (n.direct ? [n.direct] : [])).join('|')})$`, 'iu')

/** "ID 123", "IDs: 3, 4 und 5", "#12": the numbers that follow. */
const ID_RE = new RegExp(`${NOT_LETTER}(?:IDs?\\s*:?\\s*|#\\s*)(\\d+)((?:\\s*(?:,|und|and|&|/)\\s*#?\\d+)*)(?!\\d)`, 'iu')
/** The words between a noun and its id that belong to the mention: "Dokument mit der ID". */
const JOINING = /^\s*(?:mit\s+(?:der|den|dem)\s+|mit\s+|with\s+(?:the\s+)?)?$/iu
/** A bare number right after the noun: "Dokument 123" — never "Dokument 3,5" or "Foto 1.200". */
const DIRECT_NUMBER = /^\s+#?(\d+)(?![\d]|[.,]\d)/u
/** The end of the sentence a mention lives in; its id never lies beyond. */
const SENTENCE_END = /[.!?;](?:\s|$)|\n/u
/** How far after the noun its id may stand ("Dokument „Stromrechnung 2025“ (ID 123)"). */
const WINDOW = 120

/** A Markdown link to a page of the app or to an item (`buchung:4711`); `//host` and `http:` are not. */
const MD_LINK_RE = /\[([^\]\n]+)\]\((\/(?!\/)[^\s)]*|[\p{L}]+:\s*#?\d+)\)/gu

/** The kind words of an item link, German as the prompt writes them, English as the model may slip. */
const LINK_KINDS: Record<string, EntityKind> = {
  dokument: 'document', document: 'document',
  foto: 'photo', photo: 'photo', bild: 'photo',
  buchung: 'transaction', umsatz: 'transaction', transaktion: 'transaction', transaction: 'transaction',
  album: 'album',
  person: 'person',
  sammelmappe: 'collection', mappe: 'collection', collection: 'collection',
  zaehler: 'meter', zähler: 'meter', meter: 'meter',
  betrieb: 'business', business: 'business',
  konto: 'account', account: 'account',
}

/** The page an item link names, or undefined for a kind the app does not know. */
function linkTarget(target: string): string | undefined {
  if (target.startsWith('/')) return target
  const m = /^([\p{L}]+):\s*#?(\d+)$/u.exec(target)
  const kind = m ? LINK_KINDS[m[1]!.toLowerCase()] : undefined
  return kind ? entityPath(kind, m![2]!) : undefined
}

function kindOf(groups: Array<string | undefined>): EntityKind {
  const i = groups.findIndex((g) => g !== undefined)
  return NOUNS[i]!.kind
}

/** Splits plain text into runs, each mention of an item by id a run with its page. */
export function linkEntities(text: string): LinkedText[] {
  const out: LinkedText[] = []
  let last = 0

  // Markdown links first; the text between them is searched for mentions.
  for (const m of text.matchAll(MD_LINK_RE)) {
    const at = m.index ?? 0
    out.push(...mentions(text.slice(last, at)))
    const to = linkTarget(m[2]!)
    out.push(to ? { text: m[1]!, to } : { text: m[1]! })
    last = at + m[0].length
  }
  if (last === 0) return mentions(text)
  out.push(...mentions(text.slice(last)))
  return out.filter((r) => r.text !== '')

  function mentions(part: string): LinkedText[] {
    const runs: LinkedText[] = []
    let done = 0
    const push = (from: number, to: number, path?: string) => {
      if (from > done) runs.push({ text: part.slice(done, from) })
      runs.push(path ? { text: part.slice(from, to), to: path } : { text: part.slice(from, to) })
      done = to
    }
    const nouns = [...part.matchAll(NOUN_RE)]
    for (let n = 0; n < nouns.length; n++) {
      const noun = nouns[n]!
      const start = noun.index ?? 0
      if (start < done) continue
      const end = start + noun[0].length
      const kind = kindOf(noun.slice(1))
      // The id belongs to this noun only up to the next noun or the end of the sentence.
      let windowEnd = Math.min(part.length, end + WINDOW)
      const next = nouns[n + 1]
      if (next && (next.index ?? 0) < windowEnd) windowEnd = next.index ?? windowEnd
      const window = part.slice(end, windowEnd)
      const stop = SENTENCE_END.exec(window)
      const scope = stop ? window.slice(0, stop.index) : window

      const ids = ID_RE.exec(scope)
      if (ids) {
        const idsAt = end + ids.index
        const first = ids[1]!
        const firstEnd = idsAt + ids[0].length - (ids[2]?.length ?? 0)
        // "Dokument mit der ID 123" is one link; "Dokument „…“ (ID 123)" links the id.
        push(JOINING.test(scope.slice(0, ids.index)) ? start : idsAt, firstEnd, entityPath(kind, first))
        if (ids[2]) {
          for (const more of ids[2].matchAll(/#?\d+/gu)) {
            const at = firstEnd + (more.index ?? 0)
            push(at, at + more[0].length, entityPath(kind, more[0].replace('#', '')))
          }
        }
        continue
      }
      if (DIRECT_RE.test(noun[0])) {
        const direct = DIRECT_NUMBER.exec(part.slice(end))
        if (direct) push(start, end + direct[0].length, entityPath(kind, direct[1]!))
      }
    }
    if (done < part.length) runs.push({ text: part.slice(done) })
    return runs
  }
}

/**
 * The ids of one kind an answer links to, in the order it names them: the
 * photo it picked as "das beste", the documents it settled on. The list
 * under the answer shows these first — the hits of the search are what the
 * model looked through, not what it answered.
 */
export function mentionedIds(text: string, kind: EntityKind): number[] {
  const prefix = entityPath(kind, '')
  const ids: number[] = []
  for (const run of linkEntities(text)) {
    if (!run.to?.startsWith(prefix)) continue
    const m = /^(\d+)(?:[&#/]|$)/u.exec(run.to.slice(prefix.length))
    const id = m ? Number(m[1]) : NaN
    if (Number.isSafeInteger(id) && id > 0 && !ids.includes(id)) ids.push(id)
  }
  return ids
}
