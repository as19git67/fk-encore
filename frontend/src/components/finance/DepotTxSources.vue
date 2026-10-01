<script setup lang="ts">
import { computed } from 'vue'

/**
 * Where a depot transaction came from (issue #1336, stage 4): the giro
 * booking that moved the money and the settlement document(s) its figures
 * were read from — each as a link — or, for a row with neither, how it was
 * entered.
 */
const props = defineProps<{
  source: string
  linkedTransactionId: number | null
  documentIds: number[]
}>()

const fallbackLabel = computed(() => {
  const base = props.source.replace(/\+document$/, '')
  switch (base) {
    case 'manual': return 'manuell'
    case 'giro-derived': return 'Girobuchung'
    case 'document': return 'Beleg'
    case 'fints-mt536': return 'FinTS'
    case 'csv-import': return 'CSV-Import'
    default: return base
  }
})

const hasLinks = computed(() => props.linkedTransactionId !== null || props.documentIds.length > 0)
</script>

<template>
  <span class="depot-tx-sources">
    <RouterLink
      v-if="linkedTransactionId !== null"
      :to="{ name: 'finance-transaction-detail', params: { id: linkedTransactionId } }"
      class="depot-tx-link"
    >Girobuchung</RouterLink>
    <RouterLink
      v-for="(id, i) in documentIds"
      :key="id"
      :to="{ name: 'dokumente-detail', params: { id } }"
      class="depot-tx-link"
    >
      <i class="pi pi-file" aria-hidden="true" />
      Beleg<template v-if="documentIds.length > 1"> {{ i + 1 }}</template>
    </RouterLink>
    <template v-if="!hasLinks">{{ fallbackLabel }}</template>
  </span>
</template>

<style scoped>
.depot-tx-sources {
  display: inline-flex;
  flex-wrap: wrap;
  gap: 0.15rem 0.6rem;
}
.depot-tx-link {
  color: var(--p-primary-color);
  white-space: nowrap;
}
.depot-tx-link .pi {
  font-size: 0.85em;
}
</style>
