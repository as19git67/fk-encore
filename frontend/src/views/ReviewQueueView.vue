<script setup lang="ts">
/**
 * Rapid Review — Bulk-Accept-Strip for similar-photo groups.
 *
 * Goal (from the user-facing brainstorming on #346 follow-up): cut the
 * per-group click cost for 4000+ unreviewed groups. The traditional
 * flow opens a modal per group; here we present groups as cards in a
 * single scroll, each card pre-marks the KI pick, and a single
 * "Übernehmen" click confirms the group without ever leaving the
 * page.
 *
 * Cards are sorted high → medium → low → no-pick so the user blasts
 * through the easy decisions first via the global bulk-accept button
 * and only spends time on the ambiguous ones.
 *
 * Falls back to the existing PhotoCompareView modal for groups where
 * the user wants to drill in (button "Manuell prüfen"), so this view
 * doesn't have to reinvent the per-photo hide/keep UX.
 */
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { useRouter } from 'vue-router'
import Button from 'primevue/button'
import Message from 'primevue/message'
import SelectButton from 'primevue/selectbutton'
import Dialog from 'primevue/dialog'
import { useConfirm } from 'primevue/useconfirm'
import PhotoCompareView from '../components/PhotoCompareView.vue'
import {
  getReviewQueue,
  acceptAiPick,
  pickPhotosInGroup,
  reviewPhotoGroup,
  acceptPeerConsensus,
  bulkAcceptHighConfidenceAiPicks,
  deleteDuplicatePhotoGroup,
  type ReviewQueueGroup,
  type ReviewQueuePhoto,
  type ReviewQueueUserCalibration,
  type PhotoGroup,
} from '../api/photos'
import { getThumbUrl } from '../api/gallery'
import { useAuthStore } from '../stores/auth'

const router = useRouter()
const confirm = useConfirm()
const auth = useAuthStore()
const canManageData = computed(() => auth.hasPermission('data.manage'))

const PAGE_SIZE = 30
const groups = ref<ReviewQueueGroup[]>([])
const total = ref(0)
// Count of unreviewed high-confidence groups across the whole user
// (independent of the active filter). Drives the disable state + label
// of the "Alle Sicheren bestätigen" button so it never invites a click
// that would no-op server-side.
const highConfidenceTotal = ref(0)
const offset = ref(0)
const loading = ref(false)
const loadError = ref('')
const userCalibration = ref<ReviewQueueUserCalibration | null>(null)
type ConfidenceFilter = 'all' | 'high' | 'medium' | 'low'
const confidenceFilter = ref<ConfidenceFilter>('all')

const filterOptions: Array<{ label: string; value: ConfidenceFilter }> = [
  { label: 'Alle', value: 'all' },
  { label: 'Sicher', value: 'high' },
  { label: 'Mittel', value: 'medium' },
  { label: 'Unsicher', value: 'low' },
]

const bulkBusy = ref(false)
const bulkConfirmOpen = ref(false)
const bulkResult = ref<{ groups_accepted: number; hidden_count: number } | null>(null)
const pendingAcceptIds = ref<Set<number>>(new Set())
const duplicateDeleteResult = ref<{ deleted: number; freedBytes: number } | null>(null)

// Average top-1 accuracy across both branches, weighted by pair count.
// Surfaced on the bulk-accept disclaimer so the user sees the actual
// agreement rate before committing to a destructive action.
const calibrationAccuracyAvg = computed<number | null>(() => {
  const c = userCalibration.value
  if (!c) return null
  const total = c.pair_count_face + c.pair_count_non_face
  if (total === 0) return null
  return (
    (c.top1_accuracy_face * c.pair_count_face +
      c.top1_accuracy_non_face * c.pair_count_non_face) /
    total
  )
})

function fmtPct(v: number | null | undefined): string {
  if (v == null) return '–'
  return `${Math.round(v * 100)} %`
}

function fmtDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString('de-DE')
  } catch {
    return iso
  }
}

function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

const reachedEnd = computed(() => groups.value.length >= total.value)

async function loadInitial() {
  loading.value = true
  loadError.value = ''
  offset.value = 0
  bulkResult.value = null
  pendingAcceptIds.value = new Set()
  try {
    const res = await getReviewQueue({
      offset: 0,
      limit: PAGE_SIZE,
      confidence: confidenceFilter.value === 'all' ? undefined : confidenceFilter.value,
    })
    groups.value = res.groups
    total.value = res.total
    highConfidenceTotal.value = res.high_confidence_total
    offset.value = res.groups.length
    userCalibration.value = res.user_calibration
  } catch (err: any) {
    loadError.value = err?.message ?? 'Fehler beim Laden der Review-Warteschlange.'
  } finally {
    loading.value = false
  }
}

async function loadMore() {
  if (loading.value || reachedEnd.value) return
  loading.value = true
  loadError.value = ''
  try {
    const res = await getReviewQueue({
      offset: offset.value,
      limit: PAGE_SIZE,
      confidence: confidenceFilter.value === 'all' ? undefined : confidenceFilter.value,
    })
    groups.value = [...groups.value, ...res.groups]
    total.value = res.total
    highConfidenceTotal.value = res.high_confidence_total
    offset.value += res.groups.length
  } catch (err: any) {
    loadError.value = err?.message ?? 'Fehler beim Nachladen.'
  } finally {
    loading.value = false
  }
}

function onChangeFilter() {
  void loadInitial()
}

