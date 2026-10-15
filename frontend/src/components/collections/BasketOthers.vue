<script setup lang="ts">
/**
 * One line in a module's basket drawer: what else lies in the shared basket
 * (#1548), and the way to keep the whole pile as a collection.
 *
 * The transaction and document drawers show their own kind in detail; the
 * photo set aside in the gallery is in the same basket, so the drawer says so
 * instead of pretending the pile ends at its own type.
 */
import { computed, ref } from 'vue'
import Button from 'primevue/button'
import { describeCounts, type CollectionEntityType } from '../../api/collections'
import { useBasketStore } from '../../stores/basket'
import SaveBasketDialog from './SaveBasketDialog.vue'

const props = defineProps<{
  /** The drawer's own type, left out of the line. */
  own: CollectionEntityType
}>()

const emit = defineEmits<{ (e: 'saved', name: string): void }>()

const basket = useBasketStore()
const saveOpen = ref(false)
const others = computed(() => describeCounts(basket.counts, props.own))
</script>

<template>
  <div v-if="basket.count > 0" class="basket-others" data-testid="basket-others">
    <span v-if="others" class="basket-others-text">
      <i class="pi pi-shopping-cart" /> Außerdem im Basket: {{ others }}
    </span>
    <Button
      label="Ganzen Basket als Sammelmappe speichern"
      icon="pi pi-folder"
      size="small"
      text
      @click="saveOpen = true"
    />
    <SaveBasketDialog v-model:visible="saveOpen" @saved="(c) => emit('saved', c.name)" />
  </div>
</template>

<style scoped>
.basket-others {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  padding: var(--space-2) 0;
  margin-bottom: var(--space-2);
  border-bottom: 1px solid var(--p-content-border-color);
  font-size: var(--text-sm);
  color: var(--p-text-muted-color);
}
</style>
