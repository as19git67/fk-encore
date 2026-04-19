<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue'
import Chip from 'primevue/chip'
import type { PhotoFilter, Album, Person } from '../api/photos'
import { listAlbums, listPersons } from '../api/photos'

/**
 * Compact summary of currently applied filters, rendered as removable chips.
 * Emits `remove` with the keys that should be cleared — grouped criteria
 * (e.g. qualityMin+qualityMax, albumIds+albumMode) are removed together.
 */

const props = defineProps<{
  filter: PhotoFilter
}>()

const emit = defineEmits<{
  (e: 'remove', keys: Array<keyof PhotoFilter>): void
}>()

const albums = ref<Album[]>([])
const persons = ref<Person[]>([])

async function loadReferences() {
  if (props.filter.albumIds?.length && albums.value.length === 0) {
    try { albums.value = (await listAlbums()).albums } catch { /* ignore */ }
  }
  if (props.filter.personIds?.length && persons.value.length === 0) {
    try { persons.value = (await listPersons()).persons } catch { /* ignore */ }
  }
}

onMounted(loadReferences)
watch(() => [props.filter.albumIds, props.filter.personIds], loadReferences, { deep: true })

interface ChipDef {
  label: string
  keys: Array<keyof PhotoFilter>
}

const chips = computed<ChipDef[]>(() => {
  const f = props.filter
  const out: ChipDef[] = []
  if (f.hiddenMode === 'include') out.push({ label: 'Inkl. Ausgeblendet', keys: ['hiddenMode'] })
  else if (f.hiddenMode === 'only') out.push({ label: 'Nur Ausgeblendet', keys: ['hiddenMode'] })
  if (f.favorite) out.push({ label: 'Favorit', keys: ['favorite'] })
  if (f.albumHighlight) out.push({ label: 'Album-Highlight', keys: ['albumHighlight'] })
  if (f.groupHighlight) out.push({ label: 'Gruppen-Highlight', keys: ['groupHighlight'] })
  if (f.inGroup) out.push({ label: 'In Gruppe', keys: ['inGroup'] })
  if (f.othersFavorited) out.push({ label: 'Von anderen favorisiert', keys: ['othersFavorited'] })
  if (f.othersHidden) out.push({ label: 'Von anderen ausgeblendet', keys: ['othersHidden'] })
  if (f.notInAnyAlbum) out.push({ label: 'Nicht in Album', keys: ['notInAnyAlbum'] })

  if (f.qualityMin !== undefined || f.qualityMax !== undefined) {
    const min = f.qualityMin ?? 0
    const max = f.qualityMax ?? 100
    out.push({ label: `Qualität ${min}–${max}%`, keys: ['qualityMin', 'qualityMax'] })
  }

  if (f.albumIds?.length) {
    const names = f.albumIds.map((id) => albums.value.find((a) => a.id === id)?.name ?? `#${id}`)
    const prefix = f.albumMode === 'exclude' ? 'Nicht in Album' : 'In Album'
    out.push({ label: `${prefix}: ${names.join(', ')}`, keys: ['albumIds', 'albumMode'] })
  }
  if (f.personIds?.length) {
    const names = f.personIds.map((id) => persons.value.find((p) => p.id === id)?.name ?? `#${id}`)
    const prefix = f.personMode === 'exclude' ? 'Ohne Person' : 'Mit Person'
    out.push({ label: `${prefix}: ${names.join(', ')}`, keys: ['personIds', 'personMode'] })
  }
  if (f.mediaTypes?.length) {
    const labels: Record<string, string> = { photo: 'Foto', video: 'Video', raw: 'RAW' }
    out.push({
      label: `Medientyp: ${f.mediaTypes.map((t) => labels[t] ?? t).join(', ')}`,
      keys: ['mediaTypes'],
    })
  }
  if (f.hasGps !== undefined) {
    out.push({ label: f.hasGps ? 'Mit GPS' : 'Ohne GPS', keys: ['hasGps'] })
  }
  if (f.hasFaces !== undefined) {
    out.push({ label: f.hasFaces ? 'Mit Gesichtern' : 'Ohne Gesichter', keys: ['hasFaces'] })
  }
  if (f.hasAssignedPerson !== undefined) {
    out.push({
      label: f.hasAssignedPerson ? 'Mit zugeordneter Person' : 'Ohne zugeordnete Person',
      keys: ['hasAssignedPerson'],
    })
  }
  if (f.dateFrom || f.dateTo) {
    const from = f.dateFrom ?? '…'
    const to = f.dateTo ?? '…'
    out.push({ label: `Datum ${from} – ${to}`, keys: ['dateFrom', 'dateTo'] })
  }
  if (f.importedDaysAgo !== undefined) {
    out.push({ label: `Letzte ${f.importedDaysAgo} Tage`, keys: ['importedDaysAgo'] })
  }
  if (f.sizeMin !== undefined || f.sizeMax !== undefined) {
    const min = f.sizeMin !== undefined ? `${Math.round(f.sizeMin / (1024 * 1024))} MB` : '…'
    const max = f.sizeMax !== undefined ? `${Math.round(f.sizeMax / (1024 * 1024))} MB` : '…'
    out.push({ label: `Größe ${min} – ${max}`, keys: ['sizeMin', 'sizeMax'] })
  }
  return out
})
</script>

<template>
  <div v-if="chips.length" class="filter-chips">
    <Chip
      v-for="c in chips"
      :key="c.keys.join(',')"
      :label="c.label"
      removable
      @remove="emit('remove', c.keys)"
    />
  </div>
</template>

<style scoped>
.filter-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
  padding: 0.4rem 0;
}
</style>