async function onAccept(group: ReviewQueueGroup) {
  if (group.duplicate_candidate && group.duplicate_recommended_photo_id != null) {
    await onPickOne(group, group.duplicate_recommended_photo_id)
    return
  }
  await runAcceptAction(group, () => acceptAiPick(group.id))
}

function askDeleteDuplicates(group: ReviewQueueGroup) {
  if (!group.duplicate_candidate || group.duplicate_deletable_count < 1) return
  const count = group.duplicate_deletable_count
  confirm.require({
    header: 'Duplikate endgültig löschen',
    message: `${count} ${count === 1 ? 'eigenes Duplikat' : 'eigene Duplikate'} endgültig löschen und ${fmtBytes(group.duplicate_deletable_bytes)} freigeben? Das empfohlene beste Foto bleibt erhalten. Diese Aktion kann nicht rückgängig gemacht werden.`,
    icon: 'pi pi-exclamation-triangle',
    rejectLabel: 'Abbrechen',
    acceptLabel: 'Endgültig löschen',
    acceptClass: 'p-button-danger',
    accept: () => void performDeleteDuplicates(group),
  })
}

async function performDeleteDuplicates(group: ReviewQueueGroup) {
  if (pendingAcceptIds.value.has(group.id)) return
  const pending = new Set(pendingAcceptIds.value)
  pending.add(group.id)
  pendingAcceptIds.value = pending
  loadError.value = ''
  try {
    const result = await deleteDuplicatePhotoGroup(group.id)
    groups.value = groups.value.filter((item) => item.id !== group.id)
    total.value = Math.max(0, total.value - 1)
    if (group.ai_picked_confidence === 'high') {
      highConfidenceTotal.value = Math.max(0, highConfidenceTotal.value - 1)
    }
    duplicateDeleteResult.value = {
      deleted: result.deleted.length,
      freedBytes: result.freed_bytes,
    }
    if (result.file_cleanup_failed > 0) {
      loadError.value = `${result.file_cleanup_failed} Originaldatei(en) konnten nach dem Datenbank-Löschen nicht vom Speicher entfernt werden.`
    }
  } catch (err: any) {
    loadError.value = err?.message ?? 'Duplikate konnten nicht sicher gelöscht werden.'
  } finally {
    const next = new Set(pendingAcceptIds.value)
    next.delete(group.id)
    pendingAcceptIds.value = next
  }
}

/**
 * Stufe C: user clicks one specific photo in a small-group card.
 * Keep that photo, hide the rest, mark reviewed. Server-side call
 * goes through the same `acceptAiPickLogic` path as the AI pick,
 * with the user's choice as the override.
 */
async function onPickOne(group: ReviewQueueGroup, photoId: number) {
  await runAcceptAction(group, () => pickPhotosInGroup(group.id, [photoId]))
}

/**
 * "Alle wählen" — keep every member, mark the group reviewed.
 *
 * Use case: an intentional burst (z. B. eine Fotoreihe) wo der User
 * keines der Bilder verlieren will. Wir flippen nur `reviewed_at` per
 * reviewPhotoGroup() (ohne photoIds — der Endpoint fasst dann
 * photo_curation nicht an) und schicken dann das gleiche optimistische
 * Update durch runAcceptAction, damit die Card verschwindet.
 */
async function onKeepAll(group: ReviewQueueGroup) {
  await runAcceptAction(group, async () => {
    const res = await reviewPhotoGroup(group.id)
    return { success: res.success, hidden_count: 0 }
  })
}

// ── Peer-Consensus (Phase 2) ──
// "Konsens übernehmen" lets the requester adopt the conservative
// majority of their album-peers' curation decisions. The button only
// makes sense when at least one photo in the group has a peer signal;
// the dialog previews the bucket counts before the user commits.

interface ConsensusPreview {
  willHide: number
  willKeep: number
  noSignal: number
}

function previewConsensus(group: ReviewQueueGroup): ConsensusPreview {
  let willHide = 0
  let willKeep = 0
  let noSignal = 0
  for (const p of group.photos) {
    const pc = p.peer_curation
    if (pc.hidden === 0 && pc.favorite === 0) noSignal++
    else if (pc.hidden > 0 && pc.favorite === 0) willHide++
    else willKeep++
  }
  return { willHide, willKeep, noSignal }
}

function hasAnyPeerSignal(group: ReviewQueueGroup): boolean {
  return group.photos.some(
    (p) => p.peer_curation.hidden > 0 || p.peer_curation.favorite > 0,
  )
}

const consensusGroup = ref<ReviewQueueGroup | null>(null)
const consensusPreview = computed<ConsensusPreview | null>(() =>
  consensusGroup.value ? previewConsensus(consensusGroup.value) : null,
)
const consensusBusy = ref(false)
const consensusResult = ref<{
  hidden_count: number
  kept_count: number
  no_signal_count: number
} | null>(null)

function askConsensus(group: ReviewQueueGroup) {
  consensusResult.value = null
  consensusGroup.value = group
}

