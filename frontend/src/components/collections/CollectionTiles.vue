<script setup lang="ts">
/**
 * A grid of Sammelmappen with their actions — what the document list and
 * Dokumente › Sammelmappen show, built from the same tile and menu as the
 * Sammelmappen page. The list owns the data and the way into a folder
 * (`open`, which also saves the list anchor); after a change from the menu it
 * gets `changed` and reloads.
 */
import { ref } from 'vue'
import type { CollectionSummary } from '../../api/collections'
import CollectionTile from './CollectionTile.vue'
import CollectionActions from './CollectionActions.vue'

defineProps<{ items: CollectionSummary[] }>()
const emit = defineEmits<{
  open: [collection: CollectionSummary]
  changed: []
  error: [message: string]
  notice: [message: string]
}>()

const actions = ref<InstanceType<typeof CollectionActions> | null>(null)
</script>

<template>
  <ul class="collection-tiles">
    <CollectionTile
      v-for="c in items"
      :key="c.id"
      :collection="c"
      @open="emit('open', $event)"
      @toggle-favourite="actions?.toggleFavourite($event)"
      @menu="(event, collection) => actions?.openMenu(event, collection)"
    />
  </ul>
  <CollectionActions
    ref="actions"
    @changed="emit('changed')"
    @error="emit('error', $event)"
    @notice="emit('notice', $event)"
  />
</template>

<style scoped>
.collection-tiles {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 240px), 1fr));
  gap: var(--space-3);
}
</style>
