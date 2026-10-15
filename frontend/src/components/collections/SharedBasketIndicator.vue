<script setup lang="ts">
/**
 * The basket for modules without batch actions of their own (#1548): photos,
 * meters and the rest. Documents and finance show the same list and footer,
 * with their batch actions for their own kind above the footer.
 */
import { ref } from 'vue'
import BasketIndicator from '../BasketIndicator.vue'
import BasketMemberList from './BasketMemberList.vue'
import BasketFooter from './BasketFooter.vue'
import { useBasketStore } from '../../stores/basket'

const basket = useBasketStore()
// App.vue loads it on sign-in; asking again is free and keeps this usable alone.
void basket.load()
const shell = ref<InstanceType<typeof BasketIndicator> | null>(null)
const info = ref<string | null>(null)
const error = ref<string | null>(null)
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
      <BasketFooter @saved="(name) => (info = `Sammelmappe „${name}“ angelegt.`)" />
    </template>
  </BasketIndicator>
</template>
