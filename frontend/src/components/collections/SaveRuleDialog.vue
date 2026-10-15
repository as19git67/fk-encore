<script setup lang="ts">
/**
 * "Als Regel-Sammelmappe speichern" (#1548, stage 5): the filter a list
 * shows right now becomes a collection whose members join by themselves.
 * The new folder is filled at once and kept current every hour.
 */
import { ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import Button from 'primevue/button'
import Dialog from 'primevue/dialog'
import InputText from 'primevue/inputtext'
import Message from 'primevue/message'
import { ENTITY_LABELS, createRuleCollection, type CollectionDetail, type MemberRuleInput } from '../../api/collections'
import { collectionRoute } from '../../utils/collectionRoute'

const props = defineProps<{
  visible: boolean
  rule: MemberRuleInput | null
  /** What the filter is, in words, for the lead line. */
  summary?: string
}>()
const emit = defineEmits<{ (e: 'update:visible', value: boolean): void }>()

const router = useRouter()
const name = ref('')
const saving = ref(false)
const error = ref('')
const created = ref<CollectionDetail | null>(null)

watch(
  () => props.visible,
  (visible) => {
    if (!visible) return
    name.value = ''
    error.value = ''
    created.value = null
  },
)

async function save() {
  const trimmed = name.value.trim()
  if (!trimmed || !props.rule || saving.value) return
  saving.value = true
  error.value = ''
  try {
    created.value = (await createRuleCollection({ name: trimmed, rule: props.rule })).collection
  } catch (err: unknown) {
    error.value = err instanceof Error ? err.message : 'Speichern fehlgeschlagen.'
  } finally {
    saving.value = false
  }
}

function open() {
  if (!created.value) return
  emit('update:visible', false)
  void router.push(collectionRoute(created.value))
}
</script>

<template>
  <Dialog
    class="dialog-sm"
    :visible="visible"
    modal
    header="Als Regel-Sammelmappe speichern"
    @update:visible="emit('update:visible', $event)"
  >
    <template v-if="!created">
      <p class="srd-lead">
        Was zum aktuellen Filter passt, landet in der Mappe – auch was später dazukommt.
        <span v-if="summary" class="srd-summary">{{ summary }}</span>
      </p>
      <Message v-if="error" severity="error" :closable="false">{{ error }}</Message>
      <label class="srd-field">
        <span>Name</span>
        <InputText v-model="name" autofocus data-testid="save-rule-name" @keyup.enter="save" />
      </label>
    </template>
    <Message v-else severity="success" :closable="false">
      „{{ created.name }}“ angelegt mit {{ created.total }}
      {{ created.total === 1 ? ENTITY_LABELS[created.entity_type ?? 'photo'].singular : ENTITY_LABELS[created.entity_type ?? 'photo'].plural }}.
    </Message>
    <template #footer>
      <template v-if="!created">
        <Button label="Abbrechen" severity="secondary" text @click="emit('update:visible', false)" />
        <Button label="Speichern" icon="pi pi-folder" :disabled="!name.trim()" :loading="saving" @click="save" />
      </template>
      <template v-else>
        <Button label="Schließen" severity="secondary" text @click="emit('update:visible', false)" />
        <Button label="Mappe öffnen" icon="pi pi-folder-open" @click="open" />
      </template>
    </template>
  </Dialog>
</template>

<style scoped>
.srd-lead {
  margin: 0 0 var(--space-3);
  color: var(--p-text-muted-color);
}
.srd-summary {
  display: block;
  margin-top: var(--space-1);
  color: var(--p-text-color);
}
.srd-field {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}
</style>
