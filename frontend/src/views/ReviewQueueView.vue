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
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import Button from 'primevue/button'
import Message from 'primevue/message'
import SelectButton from 'primevue/selectbutton'
import PhotoCompareView from '../components/PhotoCompareView.vue'
import {
  getReviewQueue,
  acceptAiPick,
  bulkAcceptHighConfidenceAiPicks,
  type ReviewQueueGroup,
  type PhotoGroup,
} from '../api/photos'
import { getThumbUrl } from '../api/gallery'

const router = useRouter()

const PAGE_SIZE = 30
const groups = ref<ReviewQueueGroup[]>([])
const total = ref(0)
const offset = ref(0)
const loading = ref(false)
const loadError = ref('')
type ConfidenceFilter = 'all' | 'high' | 'medium' | 'low'
const confidenceFilter = ref<ConfidenceFilter>('all')

const filterOptions: Array<{ label: string; value: ConfidenceFilter }> = [
  { label: 'Alle', value: 'all' },
  { label: 'Sicher', value: 'high' },
  { label: 'Mittel', value: 'medium' },
  { label: 'Unsicher', value: 'low' },
]

const bulkBusy = ref(false)
const bulkResult = ref<{ groups_accepted: number; hidden_count: number } | null>(null)
const pendingAcceptIds = ref<Set<number>>(new Set())

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
    offset.value = res.groups.length
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
  if (pendingAcceptIds.value.has(group.id)) return
  // Mark optimistically — UI hides the card right away. On failure
  // we re-insert it.
  const set = new Set(pendingAcceptIds.value)
  set.add(group.id)
  pendingAcceptIds.value = set
  try {
    await acceptAiPick(group.id)
    // Permanently remove the card. Decrement total so the counter
    // stays honest without a refetch.
    groups.value = groups.value.filter((g) => g.id !== group.id)
    total.value = Math.max(0, total.value - 1)
  } catch (err: any) {
    loadError.value = err?.message ?? 'Fehler beim Bestätigen der Gruppe.'
    const reverted = new Set(pendingAcceptIds.value)
    reverted.delete(group.id)
    pendingAcceptIds.value = reverted
  }
}

async function onBulkAcceptHigh() {
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

// ── Manual review (drop into existing PhotoCompareView) ──

const activeGroup = ref<PhotoGroup | null>(null)

function openManual(group: ReviewQueueGroup) {
  activeGroup.value = {
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

function onCompareClose() {
  activeGroup.value = null
}

function onCompareReviewed() {
  const reviewedId = activeGroup.value?.id
  activeGroup.value = null
  if (reviewedId !== undefined) {
    groups.value = groups.value.filter((g) => g.id !== reviewedId)
    total.value = Math.max(0, total.value - 1)
  }
}

// ── Card rendering helpers ──

function thumb(filename: string, w = 400): string {
  return getThumbUrl(filename, w)
}

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
          label="Alle hochkonfidenten bestätigen"
          :loading="bulkBusy"
          :disabled="bulkBusy || loading"
          @click="onBulkAcceptHigh"
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
          <span :class="confidenceClass(group.ai_picked_confidence)">
            {{ confidenceLabel(group.ai_picked_confidence) }}
          </span>
          <span class="rq-card-count">{{ group.member_count }} Fotos</span>
        </div>

        <!-- AI pick big. If multiple picks, show all big. -->
        <div class="rq-card-picks">
          <img
            v-for="photo in group.photos.filter((p) => p.ai_picked)"
            :key="photo.id"
            :src="thumb(photo.filename, 800)"
            :alt="''"
            class="rq-card-pick"
            loading="lazy"
            decoding="async"
          />
          <!-- Fallback: no AI pick → show first photo big -->
          <img
            v-if="group.ai_picked_photo_ids.length === 0 && group.photos[0]"
            :src="thumb(group.photos[0].filename, 800)"
            :alt="''"
            class="rq-card-pick"
            loading="lazy"
            decoding="async"
          />
        </div>

        <!-- Sibling strip. Picks get a green check; non-picks dimmed. -->
        <div v-if="group.photos.length > 1" class="rq-card-strip">
          <div
            v-for="photo in group.photos"
            :key="photo.id"
            class="rq-thumb"
            :class="{
              'rq-thumb--picked': photo.ai_picked,
              'rq-thumb--non-pick': !photo.ai_picked && group.ai_picked_photo_ids.length > 0,
            }"
          >
            <img
              :src="thumb(photo.filename, 200)"
              :alt="''"
              loading="lazy"
              decoding="async"
            />
            <i v-if="photo.ai_picked" class="pi pi-check rq-thumb-check" />
          </div>
        </div>

        <div class="rq-card-actions">
          <Button
            icon="pi pi-check"
            severity="success"
            label="KI-Pick übernehmen"
            :disabled="pendingAcceptIds.has(group.id) || group.ai_picked_photo_ids.length === 0"
            @click="onAccept(group)"
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
    />
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
</style>
