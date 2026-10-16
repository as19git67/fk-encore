<script setup lang="ts">
/**
 * A drafted letter on its proposal card (#1534): sender, recipient, subject
 * and text stay editable until "Ausführen", and the enclosures and
 * destinations can be ticked off. Gaps the assistant left as `[[…]]` are
 * named above the fields; the card does not send the letter while one is left.
 */
import { computed } from 'vue'
import Checkbox from 'primevue/checkbox'
import InputText from 'primevue/inputtext'
import Textarea from 'primevue/textarea'
import type { LetterDestination, LetterDraft } from '../../api/assistant'
import { letterGaps } from '../../utils/letterGaps'

export interface LetterForm {
  sender: string
  recipient: string
  subject: string
  body: string
  destinations: LetterDestination[]
  attachmentIds: number[]
}

const props = defineProps<{ letter: LetterDraft; disabled?: boolean; idPrefix: string }>()
const form = defineModel<LetterForm>({ required: true })

const gaps = computed(() => letterGaps(form.value.sender, form.value.recipient, form.value.subject, form.value.body))

const DESTINATIONS: { value: LetterDestination; label: string }[] = [
  { value: 'document', label: 'Als Dokument ablegen (verknüpft mit den Anlagen)' },
  { value: 'collection', label: 'Mit den Anlagen in eine Sammelmappe' },
]

const id = (name: string) => `${props.idPrefix}-${name}`
</script>

<template>
  <div class="letter">
    <p v-if="gaps.length" class="letter-gaps" role="status">
      <i class="pi pi-pencil" aria-hidden="true" />
      <span>Noch auszufüllen: {{ gaps.join(', ') }}</span>
    </p>

    <div class="letter-row">
      <div class="letter-field">
        <label :for="id('sender')">Absender</label>
        <Textarea :id="id('sender')" v-model="form.sender" rows="3" auto-resize :disabled="disabled" />
      </div>
      <div class="letter-field">
        <label :for="id('recipient')">Empfänger</label>
        <Textarea :id="id('recipient')" v-model="form.recipient" rows="3" auto-resize :disabled="disabled" />
      </div>
    </div>

    <div class="letter-field">
      <label :for="id('subject')">Betreff</label>
      <InputText :id="id('subject')" v-model="form.subject" :disabled="disabled" />
    </div>

    <div class="letter-field">
      <label :for="id('body')">Text</label>
      <Textarea :id="id('body')" v-model="form.body" rows="10" auto-resize :disabled="disabled" />
    </div>

    <fieldset v-if="letter.attachments.length" class="letter-choices">
      <legend>Anlagen</legend>
      <div v-for="a in letter.attachments" :key="a.id" class="letter-choice">
        <Checkbox v-model="form.attachmentIds" :input-id="id(`att-${a.id}`)" :value="a.id" :disabled="disabled" />
        <label :for="id(`att-${a.id}`)">{{ a.title }}</label>
      </div>
    </fieldset>

    <fieldset class="letter-choices">
      <legend>Außer zum Herunterladen</legend>
      <div v-for="d in DESTINATIONS" :key="d.value" class="letter-choice">
        <Checkbox v-model="form.destinations" :input-id="id(`dest-${d.value}`)" :value="d.value" :disabled="disabled" />
        <label :for="id(`dest-${d.value}`)">{{ d.label }}</label>
      </div>
    </fieldset>
  </div>
</template>

<style scoped>
.letter {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.letter-row {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr));
  gap: var(--space-3);
}

.letter-field {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  min-width: 0;
}

.letter-field label,
.letter-choices legend {
  font-size: var(--text-sm);
  color: var(--p-text-muted-color);
}

.letter-gaps {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  margin: 0;
  font-size: var(--text-sm);
  color: var(--p-orange-600);
}

.letter-choices {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  margin: 0;
  padding: 0;
  border: 0;
  min-width: 0;
}

.letter-choices legend {
  padding: 0;
  margin-bottom: var(--space-1);
}

.letter-choice {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--text-sm);
}
</style>
