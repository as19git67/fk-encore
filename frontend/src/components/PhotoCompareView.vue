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

// ── Responsive width tracking ──
const windowWidth = ref(window.innerWidth)
function onResize() { windowWidth.value = window.innerWidth }
const isNarrow = computed(() => windowWidth.value < 900)
const isVeryNarrow = computed(() => windowWidth.value < 500)

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
  window.addEventListener('resize', onResize)
})

onUnmounted(() => {
  document.body.style.overflow = ''
  window.removeEventListener('keydown', handleKeydown)
  window.removeEventListener('resize', onResize)
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
              :label="isVeryNarrow ? undefined : isNarrow ? '1' : 'ausblenden (1)'"
              v-tooltip.bottom="isVeryNarrow ? 'Linkes ausblenden (1)' : undefined"
              severity="warn"
              size="small"
              @click="chooseHide(currentPair[0])"
            />
          </div>
          <div class="compare-header-center">
            <Button
              icon="pi pi-equals"
              :label="isVeryNarrow ? undefined : isNarrow ? 'U' : 'Unentschieden (U, Leertaste)'"
              v-tooltip.bottom="isVeryNarrow ? 'Unentschieden (U)' : undefined"
              severity="info"
              size="small"
              @click="chooseDraw"
            />
            <Button
              icon="pi pi-forward"
              :label="isVeryNarrow ? undefined : isNarrow ? 'S' : 'Überspringen (S)'"
              v-tooltip.bottom="isVeryNarrow ? 'Überspringen (S)' : undefined"
              severity="info"
              size="small"
              @click="skipPair"
            />
            <Button
              icon="pi pi-sparkles"
              :label="isVeryNarrow ? undefined : isNarrow ? 'KI' : 'KI-Vorauswahl'"
              severity="warn"
              size="small"
              v-tooltip.bottom="'Vergleich überspringen und Fotos nach KI-Qualitätsbewertung vorauswählen'"
              @click="applyAiPreselection"
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
              {{ comparisonsDone }}/{{ pairCount }}
              <span class="compare-progress-note" v-if="estimatedTotal !== pairCount">(~{{ estimatedTotal }})</span>
            </span>
          </div>
          <div class="compare-header-right">
            <Button
              icon="pi pi-eye-slash"
              :label="isVeryNarrow ? undefined : isNarrow ? '2' : 'ausblenden (2)'"
              v-tooltip.bottom="isVeryNarrow ? 'Rechtes ausblenden (2)' : undefined"
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
              v-tooltip.bottom="'Schließen'"
              @click="$emit('close')"
              aria-label="Schließen"
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
                <div
                  class="ai-quality-badge"
                  :class="aiScoreClass(photoId)"
                  v-tooltip.top="aiScoreTooltip(photoId)"
                >
                  <i class="pi pi-sparkles" style="font-size: 0.65rem" />
                  {{ aiScoreLabel(photoId) }}
                </div>
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
              v-tooltip.bottom="isVeryNarrow ? 'Weiter vergleichen' : undefined"
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
            <template v-if="!reviewDecided">
              <template v-if="hasSuggestions">
                <Button
                  :label="isVeryNarrow ? undefined : isNarrow ? 'OK' : 'Vorschlag übernehmen'"
                  icon="pi pi-check"
                  v-tooltip.bottom="isVeryNarrow ? 'Vorschlag übernehmen' : undefined"
                  severity="warn"
                  size="small"
                  @click="applySuggestions"
                />
                <Button
                  :label="isVeryNarrow ? undefined : isNarrow ? 'Nein' : 'Vorschlag ablehnen'"
                  icon="pi pi-times"
                  v-tooltip.bottom="isVeryNarrow ? 'Vorschlag ablehnen' : undefined"
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
                  v-tooltip.bottom="isVeryNarrow ? 'Fertig' : undefined"
                  @click="handleDone"
                  severity="success"
                  size="small"
                />
                <Button
                  v-if="totalUnreviewed > 1"
                  :label="isVeryNarrow ? undefined : isNarrow ? 'Weiter' : 'Fertig + Weiter'"
                  icon="pi pi-arrow-right"
                  iconPos="right"
                  v-tooltip.bottom="isVeryNarrow ? 'Fertig + Weiter' : undefined"
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
                v-tooltip.bottom="isVeryNarrow ? 'Fertig' : undefined"
                @click="handleDone"
                severity="success"
                size="small"
              />
              <Button
                v-if="totalUnreviewed > 1"
                :label="isVeryNarrow ? undefined : isNarrow ? 'Weiter' : 'Fertig + Weiter'"
                icon="pi pi-arrow-right"
                iconPos="right"
                v-tooltip.bottom="isVeryNarrow ? 'Fertig + Weiter' : undefined"
                @click="handleDoneAndNext"
                severity="success"
                outlined
                size="small"
              />
            </template>
            <Button icon="pi pi-times" @click="$emit('close')" text rounded severity="secondary" v-tooltip.bottom="'Schließen'" />
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
                <div
                  v-if="photo.ai_quality_score !== undefined"
                  class="review-ai-score"
                  :class="aiScoreClass(photo.id)"
                  v-tooltip.right="aiScoreTooltip(photo.id)"
                >
                  <i class="pi pi-sparkles" style="font-size: 0.6rem" />
                  {{ aiScoreLabel(photo.id) }}
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

.relative-score-hint {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  font-size: 0.75rem;
  color: var(--text-color-secondary);
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
</style>
