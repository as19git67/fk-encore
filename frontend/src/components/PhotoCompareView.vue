<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import Button from 'primevue/button'
import Popover from 'primevue/popover'
import HeicImage from './HeicImage.vue'
import {
  getPhotoUrl,
  updatePhotoCuration,
  reviewPhotoGroup,
  type Photo,
  type PhotoGroup,
  type CurationStatus,
} from '../api/photos'

const helpPopover = ref()

const props = defineProps<{
  group: PhotoGroup
  allPhotos: Photo[]
  totalUnreviewed: number
}>()

const emit = defineEmits<{
  close: []
  reviewed: []
  next: [groupId: number]
}>()

const groupPhotos = computed(() => {
  return props.group.photo_ids
    .map((id) => props.allPhotos.find((p) => p.id === id))
    .filter((p): p is Photo => !!p)
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
    await reviewPhotoGroup(props.group.id)
    emit('close')
  } catch (err: any) {
    console.error('Failed to review group:', err)
  }
}

async function handleDoneAndNext() {
  try {
    await reviewPhotoGroup(props.group.id)
    emit('next', props.group.id)
  } catch (err: any) {
    console.error('Failed to review group:', err)
  }
}

// ── Keyboard shortcuts ──

function handleKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
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

// ── Lifecycle ──

onMounted(() => {
  syncCuration()
  initScores()
  document.body.style.overflow = 'hidden'
  window.addEventListener('keydown', handleKeydown)
})

onUnmounted(() => {
  document.body.style.overflow = ''
  window.removeEventListener('keydown', handleKeydown)
})

watch(() => props.group.id, () => {
  syncCuration()
  initScores()
})

function getPhotoById(id: number): Photo | undefined {
  return props.allPhotos.find(p => p.id === id)
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
              label="ausblenden (1)"
              severity="warn"
              size="small"
              @click="chooseHide(currentPair[0])"
            />
          </div>
          <div class="compare-header-center">
            <Button
              icon="pi pi-equals"
              label="Unentschieden (U, Leertaste)"
              severity="info"
              size="small"
              @click="chooseDraw"
            />
            <Button
              icon="pi pi-forward"
              label="Überspringen (S)"
              severity="info"
              size="small"
              @click="skipPair"
            />
            <Button
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
                      <td><kbd>U</kbd> oder <kbd>Leertaste</kbd></td>
                      <td><strong>Unentschieden</strong></td>
                      <td class="help-desc">Beide Fotos sind gleichwertig. Kein Score ändert sich, das Paar gilt als verglichen.</td>
                    </tr>
                    <tr>
                      <td><kbd>S</kbd></td>
                      <td><strong>Überspringen</strong></td>
                      <td class="help-desc">Das aktuelle Paar wird vorerst übersprungen – kein Score ändert sich, das Paar bleibt unentschieden und kann später wieder erscheinen.</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </Popover>
            <span class="compare-progress">
              {{ comparisonsDone }}/{{ pairCount }}
              <span class="compare-progress-note" v-if="estimatedTotal !== pairCount">(~{{ estimatedTotal }})</span>
            </span>
          </div>
          <div class="compare-header-right">
            <Button
              icon="pi pi-eye-slash"
              label="ausblenden (2)"
              severity="warn"
              size="small"
              @click="chooseHide(currentPair[1])"
            />
          </div>
        </div>

        <!-- Side-by-side photos -->
        <div class="side-by-side">
          <div class="side-by-side-photos">
            <div
              v-for="photoId in currentPair"
              :key="photoId"
              class="side-by-side-item"
              :class="{ 'is-hidden': getCuration(photoId) === 'hidden' }"
            >
              <div class="side-by-side-image">
                <HeicImage
                  v-if="getPhotoById(photoId)"
                  :src="getPhotoUrl(getPhotoById(photoId)!.filename)"
                  alt=""
                  objectFit="contain"
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
              label="Weiter vergleichen"
              text
              size="small"
              @click="goBackToCompare"
            />
          </div>
          <div class="compare-header-center">
            <span class="review-title">
              <template v-if="hasSuggestions">
                Vorschlag: {{ suggestedHideIds.length }} von {{ groupPhotos.length }} ausblenden
              </template>
              <template v-else>
                Kein Ausblenden vorgeschlagen (0 von {{ groupPhotos.length }})
              </template>
            </span>
          </div>
          <div class="compare-header-right">
            <template v-if="!reviewDecided">
              <template v-if="hasSuggestions">
                <Button
                  label="Vorschlag übernehmen"
                  icon="pi pi-check"
                  severity="warn"
                  size="small"
                  @click="applySuggestions"
                />
                <Button
                  label="Vorschlag ablehnen"
                  icon="pi pi-times"
                  severity="secondary"
                  outlined
                  size="small"
                  @click="rejectSuggestions"
                />
              </template>
              <template v-else>
                <span class="no-suggestion-hint">Keine Aktion erforderlich</span>
                <Button label="Fertig" icon="pi pi-check" @click="handleDone" severity="success" size="small" />
                <Button
                  v-if="totalUnreviewed > 1"
                  label="Fertig + Weiter"
                  icon="pi pi-arrow-right"
                  iconPos="right"
                  @click="handleDoneAndNext"
                  severity="success"
                  outlined
                  size="small"
                />
              </template>
            </template>
            <template v-else>
              <Button label="Fertig" icon="pi pi-check" @click="handleDone" severity="success" size="small" />
              <Button
                v-if="totalUnreviewed > 1"
                label="Fertig + Weiter"
                icon="pi pi-arrow-right"
                iconPos="right"
                @click="handleDoneAndNext"
                severity="success"
                outlined
                size="small"
              />
              <Button icon="pi pi-times" @click="$emit('close')" text rounded severity="secondary" />
            </template>
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
                <HeicImage :src="getPhotoUrl(photo.filename)" :alt="photo.original_name" />
                <div class="review-score" :class="{ negative: (scores.get(photo.id) ?? 0) < 0 }">
                  {{ (scores.get(photo.id) ?? 0) > 0 ? '+' : '' }}{{ scores.get(photo.id) ?? 0 }}
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
  z-index: 1000;
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
</style>