async function confirmConsensus() {
  const group = consensusGroup.value
  if (!group || consensusBusy.value) return
  consensusBusy.value = true
  try {
    const res = await acceptPeerConsensus(group.id)
    consensusResult.value = {
      hidden_count: res.hidden_count,
      kept_count: res.kept_count,
      no_signal_count: res.no_signal_count,
    }
    // Same optimistic-removal flow as the other accept actions: drop
    // the card from the visible list, update counters. We don't go
    // through runAcceptAction because the result toast lives inside
    // the dialog and we don't want the card to vanish *before* the
    // user sees the counts.
    groups.value = groups.value.filter((g) => g.id !== group.id)
    total.value = Math.max(0, total.value - 1)
    if (group.ai_picked_confidence === 'high') {
      highConfidenceTotal.value = Math.max(0, highConfidenceTotal.value - 1)
    }
  } catch (err: any) {
    loadError.value = err?.message ?? 'Fehler beim Übernehmen des Konsens.'
    consensusGroup.value = null
  } finally {
    consensusBusy.value = false
  }
}

function closeConsensusDialog() {
  consensusGroup.value = null
  consensusResult.value = null
}

async function runAcceptAction(
  group: ReviewQueueGroup,
  action: () => Promise<{ success: boolean; hidden_count: number }>,
) {
  if (pendingAcceptIds.value.has(group.id)) return
  // Mark optimistically — UI hides the card right away. On failure
  // we re-insert it.
  const set = new Set(pendingAcceptIds.value)
  set.add(group.id)
  pendingAcceptIds.value = set
  try {
    const result = await action()
    if (!result.success) throw new Error('Server hat die Aktion abgelehnt.')
    // Permanently remove the card. Decrement total so the counter
    // stays honest without a refetch.
    groups.value = groups.value.filter((g) => g.id !== group.id)
    total.value = Math.max(0, total.value - 1)
    // If the accepted group was high-confidence, the server-wide
    // backlog also shrunk by one — mirror that locally so the
    // "Alle Sicheren bestätigen" button can disable itself as the
    // last high-confidence group leaves the queue.
    if (group.ai_picked_confidence === 'high') {
      highConfidenceTotal.value = Math.max(0, highConfidenceTotal.value - 1)
    }
  } catch (err: any) {
    loadError.value = err?.message ?? 'Fehler beim Bestätigen der Gruppe.'
    const reverted = new Set(pendingAcceptIds.value)
    reverted.delete(group.id)
    pendingAcceptIds.value = reverted
  }
}

// Small-group layout (≤ 3 photos): show every member at large equal
// size, single tap = "keep this one, hide the rest". Skips the
// dual-action footer entirely.
const SMALL_GROUP_THRESHOLD = 3
function isSmallGroup(group: ReviewQueueGroup): boolean {
  return group.photos.length > 0 && group.photos.length <= SMALL_GROUP_THRESHOLD
}

function askBulkAcceptHigh() {
  bulkConfirmOpen.value = true
}

async function confirmBulkAcceptHigh() {
  bulkConfirmOpen.value = false
  if (bulkBusy.value) return
  bulkBusy.value = true
  loadError.value = ''
  try {
    bulkResult.value = await bulkAcceptHighConfidenceAiPicks()
    // Reload the queue — server-side state is now very different
    // (every high-confidence unreviewed group is gone) and an
    // in-place merge is not worth the complexity.
    await loadInitial()
  } catch (err: any) {
    loadError.value = err?.message ?? 'Fehler beim Bulk-Bestätigen.'
  } finally {
    bulkBusy.value = false
  }
}

// Confidence-bar value in [0..1]. The auto-hide gate sits at
// HIGH_CONFIDENCE_DELTA (0.10) — we map that to a full bar so the
// visual is intuitive: full = "AI is sure", empty = "AI guessed".
const CONFIDENCE_BAR_MAX = 0.10
function confidenceBarFraction(g: ReviewQueueGroup): number {
  const d = g.runner_up_delta
  if (d == null) return 0
  if (d <= 0) return 0
  if (d >= CONFIDENCE_BAR_MAX) return 1
  return d / CONFIDENCE_BAR_MAX
}

// ── Manual review (drop into existing PhotoCompareView) ──

const activeGroup = ref<PhotoGroup | null>(null)

function toPhotoGroup(group: ReviewQueueGroup): PhotoGroup {
  return {
    id: group.id,
    user_id: 0,
    cover_photo_id: group.cover_photo_id ?? undefined,
    created_at: '',
    member_count: group.member_count,
    photo_ids: group.photos.map((p) => p.id),
    ai_picked_photo_ids: group.ai_picked_photo_ids,
    ai_picked_confidence: group.ai_picked_confidence ?? undefined,
  }
}

function openManual(group: ReviewQueueGroup) {
  activeGroup.value = toPhotoGroup(group)
}

function onCompareClose() {
  activeGroup.value = null
}

function removeFromQueue(groupId: number) {
  const reviewedGroup = groups.value.find((g) => g.id === groupId)
  groups.value = groups.value.filter((g) => g.id !== groupId)
  total.value = Math.max(0, total.value - 1)
  if (reviewedGroup?.ai_picked_confidence === 'high') {
    highConfidenceTotal.value = Math.max(0, highConfidenceTotal.value - 1)
  }
}

function onCompareReviewed() {
  const reviewedId = activeGroup.value?.id
  activeGroup.value = null
  if (reviewedId !== undefined) removeFromQueue(reviewedId)
}

function onCompareNext(reviewedGroupId: number) {
  removeFromQueue(reviewedGroupId)
  // Open the next still-pending group in queue order.
  const next = groups.value[0]
  activeGroup.value = next ? toPhotoGroup(next) : null
}

// ── Card rendering helpers ──

function thumb(filename: string, w = 400): string {
  return getThumbUrl(filename, w)
}

