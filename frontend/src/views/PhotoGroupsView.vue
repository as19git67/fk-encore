<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import Button from 'primevue/button'
import Message from 'primevue/message'
import { useConfirm } from 'primevue/useconfirm'
import HeicImage from '../components/HeicImage.vue'
import {
  getPhotoGroups,
  getPhotoUrl,
  mergePersons,
  type PhotoGroup,
  type SimilarPersonPair,
} from '../api/photos'

const groups = ref<PhotoGroup[]>([])
const suggestions = ref<SimilarPersonPair[]>([])
const loading = ref(true)
const error = ref('')
const confirm = useConfirm()

// Expanded groups (show all photos)
const expandedGroupIds = ref<Set<number>>(new Set())

function toggleExpand(personId: number) {
  if (expandedGroupIds.value.has(personId)) {
    expandedGroupIds.value.delete(personId)
  } else {
    expandedGroupIds.value.add(personId)
  }
}

async function loadData() {
  loading.value = true
  error.value = ''
  try {
    const res = await getPhotoGroups()
    groups.value = res.groups
    suggestions.value = res.suggestions
  } catch (err: any) {
    error.value = err.message || 'Fehler beim Laden der Foto-Gruppen'
  } finally {
    loading.value = false
  }
}

function getFaceStyle(bbox: any) {
  if (!bbox) return {}
  const { x, y, width, height } = bbox
  if (x > 1.1 || y > 1.1 || width > 1.1 || height > 1.1) return { objectFit: 'cover' as const }

  const centerX = x + width / 2
  const centerY = y + height / 2
  const zoom = Math.max(1, Math.min(4, 0.6 / Math.max(width, height)))

  return {
    transform: `scale(${zoom})`,
    transformOrigin: `${centerX * 100}% ${centerY * 100}%`,
    objectFit: 'cover' as const,
    display: 'block',
  }
}

function similarityLabel(sim: number): string {
  if (sim >= 0.4) return 'Hoch'
  if (sim >= 0.3) return 'Mittel'
  return 'Niedrig'
}

function similarityClass(sim: number): string {
  if (sim >= 0.4) return 'similarity-high'
  if (sim >= 0.3) return 'similarity-medium'
  return 'similarity-low'
}

async function handleMergeSuggestion(pair: SimilarPersonPair) {
  // Determine target: prefer named person, then the one with more faces
  const p1Named = pair.person1.name !== 'Unbenannt'
  const p2Named = pair.person2.name !== 'Unbenannt'

  let targetId: number
  let sourceId: number

  if (p1Named && !p2Named) {
    targetId = pair.person1.id
    sourceId = pair.person2.id
  } else if (!p1Named && p2Named) {
    targetId = pair.person2.id
    sourceId = pair.person1.id
  } else {
    // Both named or both unnamed: use the one with more faces
    if ((pair.person1.faceCount ?? 0) >= (pair.person2.faceCount ?? 0)) {
      targetId = pair.person1.id
      sourceId = pair.person2.id
    } else {
      targetId = pair.person2.id
      sourceId = pair.person1.id
    }
  }

  const targetPerson = targetId === pair.person1.id ? pair.person1 : pair.person2

  if (targetPerson.name === 'Unbenannt') {
    error.value = 'Bitte benennen Sie mindestens eine Person, bevor Sie zusammenführen.'
    return
  }

  confirm.require({
    message: `"${pair.person1.name}" und "${pair.person2.name}" zu "${targetPerson.name}" zusammenführen?`,
    header: 'Zusammenführen bestätigen',
    icon: 'pi pi-clone',
    rejectProps: { label: 'Abbrechen', severity: 'secondary', outlined: true },
    acceptProps: { label: 'Zusammenführen', severity: 'success' },
    accept: async () => {
      try {
        await mergePersons([sourceId], targetId)
        await loadData()
      } catch (err: any) {
        error.value = err.message || 'Fehler beim Zusammenführen'
      }
    },
  })
}

function dismissSuggestion(pair: SimilarPersonPair) {
  suggestions.value = suggestions.value.filter(
    s => !(s.person1.id === pair.person1.id && s.person2.id === pair.person2.id)
  )
}

onMounted(loadData)
</script>

