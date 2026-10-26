/**
 * The narrowing of a photo book as the form edits it: a switch and a value
 * per minimum, so a value is kept while it is switched off. Used when a book
 * is made and when its narrowing is changed afterwards.
 */
import { PHOTO_BOOK_SUBJECTS, type PhotoBookNarrowing, type PhotoBookSource, type PhotoBookSubject, type PhotoBookWeights } from '../api/photoBooks'

export interface NarrowingDraft {
  useQuality: boolean
  qualityMin: number | null
  useAesthetic: boolean
  aestheticMin: number | null
  withoutFaces: boolean
  useMax: boolean
  maxPhotos: number | null
  seriesPicks: boolean
  weights: Record<PhotoBookSubject, number>
}

/** The form for a new book, or for a book's stored source. */
export function narrowingDraft(source?: PhotoBookSource | null): NarrowingDraft {
  const w = source?.weights ?? {}
  return {
    useQuality: source?.quality_min != null,
    qualityMin: source?.quality_min ?? 50,
    useAesthetic: source?.aesthetic_min != null,
    aestheticMin: source?.aesthetic_min ?? 50,
    withoutFaces: !!source?.without_recognisable_faces,
    useMax: source?.max_photos != null,
    maxPhotos: source?.max_photos ?? 120,
    seriesPicks: source?.group_picks_only !== false,
    weights: {
      people: w.people ?? 0,
      landscape: w.landscape ?? 0,
      nature: w.nature ?? 0,
      buildings: w.buildings ?? 0,
    },
  }
}

export function draftToNarrowing(d: NarrowingDraft): PhotoBookNarrowing {
  const weighted: PhotoBookWeights = {}
  for (const s of PHOTO_BOOK_SUBJECTS) if (d.weights[s.id]) weighted[s.id] = d.weights[s.id]
  return {
    qualityMin: d.useQuality ? d.qualityMin : null,
    aestheticMin: d.useAesthetic ? d.aestheticMin : null,
    withoutRecognisableFaces: d.withoutFaces,
    maxPhotos: d.useMax ? d.maxPhotos : null,
    weights: Object.keys(weighted).length ? weighted : null,
    groupPicksOnly: d.seriesPicks,
  }
}