// Strip thumbnails on the queue card are deliberately small to keep the
// card list scannable, but at 200 px wide the user can't actually see
// whether a non-pick sibling deserves the demotion. Tap a thumb to open
// it bildschirmfüllend; tap the backdrop / press ESC to close. State
// kept here (instead of inside the card v-for) so a single overlay
// element is enough — Vue teleports it to the body.
const lightboxFilename = ref<string | null>(null)
const lightboxIsPicked = ref(false)

function openLightbox(filename: string, isPicked: boolean) {
  lightboxFilename.value = filename
  lightboxIsPicked.value = isPicked
}

function closeLightbox() {
  lightboxFilename.value = null
}

function onLightboxKey(e: KeyboardEvent) {
  if (e.key === 'Escape' && lightboxFilename.value) closeLightbox()
}

onMounted(() => window.addEventListener('keydown', onLightboxKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onLightboxKey))

function confidenceLabel(c: ReviewQueueGroup['ai_picked_confidence']): string {
  if (c === 'high') return 'Sicher'
  if (c === 'medium') return 'Mittel'
  if (c === 'low') return 'Unsicher'
  return 'Nicht bewertet'
}

function confidenceClass(c: ReviewQueueGroup['ai_picked_confidence']): string {
  if (c === 'high') return 'rq-conf rq-conf--high'
  if (c === 'medium') return 'rq-conf rq-conf--medium'
  if (c === 'low') return 'rq-conf rq-conf--low'
  return 'rq-conf rq-conf--unknown'
}

/** Per-photo AI quality rating as a percentage, or null when unscored. */
function qualityLabel(photo: ReviewQueuePhoto): string | null {
  const s = photo.ai_quality_score
  if (s === null || s === undefined) return null
  return `${Math.round(s * 100)}%`
}

/** Colour class for the quality chip: green / yellow / red. */
function qualityClass(photo: ReviewQueuePhoto): string {
  const s = photo.ai_quality_score
  if (s === null || s === undefined) return ''
  if (s >= 0.65) return 'rq-quality--good'
  if (s >= 0.4) return 'rq-quality--medium'
  return 'rq-quality--poor'
}

function backToGallery() {
  void router.push({ name: 'fotos-gallery' })
}

onMounted(() => {
  void loadInitial()
})
</script>

