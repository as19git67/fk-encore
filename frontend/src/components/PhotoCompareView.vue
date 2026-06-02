<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import Button from 'primevue/button'
import Popover from 'primevue/popover'
import HeicImage from './HeicImage.vue'
import {
  updatePhotoCuration,
  reviewPhotoGroup,
  acceptAiPick,
  getPhotoDetailsBatch,
  getPhotoFaces,
  getPhotoLandmarks,
  type Photo,
  type PhotoGroup,
  type CurationStatus,
  type Face,
  type LandmarkItem,
} from '../api/photos'
import { photoThumbnailSrc } from '../composables/useTransformedPhotosIndex'
import { useAuthStore } from '../stores/auth'
import {
  computeBboxZoom,
  computeSyncBboxZoom,
  pickPrimaryBbox,
  pickBboxAtPoint,
  findFaceForPerson,
  clickPointToImageCoords,
  type ZoomComputation,
} from '../utils/compareZoom'

const helpPopover = ref()

// ── Responsive width/height tracking ──
const windowWidth = ref(window.innerWidth)
const windowHeight = ref(window.innerHeight)
function onResize() { windowWidth.value = window.innerWidth; windowHeight.value = window.innerHeight }
const isNarrow = computed(() => windowWidth.value < 900)
const isVeryNarrow = computed(() => windowWidth.value < 500)
/** True when height > width (portrait orientation — stack photos top/bottom). */
const isPortrait = computed(() => windowHeight.value > windowWidth.value)

// On touch devices the first tap on a button with a hover tooltip only shows
// the tooltip (hover emulation) and a second tap is needed to actually click.
// Disable the toolbar tooltips on no-hover / coarse-pointer devices; desktop
// keeps them on real hover.
const hoverlessMql = window.matchMedia('(hover: none), (pointer: coarse)')
const isTouch = ref(hoverlessMql.matches)
function onHoverCapabilityChange(e: MediaQueryListEvent) { isTouch.value = e.matches }

const props = defineProps<{
  group: PhotoGroup
  allPhotos: Photo[]
  totalUnreviewed: number
  // When true, suppress the "Fertig + Weiter" jump-to-next-group
  // action. Set by the Gruppenreview-Queue, which manages its own
  // navigation: closing this modal returns the user to the queue card
  // list instead of cascading into the next unreviewed group.
  singleGroupMode?: boolean
}>()

const emit = defineEmits<{
  close: []
  reviewed: []
  next: [groupId: number]
}>()

// Members not in props.allPhotos (e.g. excluded by the album's active filter)
// are fetched directly so the compare view sees every still-visible member.
// Photos that were ALREADY hidden before opening are deliberately left out —
// there is nothing to re-decide about a photo the user has already deselected.
const fetchedMembers = ref(new Map<number, Photo>())

async function loadMissingMembers() {
  const missing = props.group.photo_ids.filter(
    (id) => !props.allPhotos.some((p) => p.id === id) && !fetchedMembers.value.has(id)
  )
  if (missing.length === 0) return
  try {
    const res = await getPhotoDetailsBatch(missing)
    const next = new Map(fetchedMembers.value)
    // Skip members that were already hidden — don't resurface them.
    for (const p of res.photos) {
      if (p.curation_status === 'hidden') continue
      next.set(p.id, p)
    }
    fetchedMembers.value = next
    syncCuration()
  } catch (err) {
    console.warn('[PhotoCompareView] failed to load missing group members', err)
  }
}

const groupPhotos = computed(() => {
  return props.group.photo_ids
    .map((id) => props.allPhotos.find((p) => p.id === id) ?? fetchedMembers.value.get(id))
    // Exclude members that were already hidden when the review opened (an
    // in-session hide keeps its tile via localCuration, so undo still works).
    .filter((p): p is Photo => !!p && p.curation_status !== 'hidden')
})

// ── Local curation state ──
const localCuration = ref(new Map<number, CurationStatus>())

function syncCuration() {
  const map = new Map<number, CurationStatus>()
  for (const photo of groupPhotos.value) {
    map.set(photo.id, photo.curation_status)
  }
  localCuration.value = map
}

function getCuration(id: number): CurationStatus {
  return localCuration.value.get(id) ?? 'visible'
}

async function setCuration(id: number, status: CurationStatus) {
  const current = getCuration(id)
  const newStatus = current === status ? 'visible' : status
  localCuration.value = new Map(localCuration.value).set(id, newStatus)
  try {
    await updatePhotoCuration(id, newStatus)
  } catch {
    localCuration.value = new Map(localCuration.value).set(id, current)
  }
}

// ── AI quality score helpers ──

/** Returns the ai_quality_score for a photo, or null if not yet scored. */
function getAiScore(photoId: number): number | null {
  const photo = getPhotoById(photoId)
  return photo?.ai_quality_score ?? null
}

/** CSS class for the quality badge colour: green / yellow / red. */
function aiScoreClass(photoId: number): string {
  const s = getAiScore(photoId)
  if (s === null) return 'ai-score-unknown'
  if (s >= 0.65) return 'ai-score-good'
  if (s >= 0.40) return 'ai-score-medium'
  return 'ai-score-poor'
}

/** Human-readable label (percentage). */
function aiScoreLabel(photoId: number): string {
  const s = getAiScore(photoId)
  if (s === null) return '?'
  return `${Math.round(s * 100)}%`
}

const detailLabels: Record<string, string> = {
  sharpness: 'Schärfe',
  contrast: 'Kontrast',
  exposure: 'Belichtung',
  clip_aesthetics: 'Ästhetik',
  clip_composition: 'Komposition',
  clip_technical: 'Technik',
  face_sharpness: 'Gesichtsschärfe',
  eyes_open: 'Augen offen',
  face_composition: 'Gesichtsposition',
}

function aiScoreTooltip(photoId: number): string {
  const photo = getPhotoById(photoId)
  const s = photo?.ai_quality_score
  let text = `KI-Qualität: ${s !== undefined && s !== null ? Math.round(s * 100) + '%' : '?'}`
  const details = photo?.ai_quality_details
  if (details && Object.keys(details).length > 0) {
    const lines = Object.entries(details)
      .map(([k, v]) => `${detailLabels[k] ?? k}: ${Math.round(v * 100)}%`)
    text += '\n' + lines.join(' · ')
  }
  return text
}

// ── Eyes-closed hint (Track N / #81) ─────────────────────────────────────
// The `eyes_open` AI signal is weak — the score sits in a narrow band
// (roughly 0.35–0.67 in the user's library, see docs/ai-auto-pick.md). An
// absolute threshold would flag photos with obviously open eyes whenever
// their score happens to land at 0.45. We therefore surface the hint only
// when there's a meaningful RELATIVE gap: in the compare-phase against
// the partner photo of the pair, in the review-grid against the
// best-eyes photo of the whole group.
const EYES_DELTA_THRESHOLD = 0.15

function eyesOpenScore(photoId: number): number | null {
  const v = getPhotoById(photoId)?.ai_quality_details?.eyes_open
  return typeof v === 'number' ? v : null
}

/** Compare-phase variant: badge fires when the OTHER photo of the
 *  current pair has eyes_open notably higher than this photo. */
function hasClosedEyesVsPartner(photoId: number): boolean {
  if (!currentPair.value) return false
  const [a, b] = currentPair.value
  const otherId = photoId === a ? b : a
  const my = eyesOpenScore(photoId)
  const other = eyesOpenScore(otherId)
  if (my === null || other === null) return false
  return other - my > EYES_DELTA_THRESHOLD
}

