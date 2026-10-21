<script setup lang="ts">
/**
 * A drafted letter on its proposal card (#1534): sender, recipient, subject
 * and text stay editable until "Ausführen", and the enclosures and
 * destinations can be ticked off. Gaps the assistant left as `[[…]]` are
 * named above the fields, each a jump to where it stands, and the fields
 * holding one are marked; the card does not send the letter while one is left.
 */
import { computed, nextTick } from 'vue'
import Button from 'primevue/button'
import Checkbox from 'primevue/checkbox'
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

type TextField = 'sender' | 'recipient' | 'subject' | 'body'
const FIELDS: TextField[] = ['sender', 'recipient', 'subject', 'body']

const hasGap = (field: TextField) => letterGaps(form.value[field]).length > 0

/** Puts the cursor on a gap with its brackets selected, so typing replaces it. */
async function focusGap(gap?: string) {
  const name = gap ?? gaps.value[0]
  if (!name) return
  const field = FIELDS.find((f) => letterGaps(form.value[f]).includes(name))
  if (!field) return
  await nextTick()
  const el = document.getElementById(id(field)) as HTMLInputElement | HTMLTextAreaElement | null
  if (!el) return
  const match = [...el.value.matchAll(/\[\[([^\]\n]{1,120})\]\]/g)].find((m) => m[1]?.trim() === name)
  el.focus()
  if (match?.index !== undefined) el.setSelectionRange(match.index, match.index + match[0].length)
  el.scrollIntoView?.({ block: 'center', behavior: 'smooth' })
}

defineExpose({ focusGap })
</script>

<template>
  <div class="letter">
    <div v-if="gaps.length" class="letter-gaps" role="status">
      <i class="pi pi-pencil" aria-hidden="true" />
      <span>Noch auszufüllen:</span>
      <Button
        v-for="g in gaps"
        :key="g"
        :label="g"
        size="small"
        severity="warn"
        text
        class="letter-gap"
        :aria-label="`Zur Lücke „${g}“`"
        @click="focusGap(g)"
      />
    </div>

    <div class="letter-row">
      <div class="letter-field">
        <label :for="id('sender')">Absender</label>
        <Textarea :id="id('sender')" v-model="form.sender" :invalid="hasGap('sender')" rows="3" auto-resize :disabled="disabled" />
      </div>
      <div class="letter-field">
        <label :for="id('recipient')">Empfänger</label>
        <Textarea :id="id('recipient')" v-model="form.recipient" :invalid="hasGap('recipient')" rows="3" auto-resize :disabled="disabled" />
      </div>
    </div>

    <div class="letter-field">
      <label :for="id('subject')">Betreff</label>
      <!-- One line in the letter, but wrapped here so a long subject (and a gap at its end) stays in view. -->
      <Textarea
        :id="id('subject')"
        v-model="form.subject"
        :invalid="hasGap('subject')"
        rows="1"
        auto-resize
        :disabled="disabled"
        @keydown.enter.prevent
      />
    </div>

    <div class="letter-field">
      <label :for="id('body')">Text</label>
      <Textarea :id="id('body')" v-model="form.body" :invalid="hasGap('body')" rows="10" auto-resize :disabled="disabled" />
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
  flex-wrap: wrap;
  gap: var(--space-1);
  margin: 0;
  font-size: var(--text-sm);
  color: var(--p-orange-600);
}

.letter-gap {
  padding-block: 0;
  text-decoration: underline;
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
