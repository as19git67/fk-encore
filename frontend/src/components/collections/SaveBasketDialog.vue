<script setup lang="ts">
/**
 * "Als Sammelmappe speichern" — gives the basket a name (#1548).
 *
 * The new collection holds what the basket holds (or one type of it); a
 * basket of one type becomes a collection typed for it. The basket is emptied
 * afterwards unless the user keeps it, because the usual reason to name a
 * pile is that the work on it is done.
 */
import { computed, ref, watch } from 'vue'
import Button from 'primevue/button'
import Checkbox from 'primevue/checkbox'
import Dialog from 'primevue/dialog'
import InputText from 'primevue/inputtext'
import Message from 'primevue/message'
import { describeCounts, type CollectionDetail, type CollectionEntityType } from '../../api/collections'
import { useBasketStore } from '../../stores/basket'

const props = defineProps<{
  visible: boolean
  /** Save only this type of the basket; absent saves everything. */
  type?: CollectionEntityType
}>()

const emit = defineEmits<{
  (e: 'update:visible', value: boolean): void
  (e: 'saved', collection: CollectionDetail): void
}>()

const basket = useBasketStore()
const name = ref('')
const keep = ref(false)
const saving = ref(false)
const error = ref<string | null>(null)

const what = computed(() => {
  const counts = props.type ? { [props.type]: basket.countOf(props.type) } : basket.counts
  return describeCounts(counts)
})

watch(
  () => props.visible,
  (visible) => {
    if (!visible) return
    name.value = ''
    keep.value = false
    error.value = null
  },
)

async function save() {
  const trimmed = name.value.trim()
  if (!trimmed || saving.value) return
  saving.value = true
  error.value = null
  try {
    const created = await basket.saveAs({ name: trimmed, keep: keep.value, type: props.type })
    emit('saved', created)
    emit('update:visible', false)
  } catch (err: unknown) {
    error.value = err instanceof Error ? err.message : 'Speichern fehlgeschlagen.'
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <Dialog
    class="dialog-sm"
    :visible="visible"
    modal
    header="Als Sammelmappe speichern"
    @update:visible="emit('update:visible', $event)"
  >
    <p class="sbd-lead">{{ what }} kommen in eine neue Sammelmappe.</p>
    <Message v-if="error" severity="error" :closable="false">{{ error }}</Message>
    <label class="sbd-field">
      <span>Name</span>
      <InputText
        v-model="name"
        autofocus
        placeholder="z. B. Nebenkosten 2026"
        data-testid="save-basket-name"
        @keyup.enter="save"
      />
    </label>
    <label class="sbd-keep">
      <Checkbox v-model="keep" binary />
      <span>Basket danach nicht leeren</span>
    </label>
    <template #footer>
      <Button label="Abbrechen" severity="secondary" text @click="emit('update:visible', false)" />
      <Button
        label="Speichern"
        icon="pi pi-folder"
        :disabled="!name.trim()"
        :loading="saving"
        data-testid="save-basket-submit"
        @click="save"
      />
    </template>
  </Dialog>
</template>

<style scoped>
.sbd-lead {
  margin: 0 0 var(--space-3);
  color: var(--p-text-muted-color);
}
.sbd-field {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  margin-bottom: var(--space-3);
}
.sbd-keep {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--text-sm);
}
</style>