<template>
  <div class="review-queue-view">
    <header class="rq-header">
      <div class="rq-header-left">
        <Button
          icon="pi pi-arrow-left"
          text rounded
          v-tooltip.bottom="'Zurück zur Galerie'"
          @click="backToGallery"
        />
        <h2 class="rq-title">
          Gruppen-Review
          <span class="rq-count">({{ total }} offen)</span>
        </h2>
      </div>
      <div class="rq-header-right">
        <Button
          icon="pi pi-check-circle"
          severity="success"
          outlined
          :label="highConfidenceTotal > 0
            ? `Alle Sicheren bestätigen (${highConfidenceTotal})`
            : 'Alle Sicheren bestätigen'"
          :loading="bulkBusy"
          :disabled="bulkBusy || loading || highConfidenceTotal === 0"
          @click="askBulkAcceptHigh"
        />
      </div>
    </header>

    <div class="rq-filter">
      <SelectButton
        v-model="confidenceFilter"
        :options="filterOptions"
        option-label="label"
        option-value="value"
        :allow-empty="false"
        @update:model-value="onChangeFilter"
      />
    </div>

    <Message
      v-if="bulkResult"
      severity="info"
      :closable="true"
      @close="bulkResult = null"
    >
      {{ bulkResult.groups_accepted }} Gruppen bestätigt,
      {{ bulkResult.hidden_count }} Fotos ausgeblendet.
    </Message>

    <Message
      v-if="duplicateDeleteResult"
      severity="success"
      :closable="true"
      @close="duplicateDeleteResult = null"
    >
      {{ duplicateDeleteResult.deleted }} {{ duplicateDeleteResult.deleted === 1 ? 'Duplikat' : 'Duplikate' }}
      endgültig gelöscht, {{ fmtBytes(duplicateDeleteResult.freedBytes) }} freigegeben.
    </Message>

    <Message
      v-if="loadError"
      severity="error"
      :closable="true"
      @close="loadError = ''"
    >
      {{ loadError }}
    </Message>

    <div v-if="!loading && groups.length === 0 && !loadError" class="rq-empty">
      <i class="pi pi-check-circle" />
      <p>Keine offenen Gruppen.</p>
      <Button text label="Zurück zur Galerie" @click="backToGallery" />
    </div>

    <ul class="rq-list">
      <li
        v-for="group in groups"
        :key="group.id"
        class="rq-card"
        :class="{ 'rq-card--pending': pendingAcceptIds.has(group.id) }"
      >
        <div class="rq-card-meta">
          <span v-if="group.duplicate_candidate" class="rq-duplicate-badge">
            <i class="pi pi-copy" /> Sehr wahrscheinliches Duplikat
          </span>
          <span :class="confidenceClass(group.ai_picked_confidence)">
            {{ confidenceLabel(group.ai_picked_confidence) }}
          </span>
          <!-- Confidence-bar: visualises Δ to the runner-up so the user
               can tell "AI is sure" (full) vs. "barely above the next
               photo" (almost empty) before committing the pick. -->
          <div
            v-if="group.runner_up_delta != null"
            class="rq-confbar"
            :title="`Δ zum zweitbesten Foto: ${group.runner_up_delta.toFixed(3)}`"
            :class="{
              'rq-confbar--high': group.ai_picked_confidence === 'high',
              'rq-confbar--medium': group.ai_picked_confidence === 'medium',
              'rq-confbar--low': group.ai_picked_confidence === 'low',
            }"
          >
            <div
              class="rq-confbar-fill"
              :style="{ width: `${confidenceBarFraction(group) * 100}%` }"
            />
          </div>
          <span class="rq-card-count">{{ group.member_count }} Fotos</span>
        </div>

        <!-- Stufe C: small groups (≤ 3 photos) get a side-by-side
             layout where every member is equally large and clickable.
             One tap on a photo = "keep this one, hide the rest". The
             AI's suggestion still gets a green outline + check icon
             as a hint, but the user can ignore it. -->
        <div
          v-if="isSmallGroup(group)"
          class="rq-card-oneclick"
        >
          <button
            v-for="photo in group.photos"
            :key="photo.id"
            type="button"
            class="rq-oneclick-tile"
            :class="{
              'rq-oneclick-tile--ai-pick': photo.ai_picked,
              'rq-oneclick-tile--duplicate-pick': group.duplicate_recommended_photo_id === photo.id,
            }"
            :title="photo.ai_picked
              ? 'KI-Vorschlag — Klick = dieses behalten, Rest verstecken'
              : group.duplicate_recommended_photo_id === photo.id
                ? 'Empfohlenes Duplikat-Original — Klick = dieses behalten, Rest verstecken'
              : 'Klick = dieses behalten, Rest verstecken'"
            :disabled="pendingAcceptIds.has(group.id)"
            @click="onPickOne(group, photo.id)"
          >
            <img
              :src="thumb(photo.filename, 800)"
              :alt="''"
              loading="lazy"
              decoding="async"
            />
            <i v-if="photo.ai_picked" class="pi pi-check rq-oneclick-check" />
            <span
              v-if="qualityLabel(photo)"
              class="rq-quality"
              :class="qualityClass(photo)"
              v-tooltip.top="'KI-Qualität'"
            >
              <i class="pi pi-sparkles" />
              {{ qualityLabel(photo) }}
            </span>
          </button>
        </div>

        <!-- Regular layout for groups with 4+ photos. AI pick big +
             sibling strip + dual action buttons. -->
        <template v-else>
          <!-- AI pick big. If multiple picks, show all big.
               Tap the hero to open in fullscreen lightbox — same access
               path as the sibling strip, since the user might also want
               to inspect the pick at full resolution. -->
          <div class="rq-card-picks">
            <img
              v-for="photo in group.photos.filter((p) => p.ai_picked)"
              :key="photo.id"
              :src="thumb(photo.filename, 800)"
              :alt="''"
              class="rq-card-pick"
              loading="lazy"
              decoding="async"
              @click="openLightbox(photo.filename, true)"
            />
            <!-- Fallback: no AI pick → show first photo big -->
            <img
              v-if="group.ai_picked_photo_ids.length === 0 && group.photos[0]"
              :src="thumb(group.photos[0].filename, 800)"
              :alt="''"
              class="rq-card-pick"
              loading="lazy"
              decoding="async"
              @click="openLightbox(group.photos[0].filename, false)"
            />
          </div>

          <!-- Sibling strip. Picks get a green check; non-picks dimmed.
               Peer signals get a tiny coloured dot in the bottom-left
               corner — red for "another album-member hid this", gold
               for "another favourited this". Tap any thumb to open in
               the fullscreen lightbox. -->
          <div v-if="group.photos.length > 1" class="rq-card-strip">
            <button
              v-for="photo in group.photos"
              :key="photo.id"
              type="button"
              class="rq-thumb"
              :class="{
                'rq-thumb--picked': photo.ai_picked,
                'rq-thumb--non-pick': !photo.ai_picked && group.ai_picked_photo_ids.length > 0,
                'rq-thumb--duplicate-pick': group.duplicate_recommended_photo_id === photo.id,
              }"
              :aria-label="photo.ai_picked
                ? 'KI-Pick — bildschirmfüllend ansehen'
                : 'Bildschirmfüllend ansehen'"
              @click="openLightbox(photo.filename, photo.ai_picked)"
            >
              <img
                :src="thumb(photo.filename, 200)"
                :alt="''"
                loading="lazy"
                decoding="async"
              />
              <i v-if="photo.ai_picked" class="pi pi-check rq-thumb-check" />
              <span
                v-if="qualityLabel(photo)"
                class="rq-quality rq-quality--strip"
                :class="qualityClass(photo)"
                v-tooltip.top="'KI-Qualität'"
              >
                {{ qualityLabel(photo) }}
              </span>
              <span
                v-if="photo.peer_curation.hidden > 0"
                class="rq-peer-dot rq-peer-dot--hidden"
                v-tooltip.top="`${photo.peer_curation.hidden} Album-Mitglied(er) haben dieses Foto ausgeblendet`"
              >
                {{ photo.peer_curation.hidden > 9 ? '9+' : photo.peer_curation.hidden }}
              </span>
              <span
                v-if="photo.peer_curation.favorite > 0"
                class="rq-peer-dot rq-peer-dot--favorite"
                v-tooltip.top="`${photo.peer_curation.favorite} Album-Mitglied(er) haben dieses Foto favorisiert`"
              >
                ★
              </span>
            </button>
          </div>
        </template>

        <div class="rq-card-actions">
          <!-- AI accept stays available even in small-group layout, in
               case the user wants the multi-pick result without
               picking one specifically. -->
          <Button
            icon="pi pi-check"
            severity="success"
            :label="group.duplicate_candidate ? 'Bestes Duplikat behalten' : 'KI-Pick übernehmen'"
            :disabled="pendingAcceptIds.has(group.id) || (!group.duplicate_candidate && group.ai_picked_photo_ids.length === 0)"
            @click="onAccept(group)"
          />
          <Button
            v-if="canManageData && group.duplicate_candidate && group.duplicate_deletable_count > 0"
            icon="pi pi-trash"
            outlined
            severity="danger"
            :label="`${group.duplicate_deletable_count} endgültig löschen`"
            :disabled="pendingAcceptIds.has(group.id)"
            @click="askDeleteDuplicates(group)"
          />
          <Button
            icon="pi pi-images"
            outlined
            severity="success"
            label="Alle wählen"
            v-tooltip.top="'Gruppe ohne Ausblenden als reviewed markieren'"
            :disabled="pendingAcceptIds.has(group.id)"
            @click="onKeepAll(group)"
          />
          <Button
            v-if="hasAnyPeerSignal(group)"
            icon="pi pi-users"
            outlined
            severity="secondary"
            label="Konsens übernehmen"
            v-tooltip.top="'Entscheidungen anderer Album-Mitglieder übernehmen'"
            :disabled="pendingAcceptIds.has(group.id)"
            @click="askConsensus(group)"
          />
          <Button
            icon="pi pi-search"
            outlined
            label="Manuell prüfen"
            @click="openManual(group)"
          />
        </div>
      </li>
    </ul>

    <div v-if="!reachedEnd" class="rq-more">
      <Button
        text
        :label="loading ? 'Lade…' : 'Mehr laden'"
        :disabled="loading"
        @click="loadMore"
      />
    </div>

    <PhotoCompareView
      v-if="activeGroup"
      :group="activeGroup"
      :all-photos="[]"
      :total-unreviewed="total"
      @close="onCompareClose"
      @reviewed="onCompareReviewed"
      @next="onCompareNext"
    />

    <!-- Bulk-Accept disclaimer (Stufe D). Shows the user's actual
         agreement rate on already-reviewed groups so they know the
         risk before committing a non-trivial batch action. -->
    <Dialog
      v-model:visible="bulkConfirmOpen"
      modal
      header="Alle hochkonfidenten Gruppen bestätigen?"
      :style="{ width: 'min(560px, 92vw)' }"
    >
      <p v-if="calibrationAccuracyAvg != null">
        Bei deinen bisher reviewten Gruppen hat die KI in
        <strong>{{ fmtPct(calibrationAccuracyAvg) }}</strong>
        der Fälle das Foto getroffen, das du auch behalten hättest.
      </p>
      <p v-else>
        Du hast noch keine eigenen Gewichte kalibriert — die KI nutzt
        gerade die globalen Defaults. Klicke vorher "KI auf meine
        Vorlieben kalibrieren" im DataManagement, falls die Treffer-
        Quote auf deinen Daten bewertet werden soll.
      </p>
      <p v-if="userCalibration" class="rq-calib-detail">
        Personen-Bursts:
        <strong>{{ fmtPct(userCalibration.top1_accuracy_face) }}</strong>
        ({{ userCalibration.pair_count_face }} Paare) &middot;
        andere Bursts:
        <strong>{{ fmtPct(userCalibration.top1_accuracy_non_face) }}</strong>
        ({{ userCalibration.pair_count_non_face }} Paare) &middot;
        Stand: {{ fmtDate(userCalibration.fitted_at) }}
      </p>
      <p class="rq-calib-detail">
        Versteckte Fotos lassen sich später jederzeit über den Filter
        "Ausgeblendete anzeigen" zurückholen.
      </p>
      <template #footer>
        <Button label="Abbrechen" text @click="bulkConfirmOpen = false" />
        <Button
          icon="pi pi-check-circle"
          severity="success"
          label="Ja, alle bestätigen"
          @click="confirmBulkAcceptHigh"
        />
      </template>
    </Dialog>

    <!-- Konsens-Übernahme — Phase 2. Preview the bucket counts before
         the user commits; surface the actual result after. The footer
         slot has to be a direct child of <Dialog>, so we branch on the
         result/preview state inside one slot rather than nesting
         <template #footer> inside a v-if. -->
    <Dialog
      :visible="consensusGroup != null"
      @update:visible="(v: boolean) => { if (!v) closeConsensusDialog() }"
      modal
      header="Entscheidungen anderer übernehmen?"
      :style="{ width: 'min(520px, 92vw)' }"
    >
      <p v-if="consensusResult">
        <strong>{{ consensusResult.hidden_count }}</strong>
        Foto(s) ausgeblendet (Konsens) ·
        <strong>{{ consensusResult.kept_count }}</strong>
        mit Signal behalten ·
        <strong>{{ consensusResult.no_signal_count }}</strong>
        ohne Peer-Signal unverändert.
      </p>
      <template v-else-if="consensusPreview">
        <p>
          Konsens-Regel: <em>Ein Foto wird nur ausgeblendet, wenn
          mindestens ein Album-Mitglied es ausgeblendet hat
          <strong>und</strong> niemand es favorisiert hat.</em>
          Deine eigenen Favoriten bleiben unangetastet.
        </p>
        <ul class="rq-consensus-preview">
          <li>
            <span class="rq-consensus-dot rq-consensus-dot--hide" />
            <strong>{{ consensusPreview.willHide }}</strong>
            Foto(s) werden ausgeblendet
          </li>
          <li>
            <span class="rq-consensus-dot rq-consensus-dot--keep" />
            <strong>{{ consensusPreview.willKeep }}</strong>
            Foto(s) bleiben sichtbar (Peer-Signal, aber Favorit dagegen)
          </li>
          <li>
            <span class="rq-consensus-dot rq-consensus-dot--none" />
            <strong>{{ consensusPreview.noSignal }}</strong>
            Foto(s) ohne Peer-Signal — unverändert
          </li>
        </ul>
      </template>
      <template #footer>
        <Button
          v-if="consensusResult"
          label="Schließen"
          @click="closeConsensusDialog"
        />
        <template v-else>
          <Button
            label="Abbrechen"
            severity="secondary"
            outlined
            :disabled="consensusBusy"
            @click="closeConsensusDialog"
          />
          <Button
            label="Übernehmen"
            icon="pi pi-check"
            severity="success"
            :loading="consensusBusy"
            :disabled="consensusBusy"
            @click="confirmConsensus"
          />
        </template>
      </template>
    </Dialog>

    <!-- Lightbox: tap a strip thumb (or the hero pick) to inspect at
         full size. Click anywhere (image, backdrop) or press ESC to
         close. Single instance, kept outside the v-for to avoid stale
         state when paginating. -->
    <div
      v-if="lightboxFilename"
      class="rq-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label="Foto in voller Größe"
      @click="closeLightbox"
    >
      <button
        type="button"
        class="rq-lightbox-close"
        aria-label="Schließen"
        @click="closeLightbox"
      >
        <i class="pi pi-times" />
      </button>
      <div v-if="lightboxIsPicked" class="rq-lightbox-badge">
        <i class="pi pi-check-circle" />
        KI-Pick
      </div>
      <img
        :src="thumb(lightboxFilename, 1600)"
        :alt="''"
        class="rq-lightbox-img"
      />
    </div>
  </div>