/** Review-phase variant: badge fires when this photo's eyes_open sits
 *  notably below the best-eyes photo of the displayed group. */
function hasClosedEyesInGroup(photoId: number): boolean {
  const my = eyesOpenScore(photoId)
  if (my === null) return false
  let best = -Infinity
  for (const p of groupPhotos.value) {
    const s = p.ai_quality_details?.eyes_open
    if (typeof s === 'number' && s > best) best = s
  }
  if (best === -Infinity) return false
  return best - my > EYES_DELTA_THRESHOLD
}

function eyesClosedTooltip(photoId: number): string {
  const s = eyesOpenScore(photoId)
  const pct = s !== null ? `${Math.round(s * 100)}%` : '?'
  if (!currentPair.value) return `Augen wirken geschlossen (${pct})`
  const [a, b] = currentPair.value
  const otherId = photoId === a ? b : a
  const otherScore = eyesOpenScore(otherId)
  const otherPct = otherScore !== null ? `${Math.round(otherScore * 100)}%` : '?'
  return `Augen wirken geschlossen (${pct}) — das andere Foto liegt bei ${otherPct}.`
}

/**
 * Whether the given photo id sits in the group's KI-Pick set.
 *
 * Surfaced in the side-by-side + review-grid tiles so the user can tell
 * at a glance which photo the auto-pick would keep, without having to
 * cross-reference the review-queue card. Returns false once the group
 * has been reviewed (the pick set is only relevant for the unreviewed
 * decision).
 */
function isAiPicked(photoId: number): boolean {
  if (props.group.reviewed_at) return false
  const ids = props.group.ai_picked_photo_ids
  return Array.isArray(ids) && ids.includes(photoId)
}

/**
 * Whether to render the "KI-Pick" badge on a tile.
 *
 * The auto-pick is computed at the group level: when a member photo has
 * no quality signals (its `ai_quality_score` is null and the % rating
 * renders as "?"), the scorer falls back to a neutral 0.5 for every
 * signal, so any "pick" there is meaningless. Surfacing "KI-Pick" next
 * to a "?" rating reads as a contradiction, so we hide the badge until a
 * real score exists for the photo.
 */
function showAiPickBadge(photoId: number): boolean {
  return isAiPicked(photoId) && getAiScore(photoId) !== null
}

/**
 * Pre-populate comparison scores from AI quality so the user can skip the
 * manual pairwise phase and jump straight to the review grid.
 *
 * When all photos have similar absolute scores (range < 0.12), scores are
 * normalised within the group so small differences become visible.
 * Otherwise the absolute mapping (ai=0.0→-3, ai=0.5→0, ai=1.0→+3) is used.
 */
const aiPreselectionIsRelative = ref(false)

function applyAiPreselection(): void {
  const map = new Map<number, number>()
  const scored = groupPhotos.value.filter(p => p.ai_quality_score !== undefined && p.ai_quality_score !== null)

  let useRelative = false
  let minScore = 0
  let range = 0

  if (scored.length >= 2) {
    minScore = Math.min(...scored.map(p => p.ai_quality_score!))
    const maxScore = Math.max(...scored.map(p => p.ai_quality_score!))
    range = maxScore - minScore
    useRelative = range > 0 && range < 0.12
  }

  for (const photo of groupPhotos.value) {
    const s = photo.ai_quality_score
    if (s === undefined || s === null) {
      map.set(photo.id, 0)
    } else if (useRelative) {
      // Normalize within group: worst → -3, best → +3
      const rel = (s - minScore) / range
      map.set(photo.id, Math.round((rel - 0.5) * 6))
    } else {
      map.set(photo.id, Math.round((s - 0.5) * 6))
    }
  }

  aiPreselectionIsRelative.value = useRelative
  scores.value = map
  phase.value = 'review'
  currentPair.value = null
}

// ── Swiss-system pairwise comparison ──

// Score per photo: higher = more likely to keep
const scores = ref(new Map<number, number>())
// Set of completed pair keys ("idA-idB" where idA < idB)
const comparedPairs = ref(new Set<string>())
// Current pair being compared
const currentPair = ref<[number, number] | null>(null)
// Phase: 'compare' = pairwise phase, 'review' = summary phase
const phase = ref<'compare' | 'review'>('compare')
// Whether the user has accepted or rejected the suggestion
const reviewDecided = ref(false)
// Total comparisons done (for progress display)
const comparisonsDone = ref(0)

function pairKey(a: number, b: number): string {
  return a < b ? `${a}-${b}` : `${b}-${a}`
}

// Exact total unique pairs: n * (n - 1) / 2
// Also keep the previous heuristic as an "estimated" value for quick-progress hints.
const pairCount = computed(() => {
  const n = groupPhotos.value.length
  if (n < 2) return 0
  return (n * (n - 1)) / 2
})

// Heuristic estimate (~n to 1.5n) kept for quick estimation if desired
const estimatedTotal = computed(() => {
  const n = groupPhotos.value.length
  if (n <= 2) return 1
  return Math.ceil(n * 1.3)
})

// Swiss-system: pick the best next pair (closest scores, not yet compared)
function pickNextPair(): [number, number] | null {
  const photos = groupPhotos.value
  if (photos.length < 2) return null

  // Build candidates: all pairs not yet compared
  const candidates: { pair: [number, number]; scoreDiff: number }[] = []
  for (let i = 0; i < photos.length; i++) {
    for (let j = i + 1; j < photos.length; j++) {
      const a = photos[i]!.id
      const b = photos[j]!.id
      if (comparedPairs.value.has(pairKey(a, b))) continue
      const sa = scores.value.get(a) ?? 0
      const sb = scores.value.get(b) ?? 0
      candidates.push({ pair: [a, b], scoreDiff: Math.abs(sa - sb) })
    }
  }

  if (candidates.length === 0) return null

  // Sort by score difference (Swiss: pair similar scores first)
  candidates.sort((a, b) => a.scoreDiff - b.scoreDiff)
  return candidates[0]!.pair
}

const hasNextPair = computed(() => !!pickNextPair())

function initScores() {
  const map = new Map<number, number>()
  for (const photo of groupPhotos.value) {
    map.set(photo.id, 0)
  }
  scores.value = map
  comparedPairs.value = new Set()
  comparisonsDone.value = 0
  phase.value = 'compare'
  reviewDecided.value = false
  currentPair.value = pickNextPair()
  // If only 1 photo or no pairs possible, go straight to review
  if (!currentPair.value) {
    phase.value = 'review'
  }
}

function advanceToNext() {
  const next = pickNextPair()
  if (next) {
    currentPair.value = next
  } else {
    // All pairs compared or enough rounds done — go to review
    phase.value = 'review'
    currentPair.value = null
  }
}

function checkAutoAdvance() {
  // After ~n comparisons, if there's a clear separation, auto-advance to review
  const n = groupPhotos.value.length
  if (comparisonsDone.value >= n) {
    const sortedScores = [...scores.value.entries()].sort((a, b) => a[1] - b[1])
    if (sortedScores.length >= 3) {
      // Check if there's a gap between the lowest and the rest
      const lowest = sortedScores[0]![1]
      const secondLowest = sortedScores[1]![1]
      if (secondLowest - lowest >= 2) {
        // Clear separation exists — suggest review
        phase.value = 'review'
        currentPair.value = null
        return true
      }
    }
  }
  return false
}

