<script setup lang="ts">
import { ref, watch, nextTick, onMounted, onUnmounted } from 'vue'
import Button from 'primevue/button'
import HeicImage from './HeicImage.vue'
import { usePhotoLazyLoad } from '../composables/usePhotoLazyLoad'
import { getPhotoUrl, type Photo, type CurationStatus, type PhotoGroup } from '../api/photos'
import type { YearGroup, PhotoItem } from '../composables/usePhotoGrouping'

const props = defineProps<{
  /** Already-grouped photos (from usePhotoGrouping) */
  groupedPhotos: YearGroup[]
  /** All photos flat list (needed for index resolution) */
  photos: Photo[]
  selectedIndex: number
  selectedPhotoIds: Set<number>
  canDelete?: boolean
  /** When true, photo items in stacks open the compare view instead of selecting */
  hasStacks?: boolean
}>()

const emit = defineEmits<{
  'update:selectedIndex': [index: number]
  'update:selectedPhotoIds': [ids: Set<number>]
  'update:columnCount': [count: number]
  'photo-click': [item: PhotoItem, event: MouseEvent]
  'photo-dblclick': [item: PhotoItem]
  'stack-click': [group: PhotoGroup]
  'group-multi-select': [group: PhotoGroup, event: MouseEvent]
  'toggle-favorite': [id: number, status: CurationStatus]
  'hide': [id: number]
  'restore': [id: number]
  /** Fired when the topmost visible section header changes (for TimelineNav) */
  'section-change': [sectionId: string]
}>()

const scrollRef = ref<HTMLElement | null>(null)
const { visiblePhotoIds, setupObserver } = usePhotoLazyLoad('300px 0px')

// ── Section tracking (for TimelineNav active highlight) ──────────────────────
let sectionObserver: IntersectionObserver | null = null

function setupSectionObserver(root: HTMLElement) {
  sectionObserver?.disconnect()
  sectionObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          emit('section-change', (entry.target as HTMLElement).dataset.sectionId ?? '')
        }
      }
    },
    { root, rootMargin: '-5% 0px -90% 0px' }
  )
  root.querySelectorAll('[data-section-header]').forEach(el => sectionObserver!.observe(el))
}

// ── Column tracking ──────────────────────────────────────────────────────────
let resizeObserver: ResizeObserver | null = null

function updateColumnCount() {
  const grid = scrollRef.value?.querySelector('.photo-grid')
  if (grid) {
    const cols = getComputedStyle(grid).gridTemplateColumns.split(' ').length
    if (cols > 0) emit('update:columnCount', cols)
  }
}

onMounted(() => {
  resizeObserver = new ResizeObserver(updateColumnCount)
  if (scrollRef.value) resizeObserver.observe(scrollRef.value)
})

onUnmounted(() => {
  resizeObserver?.disconnect()
  sectionObserver?.disconnect()
})

// ── Re-observe after groupedPhotos changes ───────────────────────────────────
watch(() => props.groupedPhotos, async () => {
  await nextTick()
  if (scrollRef.value) {
    setupObserver(scrollRef.value)
    setupSectionObserver(scrollRef.value)
  }
  updateColumnCount()
}, { immediate: false })

watch(scrollRef, async (el) => {
  if (el) {
    await nextTick()
    setupObserver(el)
    setupSectionObserver(el)
    updateColumnCount()
  }
})

// ── Scroll selected photo into view ─────────────────────────────────────────
watch(() => props.selectedIndex, (idx) => {
  if (idx < 0) return
  const photo = props.photos[idx]
  if (!photo) return
  const el = scrollRef.value?.querySelector(`[data-photo-id="${photo.id}"]`)
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
})

// ── Public: scroll to a section header ──────────────────────────────────────
defineExpose({
  scrollToSection(sectionId: string) {
    const el = scrollRef.value?.querySelector(`[data-section-id="${sectionId}"]`)
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
  },
  scrollRef,
})
</script>

