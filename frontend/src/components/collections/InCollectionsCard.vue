<script setup lang="ts">
/**
 * "In Sammelmappen" on a detail page (#1548): which collections hold this
 * item, whether it is in the basket, and the two ways to change that.
 *
 * Documents have their own card with dossier details; every other type uses
 * this one, so a photo, a transaction and a meter answer the same question in
 * the same place.
 */
import { computed, onMounted, ref, watch } from 'vue'
import Button from 'primevue/button'
import Tag from 'primevue/tag'
import {
  collectionsOfItem,
  type CollectionEntityType,
  type CollectionSummary,
} from '../../api/collections'
import { useBasketStore } from '../../stores/basket'
import AddToCollectionDialog from './AddToCollectionDialog.vue'

const props = defineProps<{
  type: CollectionEntityType
  id: number
  /** Shown in the basket before the server has named it. */
  title?: string
  /** Leave out the basket button where the page already has one. */
  hideBasket?: boolean
}>()

const basket = useBasketStore()
const items = ref<Array<Pick<CollectionSummary, 'id' | 'name' | 'entity_type' | 'archived_at'>>>([])
const error = ref<string | null>(null)
const dialogOpen = ref(false)

const ref_ = computed(() => ({ entity_type: props.type, entity_id: props.id }))
const inBasket = computed(() => basket.has(ref_.value))

async function load() {
  error.value = null
  try {
    items.value = (await collectionsOfItem(ref_.value)).items
  } catch (err: unknown) {
    error.value = err instanceof Error ? err.message : 'Sammelmappen konnten nicht geladen werden.'
  }
}

function toggleBasket() {
  basket.toggle({ ...ref_.value, display: props.title ? { title: props.title } : undefined })
}

onMounted(() => {
  void basket.load()
  void load()
})
watch(() => [props.type, props.id], load)
</script>

<template>
  <section class="in-collections" data-testid="in-collections">
    <div class="in-collections-header">
      <h2 class="in-collections-title"><i class="pi pi-folder" /> Sammelmappen</h2>
      <div class="in-collections-actions">
        <Button
          v-if="!hideBasket"
          :icon="inBasket ? 'pi pi-check' : 'pi pi-shopping-cart'"
          :label="inBasket ? 'Im Basket' : 'In den Basket'"
          :outlined="!inBasket"
          size="small"
          :aria-pressed="inBasket"
          data-testid="in-collections-basket"
          @click="toggleBasket"
        />
        <Button
          icon="pi pi-plus"
          label="In Sammelmappe"
          size="small"
          text
          data-testid="in-collections-add"
          @click="dialogOpen = true"
        />
      </div>
    </div>
    <p v-if="error" class="in-collections-empty">{{ error }}</p>
    <div v-else-if="items.length > 0" class="in-collections-chips">
      <Tag
        v-for="c in items"
        :key="c.id"
        :value="c.name"
        :severity="c.archived_at ? 'secondary' : 'info'"
        :icon="c.archived_at ? 'pi pi-box' : undefined"
      />
    </div>
    <p v-else class="in-collections-empty">In keiner Sammelmappe.</p>
    <AddToCollectionDialog v-model:visible="dialogOpen" :members="[ref_]" @added="load" />
  </section>
</template>

<style scoped>
.in-collections {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.in-collections-header {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
}
.in-collections-title {
  margin: 0;
  font-size: var(--text-lg);
  font-weight: 600;
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.in-collections-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}
.in-collections-chips {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}
.in-collections-empty {
  margin: 0;
  color: var(--p-text-muted-color);
  font-size: var(--text-sm);
}
</style>