<template>
  <div class="p-4">
    <div class="header">
      <h1 class="title">Foto-Gruppen</h1>
      <Button icon="pi pi-refresh" label="Aktualisieren" @click="loadData" :loading="loading" />
    </div>

    <Message v-if="error" severity="error" sticky class="mb-4">{{ error }}</Message>

    <!-- Loading -->
    <div v-if="loading && groups.length === 0" class="empty-state">
      <i class="pi pi-spin pi-spinner text-4xl mb-2"></i>
      <p>Gruppen werden geladen...</p>
    </div>

    <!-- Empty -->
    <div v-else-if="groups.length === 0 && suggestions.length === 0" class="empty-state empty-box">
      <i class="pi pi-th-large text-5xl text-gray-400 mb-4"></i>
      <p class="text-xl text-gray-500">Keine Foto-Gruppen gefunden.</p>
      <p class="text-gray-400">Lade Fotos hoch und aktiviere die Gesichtserkennung.</p>
    </div>

    <template v-else>
      <!-- Suggestions Section -->
      <div v-if="suggestions.length > 0" class="suggestions-section">
        <h2 class="section-title">
          <i class="pi pi-lightbulb"></i>
          Vorschläge zum Zusammenführen
        </h2>
        <p class="section-desc">Diese Personen sehen sich ähnlich und könnten dieselbe Person sein.</p>

        <div class="suggestions-list">
          <div v-for="pair in suggestions" :key="`${pair.person1.id}-${pair.person2.id}`" class="suggestion-card">
            <div class="suggestion-persons">
              <div class="suggestion-person">
                <div class="suggestion-avatar">
                  <HeicImage
                    v-if="pair.person1.cover_filename"
                    :src="getPhotoUrl(pair.person1.cover_filename)"
                    :alt="pair.person1.name"
                    objectFit="cover"
                    :imageStyle="getFaceStyle(pair.person1.cover_bbox)"
                  />
                  <i v-else class="pi pi-user placeholder-icon"></i>
                </div>
                <div class="suggestion-person-name">{{ pair.person1.name }}</div>
                <div class="suggestion-person-count">{{ pair.person1.faceCount }} Fotos</div>
              </div>

              <div class="suggestion-similarity">
                <div class="similarity-badge" :class="similarityClass(pair.similarity)">
                  {{ Math.round(pair.similarity * 100) }}%
                </div>
                <div class="similarity-label">{{ similarityLabel(pair.similarity) }}</div>
              </div>

              <div class="suggestion-person">
                <div class="suggestion-avatar">
                  <HeicImage
                    v-if="pair.person2.cover_filename"
                    :src="getPhotoUrl(pair.person2.cover_filename)"
                    :alt="pair.person2.name"
                    objectFit="cover"
                    :imageStyle="getFaceStyle(pair.person2.cover_bbox)"
                  />
                  <i v-else class="pi pi-user placeholder-icon"></i>
                </div>
                <div class="suggestion-person-name">{{ pair.person2.name }}</div>
                <div class="suggestion-person-count">{{ pair.person2.faceCount }} Fotos</div>
              </div>
            </div>

            <div class="suggestion-actions">
              <Button
                icon="pi pi-clone"
                label="Zusammenführen"
                class="p-button-success p-button-sm"
                @click="handleMergeSuggestion(pair)"
              />
              <Button
                icon="pi pi-times"
                label="Verwerfen"
                class="p-button-text p-button-sm"
                @click="dismissSuggestion(pair)"
              />
            </div>
          </div>
        </div>
      </div>

      <!-- Groups Section -->
      <h2 v-if="groups.length > 0" class="section-title groups-title">
        <i class="pi pi-th-large"></i>
        Foto-Gruppen nach Person
      </h2>

      <div class="groups-list">
        <div v-for="group in groups" :key="group.person.id" class="group-card">
          <div class="group-header">
            <div class="group-person-info">
              <div class="group-avatar">
                <HeicImage
                  v-if="group.person.cover_filename"
                  :src="getPhotoUrl(group.person.cover_filename)"
                  :alt="group.person.name"
                  objectFit="cover"
                  :imageStyle="getFaceStyle(group.person.cover_bbox)"
                />
                <i v-else class="pi pi-user placeholder-icon"></i>
              </div>
              <div>
                <div class="group-person-name">{{ group.person.name }}</div>
                <div class="group-person-count">{{ group.person.faceCount }} {{ group.person.faceCount === 1 ? 'Foto' : 'Fotos' }}</div>
              </div>
            </div>
            <Button
              v-if="group.photos.length > 4"
              :icon="expandedGroupIds.has(group.person.id) ? 'pi pi-chevron-up' : 'pi pi-chevron-down'"
              :label="expandedGroupIds.has(group.person.id) ? 'Weniger' : 'Alle zeigen'"
              class="p-button-text p-button-sm"
              @click="toggleExpand(group.person.id)"
            />
          </div>

          <div class="group-photos">
            <div
              v-for="item in (expandedGroupIds.has(group.person.id) ? group.photos : group.photos.slice(0, 4))"
              :key="item.face.id"
              class="group-photo-item"
            >
              <HeicImage
                :src="getPhotoUrl(item.photo.filename)"
                :alt="item.photo.original_name"
                objectFit="cover"
              />
            </div>
            <div
              v-if="!expandedGroupIds.has(group.person.id) && (group.person.faceCount ?? 0) > 4"
              class="group-photo-more"
              @click="toggleExpand(group.person.id)"
            >
              +{{ (group.person.faceCount ?? 0) - 4 }}
            </div>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 1.5rem;
}

