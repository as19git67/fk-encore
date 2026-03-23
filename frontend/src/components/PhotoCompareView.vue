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

const isTwoPhotos = computed(() => groupPhotos.value.length === 2)
const comparePair = ref<[number, number] | null>(null)
const selectedForCompare = ref<Set<number>>(new Set())

onMounted(() => {
  if (isTwoPhotos.value) {
    comparePair.value = [groupPhotos.value[0]!.id, groupPhotos.value[1]!.id]
  }
  // Lock body scroll
  document.body.style.overflow = 'hidden'
})

watch(() => props.group.id, () => {
  selectedForCompare.value = new Set()
  if (isTwoPhotos.value) {
    comparePair.value = [groupPhotos.value[0]!.id, groupPhotos.value[1]!.id]
  } else {
    comparePair.value = null
  }
})

onUnmounted(() => {
  document.body.style.overflow = ''
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
  <Teleport to="body">
    <div class="compare-overlay">
      <!-- Header -->
      <div class="compare-header">
        <div class="compare-header-left">
          <Button
            v-if="comparePair && !isTwoPhotos"
            label="Zurück zur Übersicht"
            icon="pi pi-arrow-left"
            @click="closeCompare"
            text
            size="small"
          />
        </div>
        <div class="compare-title">
          <span class="font-semibold">{{ group.member_count }} ähnliche Fotos</span>
          <span v-if="totalUnreviewed > 0" class="text-secondary text-sm ml-2">
            ({{ totalUnreviewed }} Gruppen offen)
          </span>
        </div>
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
        <div class="side-by-side-photos">
          <div v-for="photoId in comparePair" :key="photoId" class="side-by-side-item"
            :class="{ 'is-hidden': getCuration(photoId) === 'hidden', 'is-favorite': getCuration(photoId) === 'favorite' }"
          >
            <div class="side-by-side-image">
              <HeicImage :src="getPhotoUrl(allPhotos.find(p => p.id === photoId)!.filename)" alt="" objectFit="contain" />
            </div>
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
      <div v-else class="compare-scroll">
        <div class="compare-body" :class="columnClass">
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
        <div class="compare-footer text-sm text-secondary">
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
  background: #0a0a0a;
  z-index: 1000;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.compare-header {
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  align-items: center;
  padding: 0.5rem 1rem;
  border-bottom: 1px solid rgba(255,255,255,0.1);
  background: #0a0a0a;
  flex-shrink: 0;
  z-index: 10;
}

.compare-header-left {
  display: flex;
  align-items: center;
}

.compare-title {
  color: #e5e7eb;
  text-align: center;
  white-space: nowrap;
}

.compare-actions {
  display: flex;
  gap: 0.5rem;
  align-items: center;
  justify-content: flex-end;
}

/* Side-by-side fullscreen layout */
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

.side-by-side-item.is-favorite {
  outline: 3px solid var(--p-yellow-500);
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

.side-by-side-controls {
  display: flex;
  gap: 0.5rem;
  padding: 0.5rem;
  justify-content: center;
  flex-shrink: 0;
  background: #111;
}

/* Grid triage view (3+ photos) */
.compare-scroll {
  flex: 1;
  overflow-y: auto;
  min-height: 0;
}

.compare-body {
  display: grid;
  gap: 1rem;
  padding: 1rem;
}

.compare-grid-2 { grid-template-columns: repeat(2, 1fr); }
.compare-grid-3 { grid-template-columns: repeat(3, 1fr); }
.compare-grid-4 { grid-template-columns: repeat(2, 1fr); }

.compare-photo {
  border-radius: 8px;
  overflow: hidden;
  background: #1a1a1a;
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
  color: #9ca3af;
}

.compare-footer {
  padding: 0.75rem 1.5rem;
  text-align: center;
  border-top: 1px solid rgba(255,255,255,0.08);
  color: #9ca3af;
}
</style>
