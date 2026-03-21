<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import Button from 'primevue/button'
import HeicImage from './HeicImage.vue'
import {
  getPhotoUrl,
  updatePhotoCuration,
  reviewPhotoGroup,
  type Photo,
  type PhotoGroup,
  type CurationStatus,
} from '../api/photos'

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

// Local curation state (synced from photo data, updated optimistically)
const localCuration = ref(new Map<number, CurationStatus>())

function syncCuration() {
  const map = new Map<number, CurationStatus>()
  for (const photo of groupPhotos.value) {
    map.set(photo.id, photo.curation_status)
  }
  localCuration.value = map
}

onMounted(syncCuration)
watch(() => props.group.id, syncCuration)

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

// Fix #1: For 2-photo groups, go directly to side-by-side
const isTwoPhotos = computed(() => groupPhotos.value.length === 2)
const comparePair = ref<[number, number] | null>(null)
const selectedForCompare = ref<Set<number>>(new Set())

onMounted(() => {
  if (isTwoPhotos.value) {
    comparePair.value = [groupPhotos.value[0]!.id, groupPhotos.value[1]!.id]
  }
})
watch(() => props.group.id, () => {
  selectedForCompare.value = new Set()
  if (isTwoPhotos.value) {
    comparePair.value = [groupPhotos.value[0]!.id, groupPhotos.value[1]!.id]
  } else {
    comparePair.value = null
  }
})

function toggleCompareSelect(id: number) {
  const newSet = new Set(selectedForCompare.value)
  if (newSet.has(id)) {
    newSet.delete(id)
  } else {
    if (newSet.size >= 2) {
      const first = newSet.values().next().value!
      newSet.delete(first)
    }
    newSet.add(id)
  }
  selectedForCompare.value = newSet
  if (newSet.size === 2) {
    comparePair.value = [...newSet] as [number, number]
  } else {
    comparePair.value = null
  }
}

function closeCompare() {
  comparePair.value = null
  selectedForCompare.value = new Set()
}

// Keyboard shortcuts
function handleKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    if (comparePair.value && !isTwoPhotos.value) {
      closeCompare()
    } else {
      emit('close')
    }
  }
}

onMounted(() => window.addEventListener('keydown', handleKeydown))
onUnmounted(() => window.removeEventListener('keydown', handleKeydown))

const columnClass = computed(() => {
  const count = groupPhotos.value.length
  if (count <= 2) return 'compare-grid-2'
  if (count <= 3) return 'compare-grid-3'
  return 'compare-grid-4'
})
</script>

<template>
  <!-- Fix #2: prevent background scroll -->
  <Teleport to="body">
    <div class="compare-overlay" @click.self="$emit('close')" @wheel.prevent @touchmove.prevent>
      <div class="compare-panel" @wheel.stop>
        <!-- Header -->
        <div class="compare-header">
          <div class="compare-title">
            <span class="font-semibold">{{ group.member_count }} ähnliche Fotos</span>
            <span v-if="totalUnreviewed > 0" class="text-secondary text-sm ml-2">
              ({{ totalUnreviewed }} Gruppen offen)
            </span>
          </div>
          <!-- Fix #7: Separate Fertig and Weiter buttons -->
          <div class="compare-actions">
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
          </div>
        </div>

        <!-- Side-by-side detail compare -->
        <div v-if="comparePair" class="side-by-side">
          <div v-if="!isTwoPhotos" class="side-by-side-header">
            <span class="font-medium">Detailvergleich</span>
            <Button label="Zurück zur Übersicht" icon="pi pi-arrow-left" @click="closeCompare" text size="small" />
          </div>
          <div class="side-by-side-photos">
            <div v-for="photoId in comparePair" :key="photoId" class="side-by-side-item"
              :class="{ 'is-hidden': getCuration(photoId) === 'hidden', 'is-favorite': getCuration(photoId) === 'favorite' }"
            >
              <HeicImage :src="getPhotoUrl(allPhotos.find(p => p.id === photoId)!.filename)" alt="" />
              <!-- Fix #4: Colored, solid buttons -->
              <div class="side-by-side-controls">
                <Button
                  icon="pi pi-eye-slash"
                  label="Ausblenden"
                  :severity="getCuration(photoId) === 'hidden' ? 'danger' : 'secondary'"
                  :outlined="getCuration(photoId) !== 'hidden'"
                  size="small"
                  @click="setCuration(photoId, 'hidden')"
                />
                <Button
                  icon="pi pi-heart"
                  label="Favorit"
                  :severity="getCuration(photoId) === 'favorite' ? 'warn' : 'secondary'"
                  :outlined="getCuration(photoId) !== 'favorite'"
                  size="small"
                  @click="setCuration(photoId, 'favorite')"
                />
              </div>
            </div>
          </div>
        </div>

        <!-- Grid triage view (3+ photos) -->
        <div v-else class="compare-body" :class="columnClass">
          <div
            v-for="photo in groupPhotos"
            :key="photo.id"
            class="compare-photo"
            :class="{
              'is-hidden': getCuration(photo.id) === 'hidden',
              'is-favorite': getCuration(photo.id) === 'favorite',
              'compare-selected': selectedForCompare.has(photo.id)
            }"
          >
            <div class="compare-photo-image" @click="toggleCompareSelect(photo.id)">
              <HeicImage :src="getPhotoUrl(photo.filename)" :alt="photo.original_name" />
              <div v-if="selectedForCompare.has(photo.id)" class="compare-select-indicator">
                <i class="pi pi-search-plus"></i>
              </div>
            </div>
            <!-- Fix #4: Colored, distinct buttons -->
            <div class="compare-photo-controls">
              <Button
                icon="pi pi-eye-slash"
                label="Ausblenden"
                :severity="getCuration(photo.id) === 'hidden' ? 'danger' : 'contrast'"
                :outlined="getCuration(photo.id) !== 'hidden'"
                size="small"
                @click="setCuration(photo.id, 'hidden')"
              />
              <Button
                icon="pi pi-heart"
                label="Favorit"
                :severity="getCuration(photo.id) === 'favorite' ? 'warn' : 'success'"
                :outlined="getCuration(photo.id) !== 'favorite'"
                size="small"
                @click="setCuration(photo.id, 'favorite')"
              />
            </div>
            <div class="compare-photo-name text-sm text-secondary">{{ photo.original_name }}</div>
          </div>
        </div>

        <div v-if="!comparePair" class="compare-footer text-sm text-secondary">
          Klicke 2 Fotos an, um sie im Detailvergleich nebeneinander zu sehen.
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.compare-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.85);
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1rem;
  overflow: hidden;
}

