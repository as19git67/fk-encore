<script setup lang="ts">
/**
 * A drafted letter on its proposal card (#1534): sender, recipient, subject
 * and text stay editable until "Ausführen", and the enclosures and
 * destinations can be ticked off. Gaps the assistant left as `[[…]]` are
 * named above the fields, each a jump to where it stands, and the fields
 * holding one are marked; the card does not send the letter while one is left.
 * Further documents can be searched and enclosed; the server checks on
 * "Ausführen" that the user may see them.
 */
import { computed, nextTick, ref } from 'vue'
import AutoComplete, { type AutoCompleteOptionSelectEvent } from 'primevue/autocomplete'
import Button from 'primevue/button'
import Checkbox from 'primevue/checkbox'
import Textarea from 'primevue/textarea'
import type { LetterDestination, LetterDraft } from '../../api/assistant'
import { searchDocuments } from '../../api/documents'
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

type Enclosure = { id: number; title: string }

/** Documents the user enclosed on the card, beside the ones the assistant proposed. */
const added = ref<Enclosure[]>([])
const enclosures = computed<Enclosure[]>(() => [...props.letter.attachments, ...added.value])
const enclosed = computed(() => form.value.attachmentIds.length > 0)

const DESTINATIONS = computed<{ value: LetterDestination; label: string }[]>(() => [
  { value: 'document', label: enclosed.value ? 'Als Dokument ablegen (verknüpft mit den Anlagen)' : 'Als Dokument ablegen' },
  { value: 'collection', label: enclosed.value ? 'Mit den Anlagen in eine Sammelmappe' : 'In eine Sammelmappe' },
])

const query = ref('')
const suggestions = ref<Enclosure[]>([])

async function searchEnclosures(event: { query: string }) {
  const q = event.query.trim()
  if (!q) {
    suggestions.value = []
    return
  }
  try {
    const { items } = await searchDocuments(q, 'hybrid', 10)
    const taken = new Set(enclosures.value.map((e) => e.id))
    suggestions.value = items
      .filter((d) => !taken.has(d.id))
      .map((d) => ({ id: d.id, title: d.title || d.original_filename }))
  } catch {
    suggestions.value = []
  }
}

function enclose(event: AutoCompleteOptionSelectEvent) {
  const doc = event.value as Enclosure
  if (!enclosures.value.some((e) => e.id === doc.id)) added.value.push(doc)
  if (!form.value.attachmentIds.includes(doc.id)) form.value.attachmentIds = [...form.value.attachmentIds, doc.id]
  query.value = ''
}

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

    <fieldset class="letter-choices">
      <legend>Anlagen</legend>
      <div v-for="a in enclosures" :key="a.id" class="letter-choice">
        <Checkbox v-model="form.attachmentIds" :input-id="id(`att-${a.id}`)" :value="a.id" :disabled="disabled" />
        <label :for="id(`att-${a.id}`)">{{ a.title }}</label>
      </div>
      <p v-if="!enclosures.length" class="letter-none">Keine Anlagen.</p>
      <AutoComplete
        v-model="query"
        :suggestions="suggestions"
        option-label="title"
        :input-id="id('add-attachment')"
        placeholder="Dokument als Anlage hinzufügen …"
        aria-label="Dokument als Anlage hinzufügen"
        :delay="300"
        :disabled="disabled"
        fluid
        @complete="searchEnclosures"
        @option-select="enclose"
      />
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

.letter-none {
  margin: 0;
  font-size: var(--text-sm);
  color: var(--p-text-muted-color);
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
