<script setup lang="ts">
/**
 * One Sammelmappe as a tile — the same in every list that shows folders
 * (the Sammelmappen page, the document list, Dokumente › Sammelmappen):
 * type icon, name, what is in it, tags, and the star and "⋮" in the corner.
 * The row is the list's anchor for the way back (`data-anchor`), so it lands
 * on the folder it was opened from.
 */
import Button from 'primevue/button'
import Tag from 'primevue/tag'
import { describeCounts, type CollectionSummary } from '../../api/collections'
import { anchorKey } from '../../utils/listAnchor'
import { collectionTypeIcon, collectionTypeLabel } from './collectionLabels'

defineProps<{ collection: CollectionSummary }>()
const emit = defineEmits<{
  open: [collection: CollectionSummary]
  'toggle-favourite': [collection: CollectionSummary]
  menu: [event: Event, collection: CollectionSummary]
}>()
</script>

<template>
  <li class="collection-tile scroll-anchor" :data-anchor="anchorKey('collection', collection.id)">
    <button
      type="button"
      class="collection-tile-body"
      :aria-label="`Öffnen: ${collection.name}`"
      @click="emit('open', collection)"
    >
      <span class="collection-tile-icon"><i :class="collectionTypeIcon(collection)" aria-hidden="true" /></span>
      <span class="collection-tile-name">{{ collection.name }}</span>
      <span class="collection-tile-meta">{{ describeCounts(collection.counts) || 'leer' }}</span>
      <span class="collection-tile-tags">
        <Tag :value="collectionTypeLabel(collection)" severity="secondary" />
        <Tag v-if="collection.kind === 'rule'" value="Regel" icon="pi pi-bolt" severity="info" />
        <Tag v-if="collection.visibility === 'group'" value="Gruppe" icon="pi pi-users" severity="info" />
        <Tag v-if="collection.created_by === 'assistant'" value="Assistent" icon="pi pi-sparkles" severity="info" />
        <Tag v-if="collection.archived_at" value="Archiviert" icon="pi pi-box" severity="secondary" />
      </span>
    </button>
    <div class="collection-tile-actions">
      <Button
        :icon="collection.favourite ? 'pi pi-star-fill' : 'pi pi-star'"
        text
        rounded
        size="small"
        :severity="collection.favourite ? 'warn' : 'secondary'"
        :aria-label="collection.favourite ? `Favorit entfernen: ${collection.name}` : `Als Favorit markieren: ${collection.name}`"
        :aria-pressed="collection.favourite"
        @click="emit('toggle-favourite', collection)"
      />
      <Button
        icon="pi pi-ellipsis-v"
        text
        rounded
        size="small"
        severity="secondary"
        :aria-label="`Weitere Aktionen: ${collection.name}`"
        aria-haspopup="true"
        @click="emit('menu', $event, collection)"
      />
    </div>
  </li>
</template>

<style scoped>
.collection-tile {
  position: relative;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--p-content-border-color);
  border-radius: 10px;
  background: var(--p-content-background);
}
.collection-tile-body {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--space-1);
  padding: var(--space-3);
  padding-right: calc(var(--space-3) + 4.5rem);
  border: none;
  border-radius: 10px;
  background: transparent;
  color: var(--p-text-color);
  text-align: left;
  font: inherit;
  cursor: pointer;
  min-width: 0;
}
.collection-tile-body:hover {
  background: var(--p-content-hover-background);
}
.collection-tile-body:focus-visible {
  outline: var(--focus-ring);
  outline-offset: var(--focus-ring-offset);
}
.collection-tile-icon {
  color: var(--p-primary-color);
  font-size: var(--text-xl);
}
.collection-tile-name {
  font-weight: 600;
  overflow-wrap: anywhere;
}
.collection-tile-meta {
  color: var(--p-text-muted-color);
  font-size: var(--text-sm);
}
.collection-tile-tags {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1);
  margin-top: var(--space-1);
}
.collection-tile-actions {
  position: absolute;
  top: var(--space-2);
  right: var(--space-2);
  display: flex;
}
</style>