.title {
  font-size: 1.875rem;
  font-weight: 700;
}

.mb-4 { margin-bottom: 1rem; }

.empty-state {
  text-align: center;
  padding: 2rem;
}

.empty-box {
  background: #f9fafb;
  border-radius: 0.75rem;
  border: 2px dashed #e5e7eb;
}

/* Suggestions */
.suggestions-section {
  margin-bottom: 2rem;
  padding: 1.25rem;
  background: #fffbeb;
  border: 1px solid #fde68a;
  border-radius: 12px;
}

.section-title {
  font-size: 1.25rem;
  font-weight: 700;
  margin: 0 0 0.25rem;
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.section-desc {
  color: #92400e;
  font-size: 0.875rem;
  margin: 0 0 1rem;
}

.suggestions-list {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.suggestion-card {
  background: white;
  border: 1px solid #e5e7eb;
  border-radius: 10px;
  padding: 1rem;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.suggestion-persons {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 1.5rem;
}

.suggestion-person {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.25rem;
  flex: 1;
  max-width: 140px;
}

.suggestion-avatar {
  width: 80px;
  height: 80px;
  border-radius: 50%;
  overflow: hidden;
  background: #f3f4f6;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 2px solid #e5e7eb;
}

.suggestion-avatar :deep(img) {
  width: 100%;
  height: 100%;
}

.placeholder-icon {
  font-size: 2rem;
  color: #9ca3af;
}

.suggestion-person-name {
  font-weight: 600;
  font-size: 0.875rem;
  text-align: center;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.suggestion-person-count {
  font-size: 0.75rem;
  color: #6b7280;
}

.suggestion-similarity {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.25rem;
}

.similarity-badge {
  font-size: 1.125rem;
  font-weight: 700;
  padding: 0.25rem 0.75rem;
  border-radius: 999px;
}

.similarity-high { background: #dcfce7; color: #166534; }
.similarity-medium { background: #fef3c7; color: #92400e; }
.similarity-low { background: #f3f4f6; color: #6b7280; }

.similarity-label {
  font-size: 0.75rem;
  color: #6b7280;
}

.suggestion-actions {
  display: flex;
  justify-content: center;
  gap: 0.5rem;
}

/* Groups */
.groups-title {
  margin-top: 1rem;
  margin-bottom: 1rem;
}

.groups-list {
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
}

.group-card {
  background: white;
  border: 1px solid #e5e7eb;
  border-radius: 12px;
  overflow: hidden;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.06);
}

.group-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0.75rem 1rem;
  border-bottom: 1px solid #f3f4f6;
}

.group-person-info {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.group-avatar {
  width: 44px;
  height: 44px;
  border-radius: 50%;
  overflow: hidden;
  background: #f3f4f6;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  border: 1px solid #e5e7eb;
}

.group-avatar :deep(img) {
  width: 100%;
  height: 100%;
}

.group-person-name {
  font-weight: 600;
  font-size: 0.9375rem;
}

.group-person-count {
  font-size: 0.8125rem;
  color: #6b7280;
}

.group-photos {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
  gap: 0.5rem;
  padding: 0.75rem;
}

.group-photo-item {
  aspect-ratio: 1;
  border-radius: 8px;
  overflow: hidden;
  background: #f3f4f6;
}

.group-photo-item :deep(.heic-image-container) {
  width: 100%;
  height: 100%;
}

.group-photo-item :deep(img) {
  width: 100%;
  height: 100%;
  object-fit: cover;
  transition: transform 0.2s;
}

.group-photo-item:hover :deep(img) {
  transform: scale(1.05);
}

.group-photo-more {
  aspect-ratio: 1;
  border-radius: 8px;
  background: #f3f4f6;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 1.25rem;
  font-weight: 600;
  color: #6b7280;
  cursor: pointer;
  transition: background 0.2s;
}

.group-photo-more:hover {
  background: #e5e7eb;
}

@media (max-width: 640px) {
  .suggestion-persons {
    gap: 0.75rem;
  }

  .suggestion-avatar {
    width: 60px;
    height: 60px;
  }

  .group-photos {
    grid-template-columns: repeat(auto-fill, minmax(90px, 1fr));
  }
}
</style>
