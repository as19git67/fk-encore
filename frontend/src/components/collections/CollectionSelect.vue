<script setup lang="ts">
/**
 * Pick a collection to limit a list to (#1548, stage 3). Offers only the
 * collections that hold something of the list's type, starred ones first.
 */
import { computed, ref } from 'vue'
import Select from 'primevue/select'
import { listAllCollections, type CollectionEntityType, type CollectionSummary } from '../../api/collections'
import { rememberCollectionName } from '../../composables/useCollectionNames'

const props = defineProps<{
  /** The list's type: only collections holding it are offered. */
  type: CollectionEntityType
  modelValue: number | null | undefined
  inputId?: string
}>()
const emit = defineEmits<{ (e: 'update:modelValue', value: number | null): void }>()

const options = ref<CollectionSummary[]>([])
const loaded = ref(false)

async function load() {
  if (loaded.value) return
  try {
    const res = await listAllCollections({ holds: props.type, sort: 'name', dir: 'asc' })
    options.value = [...res.items.filter((c) => c.favourite), ...res.items.filter((c) => !c.favourite)]
    for (const c of res.items) rememberCollectionName(c.id, c.name)
  } finally {
    loaded.value = true
  }
}
void load()

const value = computed({
  get: () => props.modelValue ?? null,
  set: (v: number | null) => emit('update:modelValue', v),
})
</script>

<template>
  <Select
    v-model="value"
    :options="options"
    option-label="name"
    option-value="id"
    :loading="!loaded"
    show-clear
    filter
    :input-id="inputId"
    placeholder="Alle"
    empty-message="Keine Sammelmappe mit solchen Einträgen"
    aria-label="Sammelmappe"
    class="collection-select"
  />
</template>

<style scoped>
.collection-select {
  width: 100%;
}
</style>