.compare-panel {
  background: var(--surface-ground);
  border-radius: 12px;
  max-width: 95vw;
  max-height: 95vh;
  width: 100%;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
}

.compare-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 1rem 1.5rem;
  border-bottom: 1px solid var(--surface-border);
  position: sticky;
  top: 0;
  background: var(--surface-ground);
  z-index: 10;
}

.compare-actions {
  display: flex;
  gap: 0.5rem;
  align-items: center;
}

.compare-body {
  display: grid;
  gap: 1rem;
  padding: 1.5rem;
  flex: 1;
}

.compare-grid-2 { grid-template-columns: repeat(2, 1fr); }
.compare-grid-3 { grid-template-columns: repeat(3, 1fr); }
.compare-grid-4 { grid-template-columns: repeat(2, 1fr); }

.compare-photo {
  border-radius: 8px;
  overflow: hidden;
  background: var(--surface-card);
  transition: opacity 0.2s, box-shadow 0.2s;
}

.compare-photo.is-hidden {
  opacity: 0.3;
}

.compare-photo.is-favorite {
  box-shadow: 0 0 0 3px var(--p-yellow-500);
}

.compare-photo.compare-selected {
  box-shadow: 0 0 0 3px var(--p-primary-color);
}

.compare-photo-image {
  position: relative;
  cursor: pointer;
}

.compare-photo-image :deep(img) {
  width: 100%;
  height: auto;
  display: block;
}

.compare-select-indicator {
  position: absolute;
  inset: 0;
  background: rgba(59, 130, 246, 0.15);
  display: flex;
  align-items: center;
  justify-content: center;
}

.compare-select-indicator i {
  font-size: 2rem;
  color: var(--p-primary-color);
  filter: drop-shadow(0 2px 4px rgba(0,0,0,0.3));
}

.compare-photo-controls {
  display: flex;
  gap: 0.5rem;
  padding: 0.75rem;
  justify-content: center;
}

.compare-photo-name {
  padding: 0 0.5rem 0.5rem;
  text-align: center;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.compare-footer {
  padding: 0.75rem 1.5rem;
  text-align: center;
  border-top: 1px solid var(--surface-border);
}

/* Side-by-side */
.side-by-side {
  flex: 1;
  display: flex;
  flex-direction: column;
}

.side-by-side-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0.75rem 1.5rem;
  border-bottom: 1px solid var(--surface-border);
}

.side-by-side-photos {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 4px;
  flex: 1;
  padding: 1rem;
}

.side-by-side-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  transition: opacity 0.2s;
}

.side-by-side-item.is-hidden {
  opacity: 0.3;
}

.side-by-side-item.is-favorite {
  box-shadow: 0 0 0 3px var(--p-yellow-500);
  border-radius: 8px;
}

.side-by-side-item :deep(img) {
  width: 100%;
  max-height: 70vh;
  object-fit: contain;
}

.side-by-side-controls {
  display: flex;
  gap: 0.5rem;
  padding: 0.75rem;
}
</style>