function chooseHide(photoId: number) {
  if (!currentPair.value) return
  const [a, b] = currentPair.value
  const otherId = photoId === a ? b : a

  // Loser gets -1, winner gets +1
  scores.value = new Map(scores.value)
    .set(photoId, (scores.value.get(photoId) ?? 0) - 1)
    .set(otherId, (scores.value.get(otherId) ?? 0) + 1)

  comparedPairs.value = new Set(comparedPairs.value).add(pairKey(a, b))
  comparisonsDone.value++

  if (!checkAutoAdvance()) {
    advanceToNext()
  }
}

function chooseDraw() {
  if (!currentPair.value) return
  const [a, b] = currentPair.value

  // Both scores unchanged, just mark as compared
  comparedPairs.value = new Set(comparedPairs.value).add(pairKey(a, b))
  comparisonsDone.value++

  if (!checkAutoAdvance()) {
    advanceToNext()
  }
}

function skipPair() {
  // Don't mark as compared, just pick a different pair
  if (!currentPair.value) return
  const skippedKey = pairKey(currentPair.value[0], currentPair.value[1])

  // Temporarily add to compared to pick a different pair, then remove
  const tempCompared = new Set(comparedPairs.value)
  tempCompared.add(skippedKey)

  const photos = groupPhotos.value
  let best: [number, number] | null = null
  let bestDiff = Infinity
  for (let i = 0; i < photos.length; i++) {
    for (let j = i + 1; j < photos.length; j++) {
      const a = photos[i]!.id
      const b = photos[j]!.id
      if (tempCompared.has(pairKey(a, b))) continue
      const sa = scores.value.get(a) ?? 0
      const sb = scores.value.get(b) ?? 0
      const diff = Math.abs(sa - sb)
      if (diff < bestDiff) {
        bestDiff = diff
        best = [a, b]
      }
    }
  }

  if (best) {
    currentPair.value = best
  } else {
    // No other pairs available, go to review
    phase.value = 'review'
    currentPair.value = null
  }
}

// Photos sorted by score (lowest first = candidates for hiding)
const sortedPhotos = computed(() => {
  return [...groupPhotos.value].sort((a, b) => {
    const sa = scores.value.get(a.id) ?? 0
    const sb = scores.value.get(b.id) ?? 0
    return sa - sb
  })
})

// Suggested hide threshold: photos with negative score
const suggestedHideIds = computed(() => {
  return sortedPhotos.value
    .filter(p => (scores.value.get(p.id) ?? 0) < 0)
    .map(p => p.id)
})

const hasSuggestions = computed(() => suggestedHideIds.value.length > 0)

function applySuggestions() {
  for (const id of suggestedHideIds.value) {
    if (getCuration(id) !== 'hidden') {
      setCuration(id, 'hidden')
    }
  }
  reviewDecided.value = true
}

function rejectSuggestions() {
  reviewDecided.value = true
}

// ── KI-Auto-Pick (Track I) ──
// The server pre-computed `ai_picked_photo_ids` for unreviewed groups
// (see /photos/find-groups + /photos/groups/recompute-ai-picks). When
// the user clicks "KI-Vorschlag übernehmen" we delegate to the backend
// endpoint, which hides every non-picked member via photo_curation
// (skipping favorites) and marks the group reviewed in a single
// transaction. After it returns we emit `reviewed` so the parent
// gallery refreshes its caches.
const hasAiPick = computed(() => {
  const ids = props.group.ai_picked_photo_ids
  return Array.isArray(ids) && ids.length > 0 && !props.group.reviewed_at
})
const aiPickButsy = ref(false)

async function acceptAiPickAction() {
  if (aiPickButsy.value) return
  aiPickButsy.value = true
  try {
    await acceptAiPick(props.group.id)
    emit('reviewed')
    emit('close')
  } catch (err) {
    console.error('[PhotoCompareView] acceptAiPick failed', err)
  } finally {
    aiPickButsy.value = false
  }
}

function goBackToCompare() {
  phase.value = 'compare'
  reviewDecided.value = false
  currentPair.value = pickNextPair()
  if (!currentPair.value) {
    // All pairs exhausted, stay in review
    phase.value = 'review'
  }
}

// ── Done / Next ──

async function handleDone() {
  try {
    await reviewPhotoGroup(props.group.id, props.group.photo_ids)
    // Emit `reviewed` first so the parent's local-state mirror runs
    // (e.g. flipping group.reviewed in the cache) before the overlay
    // tears down on `close`. Without this, plain `close` covers both
    // "user finished review" and "user dismissed via X" — the parent
    // can't tell them apart.
    emit('reviewed')
    emit('close')
  } catch (err: any) {
    console.error('Failed to review group:', err)
  }
}

async function handleDoneAndNext() {
  try {
    await reviewPhotoGroup(props.group.id, props.group.photo_ids)
    emit('next', props.group.id)
  } catch (err: any) {
    console.error('Failed to review group:', err)
  }
}

// ── Keyboard shortcuts ──

function handleKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    if (anyZoomActive.value) {
      resetZoom()
      e.preventDefault()
      return
    }
    if (phase.value === 'review') {
      goBackToCompare()
    } else {
      emit('close')
    }
    return
  }

  // During compare phase: arrow keys / number keys
  if (phase.value === 'compare' && currentPair.value) {
    if (e.key === 'ArrowLeft' || e.key === '1') {
      chooseHide(currentPair.value[0])
      e.preventDefault()
    } else if (e.key === 'ArrowRight' || e.key === '2') {
      chooseHide(currentPair.value[1])
      e.preventDefault()
    } else if (e.key === ' ' || e.key === 'u' || e.key === 'U') {
      chooseDraw()
      e.preventDefault()
    } else if (e.key === 's' || e.key === 'S') {
      skipPair()
      e.preventDefault()
    }
  }
}

type ZoomPick = NonNullable<ReturnType<typeof pickPrimaryBbox>>
interface ActiveZoom {
  pick: ZoomPick
  computation: ZoomComputation
}

// ── Zoom-to-face / landmark (Track N / #79) ───────────────────────────────
// Double-clicking a photo zooms it so the primary face (or landmark) is
// centred. The sync-zoom toggle is a persistent mode setting — when on,
// double-tap / reset apply to BOTH photos; when off, they apply only to
// the clicked photo. Toggling sync ON propagates an existing single-photo
// zoom to the partner. Toggling OFF leaves the zoom state untouched.
// Sync-Zoom defaults ON: when reviewing similar photos, the user almost
// always wants both sides of the pair to zoom to the same person at the
// same on-screen size. Turn off only when they want to inspect one
// photo in isolation.
const syncZoomEnabled = ref(true)
const zoomByPhoto = ref(new Map<number, ActiveZoom>())
const facesCache = ref(new Map<number, Face[]>())
const landmarksCache = ref(new Map<number, LandmarkItem[]>())

const ZOOM_TARGET_FRACTION = 0.45
const ZOOM_MAX = 5

// Non-reactive registry of the per-photo container element. Used at zoom
// time to read live dimensions from the DOM so the zoom path doesn't
// depend on a separately-cached `@load` event landing first — that race
// was the cause of "double-tap reacts only sometimes" (Track N / #79).
const photoContainers = new Map<number, HTMLElement>()

function recordViewport(photoId: number, el: HTMLElement | null) {
  if (el) {
    photoContainers.set(photoId, el)
  } else {
    photoContainers.delete(photoId)
  }
}

function getViewport(photoId: number) {
  const container = photoContainers.get(photoId)
  if (!container) return null
  const rect = container.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0) return null
  const img = container.querySelector('img')
  if (!img || !img.naturalWidth || !img.naturalHeight) return null
  return {
    width: rect.width,
    height: rect.height,
    photoWidth: img.naturalWidth,
    photoHeight: img.naturalHeight,
  }
}

