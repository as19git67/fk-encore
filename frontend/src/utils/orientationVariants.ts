/**
 * Portrait and landscape of the same motif (.claude/plans/orientierungs-varianten.md).
 *
 * The server decides which photos form a format group and ships the two
 * sides on `GalleryGridGroup.variants`. These helpers answer the questions
 * the views ask about one entry: which side is it on, is there another side,
 * which photos are over there, and which side fits the screen.
 */
import type { GalleryGridEntry, GalleryGridGroup } from '../api/gallery'
import type { PhotoOrientation, VariantMode } from '../api/photos'
import type { ScreenOrientation } from '../composables/useScreenOrientation'

export type VariantSide = 'portrait' | 'landscape'

export function otherSide(side: VariantSide): VariantSide {
  return side === 'portrait' ? 'landscape' : 'portrait'
}

/** German label of a side, as shown on the badge and the fullscreen button. */
export function sideLabel(side: VariantSide): string {
  return side === 'portrait' ? 'Hochformat' : 'Querformat'
}

/**
 * The side an entry sits on inside its format group, or null when the entry
 * is not part of one. A square or unmeasured photo never is.
 */
export function variantSideOf(
  entry: Pick<GalleryGridEntry, 'id' | 'orientation'> & { group?: GalleryGridGroup | null },
): VariantSide | null {
  const v = entry.group?.variants
  if (!v) return null
  if (v.portrait_ids.includes(entry.id)) return 'portrait'
  if (v.landscape_ids.includes(entry.id)) return 'landscape'
  return null
}

/**
 * Photo ids on the other side of the entry's format group, best-ranked
 * first. Empty when the entry has no other side.
 */
export function counterpartIds(
  entry: Pick<GalleryGridEntry, 'id' | 'orientation'> & { group?: GalleryGridGroup | null },
): number[] {
  const side = variantSideOf(entry)
  const v = entry.group?.variants
  if (!side || !v) return []
  return side === 'portrait' ? v.landscape_ids : v.portrait_ids
}

/** True when `candidate` is on the other side of `entry`'s format group. */
export function isCounterpartOf(
  entry: Pick<GalleryGridEntry, 'id' | 'orientation'> & { group?: GalleryGridGroup | null },
  candidate: Pick<GalleryGridEntry, 'id'>,
): boolean {
  return counterpartIds(entry).includes(candidate.id)
}

/**
 * The `variantMode` a list sends for the screen it is on. `all` while the
 * user asked to see the variants or is selecting: whoever selects, deletes or
 * baskets must see everything, so no action ever hits a photo that is not on
 * screen.
 */
export function variantModeFor(
  screen: ScreenOrientation,
  opts: { showVariants?: boolean; selectMode?: boolean },
): VariantMode {
  if (opts.showVariants || opts.selectMode) return 'all'
  return screen
}

/**
 * Whether a viewer that currently shows `shown` should switch to the other
 * side because the screen turned. Never while the user pinned a side by
 * choosing it, never without a counterpart, and only when the shown side
 * does not fit the screen while the other one does.
 */
export function shouldSwitchSide(opts: {
  shown: PhotoOrientation | null | undefined
  counterpart: PhotoOrientation | null | undefined
  screen: ScreenOrientation
  pinned: boolean
}): boolean {
  if (opts.pinned) return false
  if (!opts.shown || !opts.counterpart) return false
  if (opts.shown === 'square' || opts.counterpart === 'square') return false
  return opts.shown !== opts.screen && opts.counterpart === opts.screen
}

/**
 * The next list index in direction `dir` from `start` that is not the other
 * side of `current`'s format group. Paging through the list treats the two
 * sides as one photo, so when the list holds both (variantMode `all`) the
 * counterpart is not its own step. Returns null when the list ends first.
 */
export async function nextIndexSkippingCounterparts(
  current: (Pick<GalleryGridEntry, 'id' | 'orientation'> & { group?: GalleryGridGroup | null }) | null,
  start: number,
  dir: 1 | -1,
  total: number,
  loadEntryAt: (index: number) => Promise<Pick<GalleryGridEntry, 'id'> | null>,
): Promise<number | null> {
  let i = start
  while (i >= 0 && i < total) {
    if (!current || counterpartIds(current).length === 0) return i
    const entry = await loadEntryAt(i)
    if (entry && isCounterpartOf(current, entry)) {
      i += dir
      continue
    }
    return i
  }
  return null
}

/**
 * Orientation from pixel dimensions, the same bands the server uses
 * (`photoOrientation` in photo/orientation-variants.ts). Null while the
 * dimensions are unknown.
 */
export function orientationFromDimensions(
  width: number | null | undefined,
  height: number | null | undefined,
): PhotoOrientation | null {
  if (!width || !height || width <= 0 || height <= 0) return null
  const ratio = width / height
  if (ratio > 1.1) return 'landscape'
  if (ratio < 0.9) return 'portrait'
  return 'square'
}

/** True when the photos hold at least one portrait and one landscape frame. */
export function hasBothOrientations(
  photos: Array<{ orientation?: PhotoOrientation | null }>,
): boolean {
  let portrait = false
  let landscape = false
  for (const p of photos) {
    if (p.orientation === 'portrait') portrait = true
    else if (p.orientation === 'landscape') landscape = true
  }
  return portrait && landscape
}

/**
 * Whether two photos may face each other in a compare duel. In a format
 * pair, portrait against landscape is the wrong question — those duels are
 * skipped and the winners of both sides survive together. Squares and
 * unmeasured frames duel anyone.
 */
export function allowedDuel(
  a: PhotoOrientation | null | undefined,
  b: PhotoOrientation | null | undefined,
  formatPair: boolean,
): boolean {
  if (!formatPair) return true
  if (!a || !b || a === 'square' || b === 'square') return true
  return a === b
}

/**
 * The best-scored photo of each side (portrait, landscape) — the two that a
 * format pair keeps whatever the duel scores say. Ties go to the first.
 */
export function bestPerSide(
  photos: Array<{ id: number; orientation?: PhotoOrientation | null; score: number }>,
): number[] {
  const best = new Map<'portrait' | 'landscape', { id: number; score: number }>()
  for (const p of photos) {
    if (p.orientation !== 'portrait' && p.orientation !== 'landscape') continue
    const cur = best.get(p.orientation)
    if (!cur || p.score > cur.score) best.set(p.orientation, { id: p.id, score: p.score })
  }
  return [...best.values()].map((b) => b.id)
}

/**
 * The side to show large on this screen: the counterpart when the photo
 * does not fit the screen and the counterpart does, else the photo itself.
 * This is the one rule the recap player and the stream card share
 * (.claude/plans/orientierungs-varianten.md, stage 6). Squares and photos of
 * unknown shape are left alone.
 */
export function pickSideForScreen<P extends { orientation?: PhotoOrientation | null }, C extends { orientation?: PhotoOrientation | null }>(
  photo: P,
  counterpart: C | null | undefined,
  screen: ScreenOrientation,
): P | C {
  if (!counterpart) return photo
  if (shouldSwitchSide({ shown: photo.orientation, counterpart: counterpart.orientation, screen, pinned: false })) {
    return counterpart
  }
  return photo
}

/** Orientation of a feed item or counterpart from its stored dimensions. */
export function orientationOfDimensions(
  item: { width: number | null; height: number | null },
): PhotoOrientation | null {
  return orientationFromDimensions(item.width, item.height)
}