<template>
  <div class="photo-grid-scroll" ref="scrollRef">
    <template v-for="yearGroup in groupedPhotos" :key="yearGroup.year">
      <h2
        class="year-title"
        :data-section-id="yearGroup.sectionId"
        data-section-header
      >
        {{ yearGroup.year }}
      </h2>

      <template v-for="monthGroup in yearGroup.months" :key="yearGroup.year + monthGroup.month">
        <h3
          v-if="monthGroup.month"
          class="month-title"
          :data-section-id="monthGroup.sectionId"
          data-section-header
        >
          {{ monthGroup.month }}
        </h3>

        <div class="photo-grid">
          <div
            v-for="item in monthGroup.photos"
            :key="item.photo.id"
            :data-photo-id="item.photo.id"
            class="photo-item"
            :class="{
              selected: selectedPhotoIds.has(item.photo.id),
              'is-hidden': item.photo.curation_status === 'hidden',
              'is-favorite': item.photo.curation_status === 'favorite',
              'is-stack': !!item.group,
            }"
            @click="item.group ? (($event.ctrlKey || $event.metaKey || $event.shiftKey) ? emit('group-multi-select', item.group, $event) : emit('stack-click', item.group)) : emit('photo-click', item, $event)"
            @dblclick="!item.group && emit('photo-dblclick', item)"
          >
            <div class="photo-thumb">
              <HeicImage
                v-if="visiblePhotoIds.has(item.photo.id)"
                :src="getPhotoUrl(item.photo.filename, 400)"
                :alt="item.photo.original_name"
                objectFit="cover"
              />
            </div>

            <!-- Stack badges -->
            <span v-if="item.group" class="stack-badge">{{ item.group.member_count }}</span>
            <i v-if="item.group?.reviewed_at" class="pi pi-check stack-reviewed-badge" />

            <!-- Status badges -->
            <i v-if="item.photo.curation_status === 'favorite'" class="pi pi-heart-fill favorite-badge" />
            <i v-if="item.photo.curation_status === 'hidden'" class="pi pi-eye-slash hidden-badge" />

            <!-- Anonymized curation stats (shared albums only) -->
            <div v-if="(item.photo as any).curation_stats" class="curation-stats-badge">
              <span v-if="(item.photo as any).curation_stats.fav_count > 0" class="stat-fav" :title="`${(item.photo as any).curation_stats.fav_count} von ${(item.photo as any).curation_stats.member_count} finden dieses Foto gut`">
                <i class="pi pi-heart-fill" /> {{ (item.photo as any).curation_stats.fav_count }}/{{ (item.photo as any).curation_stats.member_count }}
              </span>
              <span v-if="(item.photo as any).curation_stats.hide_count > 0" class="stat-hide" :title="`${(item.photo as any).curation_stats.hide_count} von ${(item.photo as any).curation_stats.member_count} haben dieses Foto ausgeblendet`">
                <i class="pi pi-eye-slash" /> {{ (item.photo as any).curation_stats.hide_count }}/{{ (item.photo as any).curation_stats.member_count }}
              </span>
            </div>

            <div class="photo-info">
              <span class="name">
                {{ item.group ? `${item.group.member_count} ähnliche Fotos` : item.photo.original_name }}
              </span>
              <div v-if="!item.group" class="photo-actions">
                <Button
                  v-if="canDelete && item.photo.curation_status === 'hidden'"
                  size="small" icon="pi pi-eye" severity="info" text rounded
                  v-tooltip="'Wiederherstellen'"
                  @click.stop="emit('restore', item.photo.id)"
                />
                <Button
                  v-if="canDelete && item.photo.curation_status !== 'hidden'"
                  size="small"
                  :icon="item.photo.curation_status === 'favorite' ? 'pi pi-heart-fill' : 'pi pi-heart'"
                  :severity="item.photo.curation_status === 'favorite' ? 'warn' : 'secondary'"
                  text rounded
                  v-tooltip="'Favorit'"
                  @click.stop="emit('toggle-favorite', item.photo.id, item.photo.curation_status)"
                />
                <Button
                  v-if="canDelete && item.photo.curation_status !== 'hidden'"
                  size="small" icon="pi pi-eye-slash" severity="danger" text rounded
                  v-tooltip="'Ausblenden'"
                  @click.stop="emit('hide', item.photo.id)"
                />
              </div>
            </div>
          </div>
        </div>
      </template>
    </template>
  </div>