</template>

<style scoped>
.review-queue-view {
  max-width: 1100px;
  margin: 0 auto;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.rq-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}
.rq-header-left {
  display: flex;
  align-items: center;
  gap: 8px;
}
.rq-title {
  font-size: 1.4rem;
  font-weight: 600;
  margin: 0;
}
.rq-count {
  font-weight: 400;
  color: var(--p-text-muted-color);
  margin-left: 6px;
}

.rq-filter {
  display: flex;
  justify-content: center;
}

.rq-empty {
  text-align: center;
  color: var(--p-text-muted-color);
  padding: 48px 16px;
}
.rq-empty .pi-check-circle {
  font-size: 2.5rem;
  color: var(--p-green-500, #22c55e);
  margin-bottom: 12px;
}

.rq-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.rq-card {
  background: var(--p-content-background);
  border: 1px solid var(--p-content-border-color);
  border-radius: 12px;
  padding: 16px;
  display: grid;
  gap: 12px;
  transition: opacity 0.15s;
}
.rq-card--pending {
  opacity: 0.4;
  pointer-events: none;
}

.rq-card-meta {
  display: flex;
  align-items: center;
  gap: 12px;
}

.rq-duplicate-badge {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  color: var(--p-orange-700, #c2410c);
  font-weight: 700;
}
.rq-conf {
  font-size: 0.75rem;
  font-weight: 700;
  padding: 3px 10px;
  border-radius: 999px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.rq-conf--high {
  background: var(--p-green-100, rgba(34,197,94,0.16));
  color: var(--p-green-700, #15803d);
}
.rq-conf--medium {
  background: var(--p-orange-100, rgba(249,115,22,0.16));
  color: var(--p-orange-700, #c2410c);
}
.rq-conf--low,
.rq-conf--unknown {
  background: var(--p-content-hover-background);
  color: var(--p-text-muted-color);
}
.rq-card-count {
  color: var(--p-text-muted-color);
  font-size: 0.9rem;
}

/* Confidence-bar (Stufe D): horizontal pill that fills proportionally
   to the auto-hide threshold. Colour tracks the confidence-chip so
   bar and chip read as one visual unit. */
.rq-confbar {
  flex: 1 1 auto;
  max-width: 220px;
  height: 6px;
  border-radius: 999px;
  background: var(--p-content-hover-background);
  overflow: hidden;
}
.rq-confbar-fill {
  height: 100%;
  background: var(--p-text-muted-color);
  border-radius: 999px;
  transition: width 0.2s;
}
.rq-confbar--high .rq-confbar-fill {
  background: var(--p-green-500, #22c55e);
}
.rq-confbar--medium .rq-confbar-fill {
  background: var(--p-orange-500, #f97316);
}
.rq-confbar--low .rq-confbar-fill {
  background: var(--p-text-muted-color);
}

.rq-calib-detail {
  font-size: 0.85rem;
  color: var(--p-text-muted-color);
  margin: 8px 0 0 0;
}

/* Stufe C: One-Click-Pick — side-by-side equal-sized photos. Tap a
   photo to keep it. The AI's suggestion is hinted with a green
   outline + check icon but every photo is equally clickable. */
.rq-card-oneclick {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.rq-oneclick-tile {
  flex: 1 1 0;
  min-width: 0;
  min-height: 220px;
  border: 2px solid transparent;
  border-radius: 8px;
  padding: 0;
  background: var(--p-content-hover-background);
  cursor: pointer;
  position: relative;
  overflow: hidden;
  transition: border-color 0.15s, transform 0.1s;
}
.rq-oneclick-tile:hover:not(:disabled) {
  border-color: var(--p-primary-400, #60a5fa);
}
.rq-oneclick-tile:active:not(:disabled) {
  transform: scale(0.99);
}
.rq-oneclick-tile:disabled {
  cursor: not-allowed;
}
.rq-oneclick-tile img {
  display: block;
  width: 100%;
  height: 100%;
  max-height: 360px;
  object-fit: contain;
}
.rq-oneclick-tile--ai-pick {
  border-color: var(--p-green-500, #22c55e);
}

.rq-oneclick-tile--duplicate-pick {
  box-shadow: inset 0 0 0 3px var(--p-orange-500, #f97316);
}

.rq-thumb--duplicate-pick {
  box-shadow: 0 0 0 3px var(--p-orange-500, #f97316);
}
.rq-oneclick-check {
  position: absolute;
  top: 8px;
  right: 8px;
  background: var(--p-green-500, #22c55e);
  color: #fff;
  width: 24px;
  height: 24px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 0.85rem;
  pointer-events: none;
}

.rq-card-picks {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.rq-card-pick {
  flex: 1 1 280px;
  max-height: 360px;
  width: 100%;
  object-fit: contain;
  background: var(--p-content-hover-background);
  border-radius: 8px;
  cursor: zoom-in;
}

.rq-card-strip {
  display: flex;
  gap: 6px;
  overflow-x: auto;
  padding-bottom: 4px;
}
.rq-thumb {
  flex: 0 0 80px;
  width: 80px;
  height: 80px;
  position: relative;
  border-radius: 6px;
  overflow: hidden;
  background: var(--p-content-hover-background);
  /* Reset <button> defaults — the element is a button for keyboard
     access (Enter/Space → openLightbox) but visually a thumb tile. */
  border: 0;
  padding: 0;
  margin: 0;
  cursor: zoom-in;
}
.rq-thumb:focus-visible {
  outline: 2px solid var(--p-primary-color);
  outline-offset: 2px;
}
.rq-thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.rq-thumb--non-pick img {
  opacity: 0.5;
  filter: grayscale(0.3);
}
.rq-thumb--picked {
  outline: 2px solid var(--p-green-500, #22c55e);
  outline-offset: -2px;
}
.rq-peer-dot {
  position: absolute;
  bottom: 3px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  border-radius: 9px;
  font-size: 0.65rem;
  font-weight: 700;
  color: #fff;
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.4);
}
.rq-peer-dot--hidden {
  left: 3px;
  background: rgba(220, 38, 38, 0.95); /* red — peer voted to hide */
}
.rq-peer-dot--favorite {
  right: 3px;
  background: rgba(234, 179, 8, 0.95); /* gold — peer favorited */
}
.rq-thumb-check {
  position: absolute;
  top: 4px;
  right: 4px;
  background: var(--p-green-500, #22c55e);
  color: #fff;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 0.7rem;
}

/* AI quality rating chip. Top-left so it clears the pick-check (top-right)
   and the peer-signal dots (bottom corners). Hidden entirely when the
   photo has no score yet — no "?" placeholder on the cards. */
.rq-quality {
  position: absolute;
  top: 4px;
  left: 4px;
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 1px 6px;
  border-radius: 9px;
  font-size: 0.7rem;
  font-weight: 700;
  color: #fff;
  background: rgba(0, 0, 0, 0.6);
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.4);
}
.rq-quality--strip {
  font-size: 0.6rem;
  padding: 0 4px;
}
.rq-quality--good { color: #4ade80; }
.rq-quality--medium { color: #fde047; }
.rq-quality--poor { color: #f87171; }

.rq-card-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.rq-more {
  display: flex;
  justify-content: center;
  padding: 16px 0;
}

.rq-consensus-preview {
  list-style: none;
  padding: 0;
  margin: 12px 0 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.rq-consensus-preview li {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 0.95rem;
}
.rq-consensus-dot {
  display: inline-block;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  flex-shrink: 0;
}
.rq-consensus-dot--hide { background: rgba(220, 38, 38, 0.95); }
.rq-consensus-dot--keep { background: rgba(234, 179, 8, 0.95); }
.rq-consensus-dot--none { background: var(--p-content-border-color); }

/* ── Lightbox ── Full-bleed overlay so the user can verify what the
   KI hid before committing. Backdrop is near-opaque (not the standard
   modal-scrim) since the only thing that matters is seeing the photo. */
.rq-lightbox {
  position: fixed;
  inset: 0;
  z-index: 1000;
  background: rgba(0, 0, 0, 0.92);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  cursor: zoom-out;
}
.rq-lightbox-img {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  cursor: zoom-out;
  user-select: none;
}
.rq-lightbox-close {
  position: absolute;
  top: 16px;
  right: 16px;
  width: 40px;
  height: 40px;
  border-radius: 50%;
  border: 0;
  background: rgba(255, 255, 255, 0.15);
  color: #fff;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 1.1rem;
}
.rq-lightbox-close:hover {
  background: rgba(255, 255, 255, 0.25);
}
.rq-lightbox-badge {
  position: absolute;
  top: 16px;
  left: 16px;
  display: flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.3rem 0.7rem;
  border-radius: 1rem;
  background: rgba(34, 197, 94, 0.9);
  color: #fff;
  font-weight: 600;
  font-size: 0.85rem;
}
</style>