async function ensureBboxData(photoId: number): Promise<{ faces: Face[]; landmarks: LandmarkItem[] }> {
  if (!facesCache.value.has(photoId)) {
    try {
      const res = await getPhotoFaces(photoId)
      facesCache.value = new Map(facesCache.value).set(photoId, res.faces ?? [])
    } catch (err) {
      console.warn('[PhotoCompareView] face load failed', photoId, err)
      facesCache.value = new Map(facesCache.value).set(photoId, [])
    }
  }
  // Only fetch landmarks if no usable faces are around — saves a round-trip.
  let faces = facesCache.value.get(photoId) ?? []
  const haveUsableFaces = faces.some((f) => !f.ignored)
  if (!haveUsableFaces && !landmarksCache.value.has(photoId)) {
    try {
      const res = await getPhotoLandmarks(photoId)
      landmarksCache.value = new Map(landmarksCache.value).set(photoId, res.landmarks ?? [])
    } catch (err) {
      console.warn('[PhotoCompareView] landmark load failed', photoId, err)
      landmarksCache.value = new Map(landmarksCache.value).set(photoId, [])
    }
  }
  return {
    faces,
    landmarks: landmarksCache.value.get(photoId) ?? [],
  }
}

function resetZoom() {
  if (zoomByPhoto.value.size === 0) return
  zoomByPhoto.value = new Map()
}

function resetZoomFor(photoId: number) {
  if (!zoomByPhoto.value.has(photoId)) return
  const next = new Map(zoomByPhoto.value)
  next.delete(photoId)
  zoomByPhoto.value = next
}

function isZoomed(photoId: number): boolean {
  return zoomByPhoto.value.has(photoId)
}

const anyZoomActive = computed(() => zoomByPhoto.value.size > 0)

function zoomStyle(photoId: number): Record<string, string> {
  const z = zoomByPhoto.value.get(photoId)
  if (!z) return {}
  return {
    transform: z.computation.transform,
    transformOrigin: z.computation.transformOrigin,
    transition: 'transform 220ms ease-out',
  }
}

function applySingleZoom(photoId: number, pick: ZoomPick, vp: ReturnType<typeof getViewport>) {
  if (!vp) return
  const z = computeBboxZoom(pick.bbox, vp, {
    targetFraction: ZOOM_TARGET_FRACTION,
    maxZoom: ZOOM_MAX,
  })
  if (!z) return
  zoomByPhoto.value = new Map(zoomByPhoto.value).set(photoId, { pick, computation: z })
}

/** Find the partner photo's bbox that best matches the source pick — same
 *  person if available, otherwise that photo's primary pick. Returns
 *  `null` when nothing usable is around. */
async function pickPartnerBbox(
  srcPick: ZoomPick,
  partnerId: number,
): Promise<ZoomPick | null> {
  const data = await ensureBboxData(partnerId)
  if (srcPick.person_id) {
    const matched = findFaceForPerson(data.faces, srcPick.person_id)
    if (matched) {
      return { source: 'face', bbox: matched, person_id: srcPick.person_id }
    }
  }
  const fallback = pickPrimaryBbox(data.faces, data.landmarks)
  return fallback
}

async function applySyncZoom(
  srcId: number,
  srcPick: ZoomPick,
  srcVp: NonNullable<ReturnType<typeof getViewport>>,
  partnerId: number,
) {
  const partnerVp = getViewport(partnerId)
  const partnerPick = await pickPartnerBbox(srcPick, partnerId)

  // No partner bbox or viewport → just zoom the clicked one.
  if (!partnerPick || !partnerVp) {
    applySingleZoom(srcId, srcPick, srcVp)
    return
  }

  const { a: zSrc, b: zPartner } = computeSyncBboxZoom(
    { bbox: srcPick.bbox, viewport: srcVp },
    { bbox: partnerPick.bbox, viewport: partnerVp },
    { targetFraction: ZOOM_TARGET_FRACTION, maxZoom: ZOOM_MAX },
  )
  const next = new Map(zoomByPhoto.value)
  if (zSrc) next.set(srcId, { pick: srcPick, computation: zSrc })
  if (zPartner) next.set(partnerId, { pick: partnerPick, computation: zPartner })
  zoomByPhoto.value = next
}

async function onPhotoDoubleClick(
  photoId: number,
  click?: { clientX: number; clientY: number; container: HTMLElement },
) {
  if (!currentPair.value) return
  const [a, b] = currentPair.value
  const otherId = photoId === a ? b : a

  // Already-zoomed photo: double-tap is a "toggle off" with scope set by
  // the sync mode. Sync ON resets both photos so the pair stays in sync;
  // sync OFF resets only this photo.
  if (isZoomed(photoId)) {
    if (syncZoomEnabled.value) resetZoom()
    else resetZoomFor(photoId)
    return
  }

  // Pull bbox data for the clicked photo; the partner photo is loaded
  // separately inside applySyncZoom (only when needed).
  const clickedData = await ensureBboxData(photoId)
  const clickedVp = getViewport(photoId)
  if (!clickedVp) return

  // Group photos: prefer the face at the click position over the global
  // primary pick so a double-click on Bob zooms to Bob, not Alice.
  let clickedPick: ZoomPick | null = null
  if (click) {
    const rect = click.container.getBoundingClientRect()
    const point = clickPointToImageCoords(
      clickedVp,
      { left: rect.left, top: rect.top },
      click.clientX,
      click.clientY,
    )
    if (point) {
      clickedPick = pickBboxAtPoint(clickedData.faces, clickedData.landmarks, point)
    }
  }
  if (!clickedPick) {
    clickedPick = pickPrimaryBbox(clickedData.faces, clickedData.landmarks)
  }
  if (!clickedPick) return

  if (syncZoomEnabled.value) {
    await applySyncZoom(photoId, clickedPick, clickedVp, otherId)
  } else {
    applySingleZoom(photoId, clickedPick, clickedVp)
  }
}

/** Reset button (🔍−) handler. Sync ON → resets both photos so the pair
 *  stays in sync; sync OFF → resets only the photo whose button was hit. */
function onResetZoomClick(photoId: number) {
  if (syncZoomEnabled.value) resetZoom()
  else resetZoomFor(photoId)
}

/** Sync-Zoom toggle handler. Turning ON: leaves any existing zoom alone,
 *  but if exactly one photo is currently zoomed, mirror its zoom to the
 *  partner so the pair becomes in-sync. Turning OFF: leaves the zoom
 *  state untouched — both photos keep their current transforms. */
async function onSyncToggleClick() {
  const turningOn = !syncZoomEnabled.value
  syncZoomEnabled.value = turningOn
  if (!turningOn) return
  if (!currentPair.value) return
  const [a, b] = currentPair.value
  const aZoom = zoomByPhoto.value.get(a)
  const bZoom = zoomByPhoto.value.get(b)
  if (aZoom && !bZoom) {
    const srcVp = getViewport(a)
    if (srcVp) await applySyncZoom(a, aZoom.pick, srcVp, b)
  } else if (!aZoom && bZoom) {
    const srcVp = getViewport(b)
    if (srcVp) await applySyncZoom(b, bZoom.pick, srcVp, a)
  }
}

function onPhotoMouseDblClick(photoId: number, evt: MouseEvent) {
  const container = evt.currentTarget as HTMLElement | null
  if (!container) {
    void onPhotoDoubleClick(photoId)
    return
  }
  void onPhotoDoubleClick(photoId, {
    clientX: evt.clientX,
    clientY: evt.clientY,
    container,
  })
}

