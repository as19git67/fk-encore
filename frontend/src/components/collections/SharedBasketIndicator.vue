<script setup lang="ts">
/**
 * The basket for modules without batch actions of their own (#1548): photos,
 * meters and the rest. Documents and finance show the same list and footer,
 * with their batch actions for their own kind above the footer. The one thing
 * photos do with the whole basket is a photo book (fotobuch.md, stage 5).
 */
import { computed, ref } from 'vue'
import Button from 'primevue/button'
import BasketIndicator from '../BasketIndicator.vue'
import BasketMemberList from './BasketMemberList.vue'
import BasketFooter from './BasketFooter.vue'
import PhotoBookCreateDialog from '../photobook/PhotoBookCreateDialog.vue'
import { useBasketStore } from '../../stores/basket'

const basket = useBasketStore()
// App.vue loads it on sign-in; asking again is free and keeps this usable alone.
void basket.load()
const shell = ref<InstanceType<typeof BasketIndicator> | null>(null)
const info = ref<string | null>(null)
const error = ref<string | null>(null)
const bookOpen = ref(false)
const hasPhotos = computed(() => basket.countOf('photo') + basket.countOf('album') > 0)

async function openBook() {
  // Pending writes first, so the book holds what the drawer shows.
  await basket.flush()
  await basket.load()
  shell.value?.close()
  bookOpen.value = true
}
</script>

<template>
  <BasketIndicator
    ref="shell"
    :count="basket.count"
    singular="Eintrag"
    plural="Einträge"
    empty-hint="Fotos, Alben, Dokumente, Buchungen, Wertpapiere und Zähler lassen sich aus jeder Liste und Detailseite über „Ablegen“ in den Basket legen."
    v-model:info="info"
    v-model:error="error"
  >
    <template #rows>
      <BasketMemberList @open="shell?.close()" />
    </template>
    <template #footer>
      <div v-if="hasPhotos" class="shared-basket-actions">
        <Button label="Fotobuch gestalten" icon="pi pi-print" size="small" text @click="openBook" />
      </div>
      <BasketFooter @saved="(name) => (info = `Sammelmappe „${name}“ angelegt.`)" />
    </template>
  </BasketIndicator>
  <PhotoBookCreateDialog
    v-if="basket.id != null"
    v-model:visible="bookOpen"
    :collection-id="basket.id"
    source-label="Aus den Fotos und Alben im Basket, so wie er jetzt ist."
  />
</template>

<style scoped>
.shared-basket-actions {
  display: flex;
  justify-content: flex-end;
  margin-bottom: var(--space-2);
}
</style>