</template>

<style scoped>
.photo-grid-scroll {
  flex: 1;
  min-width: 0;
  overflow-y: auto;
  padding: 0 1rem 1rem;
}

.year-title {
  font-size: 1.4rem;
  font-weight: 700;
  margin: 1.5rem 0 0.5rem;
  color: var(--text-color);
}

.month-title {
  font-size: 1rem;
  font-weight: 600;
  margin: 1rem 0 0.4rem;
  color: var(--text-color-secondary);
}

.photo-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 1rem;
  margin-bottom: 0.5rem;
}

/* ── Photo item ──────────────────────────────────────────────────────────── */
.photo-item {
  position: relative;
  border-radius: 8px;
  overflow: hidden;
  cursor: pointer;
  background: var(--surface-ground);
  border: 2px solid transparent;
  transition: border-color 0.15s, box-shadow 0.15s, transform 0.1s;
}

.photo-item:hover {
  border-color: var(--p-primary-color);
  box-shadow: 0 0 0 2px var(--p-primary-200);
}

.photo-item.selected {
  border-color: var(--p-primary-color);
  box-shadow: 0 0 0 3px var(--p-primary-300);
  transform: scale(1.02);
}

.photo-item.is-hidden {
  opacity: 0.6;
}

.photo-item.is-stack {
  border-style: dashed;
  border-color: var(--surface-border);
}

.photo-thumb {
  width: 100%;
  aspect-ratio: 1;
  background: var(--surface-ground);
  overflow: hidden;
}

.photo-thumb :deep(.heic-image-container) { width: 100%; height: 100%; }

/* ── Badges ──────────────────────────────────────────────────────────────── */
.stack-badge {
  position: absolute;
  top: 6px;
  left: 6px;
  background: rgba(0,0,0,0.65);
  color: #fff;
  font-size: 0.75rem;
  font-weight: 700;
  padding: 2px 6px;
  border-radius: 10px;
}

.stack-reviewed-badge {
  position: absolute;
  top: 6px;
  right: 6px;
  color: var(--p-green-500);
  font-size: 1rem;
  text-shadow: 0 0 4px rgba(0,0,0,0.5);
}

.favorite-badge {
  position: absolute;
  top: 6px;
  right: 6px;
  color: var(--p-orange-400);
  font-size: 1rem;
  text-shadow: 0 0 4px rgba(0,0,0,0.5);
}

.hidden-badge {
  position: absolute;
  bottom: 32px;
  right: 6px;
  color: var(--p-red-400);
  font-size: 0.9rem;
  text-shadow: 0 0 4px rgba(0,0,0,0.5);
}

/* ── Curation stats (shared albums) ─────────────────────────────────────── */
.curation-stats-badge {
  position: absolute;
  bottom: 32px;
  left: 6px;
  display: flex;
  gap: 6px;
  font-size: 0.7rem;
  font-weight: 600;
}

.curation-stats-badge .stat-fav,
.curation-stats-badge .stat-hide {
  display: flex;
  align-items: center;
  gap: 2px;
  background: rgba(0, 0, 0, 0.6);
  color: #fff;
  padding: 1px 5px;
  border-radius: 8px;
}

.curation-stats-badge .stat-fav i { color: var(--p-orange-400); font-size: 0.65rem; }
.curation-stats-badge .stat-hide i { color: var(--p-red-300); font-size: 0.65rem; }

/* ── Hover info bar ──────────────────────────────────────────────────────── */
.photo-info {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  background: linear-gradient(transparent, rgba(0,0,0,0.7));
  color: #fff;
  padding: 0.4rem 0.5rem 0.3rem;
  display: flex;
  justify-content: space-between;
  align-items: center;
  opacity: 0;
  transition: opacity 0.15s;
}

.photo-item:hover .photo-info,
.photo-item.selected .photo-info {
  opacity: 1;
}

.name {
  font-size: 0.7rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 60%;
}

.photo-actions {
  display: flex;
  gap: 2px;
}
</style>