// ── Swipe-to-discard (fling a photo off-screen) ──────────────────────────
// Touch alternative to the "ausblenden (1)/(2)" buttons: flick a photo away
// to mark it the loser (same as chooseHide). Any direction works except the
// one pointing at the partner photo — swiping the two together is ambiguous.
const SWIPE_MIN_TRAVEL = 64 // px — a decisive fling, not a stray drag
let swipeStartX = 0
let swipeStartY = 0
// The photo currently animating off-screen and the translate that flings it
// out; drives `flingStyle` so the tile slides away before the pair advances.
const flingOut = ref<{ id: number; tx: string; ty: string } | null>(null)

function onPhotoTouchStart(_photoId: number, evt: TouchEvent) {
  if (evt.touches.length !== 1) return
  const t = evt.touches[0]!
  swipeStartX = t.clientX
  swipeStartY = t.clientY
}

// The one direction a fling must NOT go: toward the partner photo. Depends on
// the layout — side-by-side in landscape, stacked in portrait — with
// currentPair[0] = left/top and currentPair[1] = right/bottom.
function towardPartnerDir(photoId: number): 'left' | 'right' | 'up' | 'down' | null {
  const pair = currentPair.value
  if (!pair) return null
  const idx = pair.indexOf(photoId)
  if (idx < 0) return null
  if (isPortrait.value) return idx === 0 ? 'down' : 'up'
  return idx === 0 ? 'right' : 'left'
}

// Returns true when the gesture was a valid discard fling (and kicks off the
// off-screen animation + chooseHide); false otherwise so the caller can fall
// back to tap/double-tap handling.
function tryFlingHide(photoId: number, dx: number, dy: number): boolean {
  if (flingOut.value) return false // one tile is already animating out
  if (isZoomed(photoId)) return false // zoomed in: leave the gesture to zoom
  const absX = Math.abs(dx)
  const absY = Math.abs(dy)
  if (Math.max(absX, absY) < SWIPE_MIN_TRAVEL) return false
  const dir: 'left' | 'right' | 'up' | 'down' =
    absX >= absY ? (dx < 0 ? 'left' : 'right') : dy < 0 ? 'up' : 'down'
  if (dir === towardPartnerDir(photoId)) return false // never toward the partner
  flingOut.value = {
    id: photoId,
    tx: dir === 'left' ? '-110vw' : dir === 'right' ? '110vw' : '0',
    ty: dir === 'up' ? '-110vh' : dir === 'down' ? '110vh' : '0',
  }
  window.setTimeout(() => {
    flingOut.value = null
    chooseHide(photoId)
  }, 200)
  return true
}

function flingStyle(photoId: number): Record<string, string> {
  const f = flingOut.value
  if (!f || f.id !== photoId) return {}
  return {
    transform: `translate(${f.tx}, ${f.ty})`,
    opacity: '0',
    transition: 'transform 0.2s ease-in, opacity 0.2s ease-in',
  }
}

// Touch double-tap detection mirrors the FullscreenOverlay pattern: two
// taps within 300ms and 40px count as a double-tap.
let lastTapPhotoId: number | null = null
let lastTapTime = 0
let lastTapX = 0
let lastTapY = 0
function onPhotoTouchEnd(photoId: number, evt: TouchEvent) {
  const t = evt.changedTouches[0]
  if (!t) return
  // A discard fling takes precedence over tap/double-tap zoom.
  if (tryFlingHide(photoId, t.clientX - swipeStartX, t.clientY - swipeStartY)) {
    lastTapTime = 0 // a fling is not the first half of a double-tap
    return
  }
  const now = performance.now()
  if (
    lastTapPhotoId === photoId &&
    now - lastTapTime < 300 &&
    Math.hypot(t.clientX - lastTapX, t.clientY - lastTapY) < 40
  ) {
    lastTapTime = 0
    const container = evt.currentTarget as HTMLElement | null
    void onPhotoDoubleClick(
      photoId,
      container
        ? { clientX: t.clientX, clientY: t.clientY, container }
        : undefined,
    )
    return
  }
  lastTapPhotoId = photoId
  lastTapTime = now
  lastTapX = t.clientX
  lastTapY = t.clientY
}

// Reset zoom whenever the compared pair changes.
watch(currentPair, () => resetZoom())
// Recompute viewports when the window resizes (the side-by-side layout is
// orientation-aware via grid-template-rows, so on rotate the boxes swap).
watch([windowWidth, windowHeight], () => {
  if (!anyZoomActive.value) return
  // Drop transforms — they were computed for the previous viewport.
  // The user can re-trigger zoom; this avoids a misaligned face stuck on
  // screen after a resize.
  resetZoom()
})

// ── Lifecycle ──

onMounted(() => {
  syncCuration()
  initScores()
  document.body.style.overflow = 'hidden'
  window.addEventListener('keydown', handleKeydown)
  window.addEventListener('resize', onResize)
  hoverlessMql.addEventListener('change', onHoverCapabilityChange)
  loadMissingMembers().then(() => initScores())
})

onUnmounted(() => {
  document.body.style.overflow = ''
  window.removeEventListener('keydown', handleKeydown)
  window.removeEventListener('resize', onResize)
  hoverlessMql.removeEventListener('change', onHoverCapabilityChange)
})

watch(() => props.group.id, () => {
  syncCuration()
  initScores()
  loadMissingMembers().then(() => initScores())
})

function getPhotoById(id: number): Photo | undefined {
  return props.allPhotos.find(p => p.id === id) ?? fetchedMembers.value.get(id)
}

const auth = useAuthStore()

/**
 * Photo URL aware of the caller's saved transform. Compare-view tiles
 * always show the user's edited version when one exists — no point
 * comparing originals if the user has expressed a preference.
 */
function compareTileSrc(photo: Photo, width?: number): string {
  return photoThumbnailSrc({
    photoId: photo.id,
    filename: photo.filename,
    width,
    userId: auth.user?.id,
  })
}
</script>

