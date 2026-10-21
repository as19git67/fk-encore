<script setup lang="ts">
/**
 * "Assistent schreiben lassen" in the text-document editor: the user says
 * what to write, the assistant writes it (with the user's data where the
 * instruction asks for it), and the text goes into the editor — at the
 * cursor or in place of everything. Nothing is filed before the user saves.
 */
import { computed, ref, watch } from 'vue'
import Button from 'primevue/button'
import Checkbox from 'primevue/checkbox'
import Dialog from 'primevue/dialog'
import Message from 'primevue/message'
import Textarea from 'primevue/textarea'
import MarkdownView from './MarkdownView.vue'
import { composeText } from '../../api/assistant'
import type { InsertPlace } from '../../utils/markdown'

const visible = defineModel<boolean>('visible', { required: true })
const props = defineProps<{ title: string; currentText: string }>()
const emit = defineEmits<{ insert: [text: string, where: InsertPlace] }>()

const instruction = ref('')
const useCurrent = ref(true)
const result = ref('')
const busy = ref(false)
const error = ref('')

const hasText = computed(() => props.currentText.trim().length > 0)
const canAsk = computed(() => instruction.value.trim().length > 0 && !busy.value)

watch(visible, (open) => {
  if (!open) return
  result.value = ''
  error.value = ''
  useCurrent.value = true
})

async function ask() {
  if (!canAsk.value) return
  busy.value = true
  error.value = ''
  try {
    const res = await composeText({
      instruction: instruction.value.trim(),
      title: props.title.trim() || undefined,
      text: hasText.value && useCurrent.value ? props.currentText : undefined,
    })
    result.value = res.markdown
  } catch (err) {
    error.value = (err as Error).message || 'Der Assistent konnte nichts schreiben.'
  } finally {
    busy.value = false
  }
}

function insert(where: InsertPlace) {
  emit('insert', result.value, where)
  instruction.value = ''
  visible.value = false
}

function onKeydown(ev: KeyboardEvent) {
  if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) {
    ev.preventDefault()
    void ask()
  }
}
</script>

<template>
  <Dialog
    v-model:visible="visible"
    modal
    header="Assistent schreiben lassen"
    class="dialog-md"
  >
    <div class="compose">
      <label class="compose__field">
        <span>Was soll der Assistent schreiben?</span>
        <Textarea
          v-model="instruction"
          rows="3"
          auto-resize
          fluid
          placeholder="z. B. Eine kurze Einladung zum Sommerfest am Samstag um 15 Uhr, mit Bitte um Rückmeldung"
          :disabled="busy"
          @keydown="onKeydown"
        />
      </label>
      <label v-if="hasText" class="compose__check">
        <Checkbox v-model="useCurrent" binary :disabled="busy" />
        <span>Bisherigen Text berücksichtigen (z. B. zum Fortsetzen oder Überarbeiten)</span>
      </label>
      <p class="compose__hint">
        Fragt die Vorgabe nach deinen Daten (Buchungen, Dokumente, Zähler …), schlägt der Assistent sie nach.
      </p>

      <Message v-if="error" severity="error" :closable="false">{{ error }}</Message>

      <section v-if="result" class="compose__result" aria-label="Vorschlag des Assistenten" tabindex="0">
        <MarkdownView :source="result" />
      </section>
    </div>

    <template #footer>
      <Button label="Abbrechen" severity="secondary" text @click="visible = false" />
      <div class="compose__spacer" />
      <template v-if="result">
        <Button label="Neu schreiben" icon="pi pi-refresh" severity="secondary" text :loading="busy" @click="ask" />
        <Button v-if="hasText" label="Alles ersetzen" severity="secondary" outlined :disabled="busy" @click="insert('replace')" />
        <Button label="Einfügen" icon="pi pi-check" :disabled="busy" @click="insert(hasText ? 'cursor' : 'replace')" />
      </template>
      <Button v-else label="Schreiben lassen" icon="pi pi-sparkles" :loading="busy" :disabled="!canAsk" @click="ask" />
    </template>
  </Dialog>
</template>

<style scoped>
.compose {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}
.compose__field {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  font-weight: 600;
}
.compose__check {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.compose__hint {
  margin: 0;
  font-size: var(--text-sm);
  color: var(--p-text-muted-color);
}
.compose__result {
  max-height: 22rem;
  overflow-y: auto;
  padding: var(--space-3);
  border: 1px solid var(--p-content-border-color);
  border-radius: 8px;
  outline-offset: var(--focus-ring-offset-inset);
}
.compose__result:focus-visible {
  outline: var(--focus-ring);
}
.compose__spacer {
  flex: 1 1 auto;
}
</style>
