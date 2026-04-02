<script setup lang="ts">
import type { YearGroup } from '../composables/usePhotoGrouping'

const props = defineProps<{
  groupedPhotos: YearGroup[]
  activeSection: string
}>()

const emit = defineEmits<{
  'scroll-to': [sectionId: string]
  'navigate-up': []
  'navigate-down': []
}>()

// Flat list of all section IDs in display order (for keyboard nav)
function allSectionIds(): string[] {
  const ids: string[] = []
  for (const yearGroup of props.groupedPhotos) {
    ids.push(yearGroup.sectionId)
    for (const monthGroup of yearGroup.months) {
      if (monthGroup.month) ids.push(monthGroup.sectionId)
    }
  }
  return ids
}

function navigateUp() {
  const ids = allSectionIds()
  const current = ids.indexOf(props.activeSection)
  if (current > 0) emit('scroll-to', ids[current - 1]!)
}

function navigateDown() {
  const ids = allSectionIds()
  const current = ids.indexOf(props.activeSection)
  if (current < ids.length - 1) emit('scroll-to', ids[current + 1]!)
}

defineExpose({ navigateUp, navigateDown })
</script>

<template>
  <nav class="timeline-nav">
    <div
      v-for="yearGroup in groupedPhotos"
      :key="'nav-' + yearGroup.year"
      class="nav-year-group"
    >
      <a
        class="nav-year"
        :class="{ active: activeSection === yearGroup.sectionId }"
        @click.prevent="emit('scroll-to', yearGroup.sectionId)"
      >
        {{ yearGroup.year }}
      </a>
      <div class="nav-months">
        <a
          v-for="monthGroup in yearGroup.months"
          :key="'nav-' + yearGroup.year + monthGroup.month"
          class="nav-month"
          :class="{ active: activeSection === monthGroup.sectionId }"
          @click.prevent="emit('scroll-to', monthGroup.sectionId)"
        >
          {{ monthGroup.month.substring(0, 3) }}
        </a>
      </div>
    </div>
  </nav>
</template>

<style scoped>
.timeline-nav {
  width: 80px;
  flex-shrink: 0;
  overflow-y: auto;
  padding: 1rem 0.5rem;
  background: var(--surface-card);
  border-right: 1px solid var(--surface-border);
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
}

.nav-year-group {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.5rem;
}

.nav-year {
  font-weight: bold;
  font-size: 0.9rem;
  color: var(--p-primary-color);
  cursor: pointer;
  text-decoration: none;
  padding: 0.2rem 0.4rem;
  border-radius: 4px;
  transition: background 0.2s;
}

.nav-year:hover { background: var(--p-primary-50); }
.nav-year.active { background: var(--p-primary-color); color: white; }

.nav-months {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  align-items: center;
}

.nav-month {
  font-size: 0.75rem;
  color: var(--text-color-secondary);
  cursor: pointer;
  text-decoration: none;
  padding: 0.1rem 0.3rem;
  border-radius: 3px;
  transition: color 0.2s;
}

.nav-month:hover { color: var(--p-primary-color); }

.nav-month.active {
  color: var(--p-primary-color);
  font-weight: bold;
  background: var(--p-primary-50);
}
</style>