<template>
  <Teleport to="body">
    <div class="compare-overlay">

      <!-- ── COMPARE PHASE ── -->
      <template v-if="phase === 'compare' && currentPair">
        <!-- Header -->
        <div class="compare-header">
          <div class="compare-header-left">
            <Button
              icon="pi pi-eye-slash"
              :label="isVeryNarrow ? undefined : isNarrow ? '1' : 'ausblenden (1)'"
              v-tooltip.bottom="{ value: isVeryNarrow ? 'Linkes ausblenden (1)' : undefined, disabled: isTouch }"
              severity="warn"
              size="small"
              @click="chooseHide(currentPair[0])"
            />
          </div>
          <div class="compare-header-center">
            <Button
              icon="pi pi-equals"
              :label="isVeryNarrow ? undefined : isNarrow ? 'U' : 'Unentschieden (U, Leertaste)'"
              v-tooltip.bottom="{ value: isVeryNarrow ? 'Unentschieden (U)' : undefined, disabled: isTouch }"
              severity="info"
              size="small"
              @click="chooseDraw"
            />
            <Button
              icon="pi pi-forward"
              :label="isVeryNarrow ? undefined : isNarrow ? 'S' : 'Überspringen (S)'"
              v-tooltip.bottom="{ value: isVeryNarrow ? 'Überspringen (S)' : undefined, disabled: isTouch }"
              severity="info"
              size="small"
              @click="skipPair"
            />
            <Button
              icon="pi pi-sparkles"
              :label="isVeryNarrow ? undefined : isNarrow ? 'KI' : 'KI-Vorauswahl'"
              severity="warn"
              size="small"
              v-tooltip.bottom="{ value: 'Vergleich überspringen und Fotos nach KI-Qualitätsbewertung vorauswählen', disabled: isTouch }"
              @click="applyAiPreselection"
            />
            <Button
              icon="pi pi-link"
              :label="isVeryNarrow ? undefined : isNarrow ? 'Sync' : 'Sync-Zoom'"
              :severity="syncZoomEnabled ? 'primary' : 'secondary'"
              :outlined="!syncZoomEnabled"
              size="small"
              :aria-pressed="syncZoomEnabled"
              v-tooltip.bottom="{
                value: syncZoomEnabled
                  ? 'Doppelklick zoomt beide Fotos auf das Gesicht (gleiche Größe)'
                  : 'Doppelklick zoomt nur das angeklickte Foto — anklicken zum Synchronisieren',
                disabled: isTouch,
              }"
              @click="onSyncToggleClick"
            />
            <Button
              v-if="!isVeryNarrow"
              icon="pi pi-question-circle"
              text
              rounded
              severity="secondary"
              size="small"
              @click="helpPopover.toggle($event)"
              aria-label="Hilfe"
            />
            <Popover ref="helpPopover">
              <div class="help-popover">
                <h4>Tastaturkürzel & Aktionen</h4>
                <table class="help-table">
                  <tbody>
                    <tr>
                      <td><kbd>1</kbd> oder <kbd>←</kbd></td>
                      <td><strong>Linkes Foto ausblenden</strong></td>
                      <td class="help-desc">Das linke Foto erhält einen schlechteren Score und wird als Kandidat zum Ausblenden markiert.</td>
                    </tr>
                    <tr>
                      <td><kbd>2</kbd> oder <kbd>→</kbd></td>
                      <td><strong>Rechtes Foto ausblenden</strong></td>
                      <td class="help-desc">Das rechte Foto erhält einen schlechteren Score und wird als Kandidat zum Ausblenden markiert.</td>
                    </tr>
                    <tr>
                      <td>Wischen</td>
                      <td><strong>Foto wegwischen = ausblenden</strong></td>
                      <td class="help-desc">Auf dem Touchscreen ein Foto vom anderen weg aus dem Bild wischen (alle Richtungen außer zum Partnerfoto hin) – blendet es aus wie der jeweilige Ausblenden-Button.</td>
                    </tr>
                    <tr>
                      <td><kbd>U</kbd> oder <kbd>Leertaste</kbd></td>
                      <td><strong>Unentschieden</strong></td>
                      <td class="help-desc">Beide Fotos sind gleichwertig. Kein Score ändert sich, das Paar gilt als verglichen.</td>
                    </tr>
                    <tr>
                      <td><kbd>S</kbd></td>
                      <td><strong>Überspringen</strong></td>
                      <td class="help-desc">Das aktuelle Paar wird vorerst übersprungen – kein Score ändert sich, das Paar bleibt unentschieden und kann später wieder erscheinen.</td>
                    </tr>
                    <tr>
                      <td>KI-Vorauswahl</td>
                      <td><strong>KI-Bewertung anwenden</strong></td>
                      <td class="help-desc">Überspringt den manuellen Vergleich. Die KI bewertet jedes Foto technisch (Schärfe, Belichtung, Bildqualität via CLIP) und schlägt die schlechtesten Fotos zum Ausblenden vor.</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </Popover>
            <span class="compare-progress">
              <template v-if="isVeryNarrow">{{ comparisonsDone }}</template>
              <template v-else>{{ comparisonsDone }}/{{ pairCount }}</template>
              <span class="compare-progress-note" v-if="estimatedTotal !== pairCount">(~{{ estimatedTotal }})</span>
            </span>
          </div>
          <div class="compare-header-right">
            <Button
              icon="pi pi-eye-slash"
              :label="isVeryNarrow ? undefined : isNarrow ? '2' : 'ausblenden (2)'"
              v-tooltip.bottom="{ value: isVeryNarrow ? 'Rechtes ausblenden (2)' : undefined, disabled: isTouch }"
              severity="warn"
              size="small"
              @click="chooseHide(currentPair[1])"
            />
            <Button
              icon="pi pi-times"
              text
              rounded
              severity="secondary"
              size="small"
              v-tooltip.bottom="{ value: 'Schließen', disabled: isTouch }"
              @click="$emit('close')"
              aria-label="Schließen"
            />
          </div>
        </div>

        <!-- Side-by-side photos -->
        <div class="side-by-side">
          <div class="side-by-side-photos" :class="{ 'is-portrait': isPortrait }">
            <div
              v-for="photoId in currentPair"
              :key="photoId"
              class="side-by-side-item"
              :class="{ 'is-hidden': getCuration(photoId) === 'hidden' }"
            >
              <div
                class="side-by-side-image"
                :ref="(el) => recordViewport(photoId, el as HTMLElement | null)"
                :style="flingStyle(photoId)"
                @dblclick="(evt: MouseEvent) => onPhotoMouseDblClick(photoId, evt)"
                @touchstart="(evt: TouchEvent) => onPhotoTouchStart(photoId, evt)"
                @touchend="(evt: TouchEvent) => onPhotoTouchEnd(photoId, evt)"
              >
                <div class="compare-zoom-wrapper" :style="zoomStyle(photoId)">
                  <HeicImage
                    v-if="getPhotoById(photoId)"
                    :src="compareTileSrc(getPhotoById(photoId)!)"
                    alt=""
                    objectFit="contain"
                  />
                </div>
                <div
                  class="ai-quality-badge"
                  :class="aiScoreClass(photoId)"
                  v-tooltip.top="aiScoreTooltip(photoId)"
                >
                  <i class="pi pi-sparkles" style="font-size: 0.65rem" />
                  {{ aiScoreLabel(photoId) }}
                </div>
                <div
                  v-if="showAiPickBadge(photoId)"
                  class="ai-pick-badge"
                  v-tooltip.top="'Dieses Foto würde die KI behalten'"
                >
                  <i class="pi pi-check-circle" style="font-size: 0.7rem" />
                  KI-Pick
                </div>
                <div
                  v-if="hasClosedEyesVsPartner(photoId)"
                  class="eyes-closed-badge eyes-closed-badge--standout"
                  v-tooltip.top="eyesClosedTooltip(photoId)"
                >
                  <i class="pi pi-eye-slash" style="font-size: 0.7rem" />
                  Augen zu
                </div>
                <Button
                  v-if="isZoomed(photoId)"
                  class="compare-zoom-reset"
                  icon="pi pi-search-minus"
                  rounded
                  severity="secondary"
                  size="small"
                  v-tooltip.left="
                    syncZoomEnabled
                      ? 'Zoom auf beiden Fotos zurücksetzen (Esc)'
                      : 'Zoom auf diesem Foto zurücksetzen (Esc)'
                  "
                  aria-label="Zoom zurücksetzen"
                  @click.stop="onResetZoomClick(photoId)"
                />
              </div>
            </div>
          </div>
        </div>
      </template>

      <!-- ── REVIEW PHASE ── -->
      <template v-else-if="phase === 'review'">
        <div class="compare-header">
          <div class="compare-header-left">
            <Button
              v-if="hasNextPair"
              icon="pi pi-arrow-left"
              :label="isVeryNarrow ? undefined : isNarrow ? 'Vergleichen' : 'Weiter vergleichen'"
              v-tooltip.bottom="{ value: isVeryNarrow ? 'Weiter vergleichen' : undefined, disabled: isTouch }"
              text
              size="small"
              @click="goBackToCompare"
            />
          </div>
          <div class="compare-header-center">
            <span class="review-title" v-if="!isVeryNarrow">
              <template v-if="hasSuggestions">
                Vorschlag: {{ suggestedHideIds.length }} von {{ groupPhotos.length }} ausblenden
              </template>
              <template v-else>
                Kein Ausblenden vorgeschlagen (0 von {{ groupPhotos.length }})
              </template>
            </span>
            <span v-if="aiPreselectionIsRelative" class="relative-score-hint"
              v-tooltip.bottom="'Die KI-Scores lagen nah beieinander — die Vorauswahl basiert auf dem relativen Vergleich innerhalb der Gruppe.'">
              <i class="pi pi-info-circle" /> <span v-if="!isVeryNarrow">Relative Bewertung</span>
            </span>
          </div>
          <div class="compare-header-right">
            <Button
              v-if="hasAiPick && !reviewDecided"
              :label="isVeryNarrow ? undefined : isNarrow ? 'KI' : 'KI-Vorschlag übernehmen'"
              icon="pi pi-sparkles"
              v-tooltip.bottom="{ value: isVeryNarrow ? 'KI-Vorschlag übernehmen' : 'Behält die KI-Auswahl und blendet die übrigen aus', disabled: isTouch }"
              severity="success"
              outlined
              size="small"
              :loading="aiPickButsy"
              @click="acceptAiPickAction"
            />
            <template v-if="!reviewDecided">
              <template v-if="hasSuggestions">
                <Button
                  :label="isVeryNarrow ? undefined : isNarrow ? 'OK' : 'Vorschlag übernehmen'"
                  icon="pi pi-check"
                  v-tooltip.bottom="{ value: isVeryNarrow ? 'Vorschlag übernehmen' : undefined, disabled: isTouch }"
                  severity="warn"
                  size="small"
                  @click="applySuggestions"
                />
                <Button
                  :label="isVeryNarrow ? undefined : isNarrow ? 'Nein' : 'Vorschlag ablehnen'"
                  icon="pi pi-times"
                  v-tooltip.bottom="{ value: isVeryNarrow ? 'Vorschlag ablehnen' : undefined, disabled: isTouch }"
                  severity="secondary"
                  outlined
                  size="small"
                  @click="rejectSuggestions"
                />
              </template>
              <template v-else>
                <span class="no-suggestion-hint" v-if="!isNarrow">Keine Aktion erforderlich</span>
                <Button
                  :label="isVeryNarrow ? undefined : 'Fertig'"
                  icon="pi pi-check"
                  v-tooltip.bottom="{ value: isVeryNarrow ? 'Fertig' : undefined, disabled: isTouch }"
                  @click="handleDone"
                  severity="success"
                  size="small"
                />
                <Button
                  v-if="totalUnreviewed > 1 && !singleGroupMode"
                  :label="isVeryNarrow ? undefined : isNarrow ? 'Weiter' : 'Fertig + Weiter'"
                  icon="pi pi-arrow-right"
                  iconPos="right"
                  v-tooltip.bottom="{ value: isVeryNarrow ? 'Fertig + Weiter' : undefined, disabled: isTouch }"
                  @click="handleDoneAndNext"
                  severity="success"
                  outlined
                  size="small"
                />
              </template>
            </template>
            <template v-else>
              <Button
                :label="isVeryNarrow ? undefined : 'Fertig'"
                icon="pi pi-check"
                v-tooltip.bottom="{ value: isVeryNarrow ? 'Fertig' : undefined, disabled: isTouch }"
                @click="handleDone"
                severity="success"
                size="small"
              />
              <Button
                v-if="totalUnreviewed > 1 && !singleGroupMode"
                :label="isVeryNarrow ? undefined : isNarrow ? 'Weiter' : 'Fertig + Weiter'"
                icon="pi pi-arrow-right"
                iconPos="right"
                v-tooltip.bottom="{ value: isVeryNarrow ? 'Fertig + Weiter' : undefined, disabled: isTouch }"
                @click="handleDoneAndNext"
                severity="success"
                outlined
                size="small"
              />
            </template>
            <Button icon="pi pi-times" @click="$emit('close')" text rounded severity="secondary" v-tooltip.bottom="{ value: 'Schließen', disabled: isTouch }" />
          </div>
        </div>

        <!-- Review grid -->
        <div class="review-scroll">
          <div class="review-grid">
            <div
              v-for="photo in sortedPhotos"
              :key="photo.id"
              class="review-photo"
              :class="{
                'is-hidden': getCuration(photo.id) === 'hidden',
                'is-suggested-hide': suggestedHideIds.includes(photo.id) && getCuration(photo.id) !== 'hidden',
                'is-favorite': getCuration(photo.id) === 'favorite'
              }"
            >
              <div class="review-photo-image">
                <HeicImage :src="compareTileSrc(photo)" :alt="photo.original_name" />
                <div class="review-score" :class="{ negative: (scores.get(photo.id) ?? 0) < 0 }">
                  {{ (scores.get(photo.id) ?? 0) > 0 ? '+' : '' }}{{ scores.get(photo.id) ?? 0 }}
                </div>
                <div
                  v-if="photo.ai_quality_score !== undefined"
                  class="review-ai-score"
                  :class="aiScoreClass(photo.id)"
                  v-tooltip.right="aiScoreTooltip(photo.id)"
                >
                  <i class="pi pi-sparkles" style="font-size: 0.6rem" />
                  {{ aiScoreLabel(photo.id) }}
                </div>
                <div
                  v-if="showAiPickBadge(photo.id)"
                  class="review-ai-pick"
                  v-tooltip.right="'Dieses Foto würde die KI behalten'"
                >
                  <i class="pi pi-check-circle" style="font-size: 0.6rem" />
                  KI-Pick
                </div>
                <div
                  v-if="hasClosedEyesInGroup(photo.id)"
                  class="review-eyes-closed"
                  v-tooltip.right="`Augen wirken geschlossen (${Math.round((eyesOpenScore(photo.id) ?? 0) * 100)}%) — deutlich weniger offen als das beste Foto der Gruppe.`"
                >
                  <i class="pi pi-eye-slash" style="font-size: 0.6rem" />
                  Augen zu
                </div>
              </div>
              <div class="review-photo-controls">
                <Button
                  icon="pi pi-eye-slash"
                  :label="getCuration(photo.id) === 'hidden' ? 'Ausgeblendet' : 'Ausblenden'"
                  :severity="getCuration(photo.id) === 'hidden' ? 'danger' : 'secondary'"
                  :outlined="getCuration(photo.id) !== 'hidden'"
                  size="small"
                  @click="setCuration(photo.id, 'hidden')"
                />
                <Button
                  icon="pi pi-heart"
                  :severity="getCuration(photo.id) === 'favorite' ? 'warn' : 'secondary'"
                  :outlined="getCuration(photo.id) !== 'favorite'"
                  size="small"
                  @click="setCuration(photo.id, 'favorite')"
                />
              </div>
            </div>
          </div>
        </div>
      </template>

    </div>
  </Teleport>
</template>

<style scoped>
.compare-overlay {
  position: fixed;
  inset: 0;
  background: #0a0a0a;
  z-index: 1200;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

/* ── Header (shared between phases) ── */
.compare-header {
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  align-items: center;
  padding-inline: 0.75rem;
  height: 2.5rem;
  background-color: var(--p-neutral-50);
  flex-shrink: 0;
  z-index: 10;
  gap: 0.5rem;
}

.compare-header-left {
  display: flex;
  align-items: center;
  justify-content: flex-start;
  gap: 0.5rem;
  white-space: nowrap;
}

.compare-header-center {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
  white-space: nowrap;
}

.compare-header-right {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 0.5rem;
  white-space: nowrap;
}

.compare-progress {
  color: var(--p-slate-950);
  font-variant-numeric: tabular-nums;
}

.review-title {
  color: var(--p-slate-950);
}

.relative-score-hint {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  font-size: 0.75rem;
  color: var(--p-text-muted-color);
  cursor: default;
  margin-left: 0.5rem;
}

.no-suggestion-hint {
  color: var(--p-text-muted-color);
  font-size: 0.82rem;
}

/* ── Side-by-side (compare phase) ── */
.side-by-side {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.side-by-side-photos {
  flex: 1;
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 2px;
  min-height: 0;
}

/* Portrait orientation: stack photos top/bottom for better screen use */
.side-by-side-photos.is-portrait {
  grid-template-columns: 1fr;
  grid-template-rows: 1fr 1fr;
}

.side-by-side-item {
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: #111;
  transition: opacity 0.2s;
}

.side-by-side-item.is-hidden {
  opacity: 0.3;
}

.side-by-side-image {
  flex: 1;
  min-height: 0;
  position: relative;
  overflow: hidden;
  /* Suppress double-tap-zoom on iOS Safari — we own the gesture here for
     zoom-to-face (Track N / #79) and don't want the browser to also zoom
     the page. */
  touch-action: manipulation;
}

/* Zoom wrapper around the HeicImage. Defaults to identity transform; the
   inline :style binding writes scale + translate when the user
   double-clicks. The transform-origin lives at the bbox centre so the
   face stays put on screen as the image scales. */
.compare-zoom-wrapper {
  width: 100%;
  height: 100%;
  will-change: transform;
}

.compare-zoom-reset {
  position: absolute;
  top: 0.5rem;
  right: 0.5rem;
  z-index: 4;
  background: rgba(0, 0, 0, 0.55) !important;
  color: #fff !important;
}

.side-by-side-image :deep(.heic-image-container) {
  width: 100%;
  height: 100%;
}

.side-by-side-image :deep(img) {
  width: 100%;
  height: 100%;
  object-fit: contain;
  display: block;
}

/* ── Review phase ── */
.review-scroll {
  flex: 1;
  overflow-y: auto;
  min-height: 0;
  padding: 1rem;
}

.review-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 1rem;
}

.review-photo {
  border-radius: 8px;
  overflow: hidden;
  background: #1a1a1a;
  transition: opacity 0.2s, box-shadow 0.2s;
}

.review-photo.is-hidden {
  opacity: 0.3;
}

.review-photo.is-suggested-hide {
  box-shadow: 0 0 0 3px rgba(234, 88, 12, 0.6);
}

.review-photo.is-favorite {
  box-shadow: 0 0 0 3px var(--p-yellow-500);
}

.review-photo-image {
  position: relative;
}

.review-photo-image :deep(img) {
  width: 100%;
  height: auto;
  display: block;
}

.review-score {
  position: absolute;
  top: 0.4rem;
  right: 0.4rem;
  background: rgba(0, 0, 0, 0.7);
  color: #22c55e;
  padding: 0.15rem 0.5rem;
  border-radius: 1rem;
  font-size: 0.8rem;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

.review-score.negative {
  color: #ef4444;
}

.review-photo-controls {
  display: flex;
  gap: 0.5rem;
  padding: 0.5rem;
  justify-content: center;
}

.help-popover {
  padding: 0.25rem 0.25rem;
  max-width: 540px;
}

.help-popover h4 {
  margin: 0 0 0.75rem 0;
  font-size: 0.9rem;
  font-weight: 600;
  color: var(--p-text-color);
}

.help-table {
  border-collapse: collapse;
  width: 100%;
  font-size: 0.82rem;
}

.help-table tr + tr td {
  border-top: 1px solid var(--p-content-border-color);
}

.help-table td {
  padding: 0.45rem 0.6rem;
  vertical-align: top;
}

.help-table td:first-child {
  white-space: nowrap;
}

kbd {
  display: inline-block;
  padding: 0.1rem 0.35rem;
  font-size: 0.78rem;
  font-family: monospace;
  background: var(--p-surface-100, #f3f4f6);
  border: 1px solid var(--p-surface-300, #d1d5db);
  border-radius: 4px;
  line-height: 1.4;
}

.help-desc {
  color: var(--p-text-muted-color);
}

/* ── AI quality badge (compare phase, overlaid on photo) ── */
.ai-quality-badge {
  position: absolute;
  bottom: 0.4rem;
  left: 0.4rem;
  display: flex;
  align-items: center;
  gap: 0.25rem;
  padding: 0.15rem 0.45rem;
  border-radius: 1rem;
  font-size: 0.75rem;
  font-weight: 600;
  background: rgba(0, 0, 0, 0.65);
  backdrop-filter: blur(4px);
  cursor: help;
}

.ai-quality-badge.ai-score-good  { color: #22c55e; }
.ai-quality-badge.ai-score-medium { color: #eab308; }
.ai-quality-badge.ai-score-poor  { color: #ef4444; }
.ai-quality-badge.ai-score-unknown { color: #9ca3af; }

/* ── AI score in review grid ── */
.review-ai-score {
  position: absolute;
  bottom: 0.4rem;
  left: 0.4rem;
  display: flex;
  align-items: center;
  gap: 0.2rem;
  padding: 0.1rem 0.4rem;
  border-radius: 1rem;
  font-size: 0.72rem;
  font-weight: 600;
  background: rgba(0, 0, 0, 0.65);
  backdrop-filter: blur(4px);
  cursor: help;
}

.review-ai-score.ai-score-good   { color: #22c55e; }
.review-ai-score.ai-score-medium { color: #eab308; }
.review-ai-score.ai-score-poor   { color: #ef4444; }
.review-ai-score.ai-score-unknown { color: #9ca3af; }

/* ── KI-Pick badge ── Marks the photo(s) the auto-pick would keep, so
   the user can see in the side-by-side / review grid whether their
   intuition agrees with the KI. Positioned top-right to stay clear of
   the bottom-left quality badge. */
.ai-pick-badge,
.review-ai-pick {
  position: absolute;
  top: 0.4rem;
  right: 0.4rem;
  display: flex;
  align-items: center;
  gap: 0.25rem;
  padding: 0.15rem 0.5rem;
  border-radius: 1rem;
  font-size: 0.72rem;
  font-weight: 600;
  color: #ffffff;
  background: rgba(34, 197, 94, 0.85);
  backdrop-filter: blur(4px);
  cursor: help;
}

/* ── Eyes-closed hint (Track N / #81) ── Surfaced bottom-right so it
   sits opposite the quality badge. The standout variant (one photo
   has closed eyes while the other has open eyes) gets a stronger red
   background to direct the user's choice. */
.eyes-closed-badge,
.review-eyes-closed {
  position: absolute;
  bottom: 0.4rem;
  right: 0.4rem;
  display: flex;
  align-items: center;
  gap: 0.25rem;
  padding: 0.15rem 0.5rem;
  border-radius: 1rem;
  font-size: 0.72rem;
  font-weight: 600;
  color: #fee2e2;
  background: rgba(239, 68, 68, 0.7);
  backdrop-filter: blur(4px);
  cursor: help;
  z-index: 3;
}

.eyes-closed-badge--standout {
  color: #ffffff;
  background: rgba(220, 38, 38, 0.95);
  box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.35), 0 2px 8px rgba(220, 38, 38, 0.45);
}

.review-eyes-closed {
  font-size: 0.65rem;
  padding: 0.1rem 0.4rem;
}
</style>
