<script setup lang="ts">
/**
 * Tags-für-N-Buchungen — tristate editor for a set of transactions,
 * served as a modal dialog. Replaces the previous route-based
 * BatchTagView so the user stays in the calling list view (preserving
 * scroll position, filters, etc.).
 *
 * The source of the working set is either:
 *   • the basket store (default, when no `transactions` prop is given) —
 *     used by the basket drawer; mutations are mirrored back so the
 *     basket reflects the new tristate immediately.
 *   • an explicit `transactions` prop — used by list views that keep
 *     their own local selection and don't want the basket touched.
 *
 * Per-tag state:
 *   • checked   — every selected transaction has the tag
 *   • tristate  — some have it, others don't
 *   • unchecked — none have it
 *
 * Save sends only the diff against the initial state:
 *   • unchecked → checked   ⇒ add
 *   • checked   → unchecked ⇒ remove
 *   • tristate  → checked   ⇒ add (the missing ones get it)
 *   • tristate  → unchecked ⇒ remove (the ones with it lose it)
 *   • tristate  → tristate  ⇒ no-op (filtered out of dirtyRows)
 *
 * The server runs the whole batch inside one DB transaction.
 */

import { computed, ref, watch } from 'vue'
import Dialog from 'primevue/dialog'
import Button from 'primevue/button'
import InputText from 'primevue/inputtext'
import Checkbox from 'primevue/checkbox'
import Message from 'primevue/message'
import { useTagsStore } from '../../stores/finance/tags'
import { useTxSelectionStore } from '../../stores/finance/selection'
import { useTransactionsStore } from '../../stores/finance/transactions'
import type { Transaction } from '../../api/finance'

const props = defineProps<{
  visible: boolean
  /** Optional explicit working set; when omitted the basket store
   *  provides it (drawer usage). */
  transactions?: Transaction[]
}>()
const emit = defineEmits<{
  'update:visible': [value: boolean]
  applied: []
}>()

const tagsStore = useTagsStore()
const selectionStore = useTxSelectionStore()
const txStore = useTransactionsStore()

/** Whichever source the caller picked — list-local or basket. */
const workingSet = computed<Transaction[]>(() =>
  props.transactions ?? selectionStore.items,
)
const workingCount = computed(() => workingSet.value.length)

type CheckState = 'checked' | 'tristate' | 'unchecked'

interface TagRow {
  name: string
  initial: CheckState
  state: CheckState
  /** At least one selected tx already carries this tag — used to
   *  push these tags above the rest so a user scanning a long tag
   *  list sees what's currently in use first. */
  inUse: boolean
}

const search = ref('')
const tagRows = ref<TagRow[]>([])
const promoteAiTags = ref(false)
const saving = ref(false)
const error = ref<string | null>(null)

function computeInitialState(tagName: string): {
  state: CheckState
  inUse: boolean
} {
  const total = workingSet.value.length
  if (total === 0) return { state: 'unchecked', inUse: false }
  let withTag = 0
  for (const tx of workingSet.value) {
    if (tx.tags.some((t) => t.name === tagName)) withTag++
  }
  if (withTag === 0) return { state: 'unchecked', inUse: false }
  if (withTag === total) return { state: 'checked', inUse: true }
  return { state: 'tristate', inUse: true }
}

async function refreshRows() {
  if (tagsStore.items.length === 0) {
    await tagsStore.refresh('all')
  }
  const knownNames = new Set(tagsStore.items.map((t) => t.name))
  for (const tx of workingSet.value) {
    for (const t of tx.tags) knownNames.add(t.name)
  }
  tagRows.value = [...knownNames]
    .sort((a, b) => a.localeCompare(b))
    .map((name) => {
      const init = computeInitialState(name)
      return { name, initial: init.state, state: init.state, inUse: init.inUse }
    })
}

watch(
  () => props.visible,
  async (open) => {
    if (!open) return
    search.value = ''
    promoteAiTags.value = false
    error.value = null
    saving.value = false
    tagRows.value = []
    if (workingCount.value > 0) {
      await refreshRows()
    }
  },
)

const filteredTagRows = computed(() => {
  const q = search.value.trim().toLowerCase()
  const matches = (r: TagRow) =>
    q.length === 0 || r.name.toLowerCase().includes(q)
  const inUse = tagRows.value.filter((r) => r.inUse && matches(r))
  const others = tagRows.value.filter((r) => !r.inUse && matches(r))
  return { inUse, others }
})

function cycleState(row: TagRow, checked: boolean | null) {
  // PrimeVue's binary checkbox emits true/false. Translate to our
  // 3-state model: clicking unchecked/tristate → checked, clicking
  // checked → unchecked. Re-reaching tristate is only possible by
  // clicking a tristate-initial tag back to "keep as is".
  if (row.initial === 'tristate' && row.state === 'unchecked') {
    row.state = 'tristate'
    return
  }
  row.state = checked ? 'checked' : 'unchecked'
}

const dirtyRows = computed(() =>
  tagRows.value.filter((r) => r.state !== r.initial),
)
const hasChanges = computed(() => dirtyRows.value.length > 0)

function close() {
  if (saving.value) return
  emit('update:visible', false)
}

async function save() {
  if (!hasChanges.value || saving.value) return
  saving.value = true
  error.value = null
  const add: string[] = []
  const remove: string[] = []
  for (const row of dirtyRows.value) {
    if (row.state === 'checked') add.push(row.name)
    else if (row.state === 'unchecked') remove.push(row.name)
  }
  try {
    await txStore.batchTag({
      transaction_ids: workingSet.value.map((tx) => tx.id),
      add,
      remove,
      promote_ai_tags: promoteAiTags.value,
    })
    // When the basket store is the source, keep its in-memory items in
    // sync with what the server now sees so reopening the dialog
    // reflects the new tristate. For list-local working sets the
    // calling view owns the data and refreshes it via the `applied`
    // event.
    if (!props.transactions) {
      selectionStore.set(
        selectionStore.items.map((tx) => {
          let tags = tx.tags.filter((t) => {
            if (t.source === 'user' && remove.includes(t.name)) return false
            if (t.source === 'ai' && promoteAiTags.value === false) return false
            return true
          })
          if (promoteAiTags.value === true) {
            tags = tags.map((t) =>
              t.source === 'ai'
                ? { ...t, source: 'user' as const, confidence: null }
                : t,
            )
          }
          const existingNames = new Set(tags.map((t) => t.name))
          for (const name of add) {
            if (!existingNames.has(name)) {
              tags.push({ name, source: 'user', confidence: null })
            }
          }
          return { ...tx, tags }
        }),
      )
    }
    emit('applied')
    emit('update:visible', false)
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <Dialog
    :visible="visible"
    modal
    :style="{ width: '32rem', maxHeight: '85vh' }"
    :closable="!saving"
    :dismissable-mask="!saving"
    @update:visible="emit('update:visible', $event)"
  >
    <template #header>
      <span class="dlg-title">
        Tags für {{ workingCount }}
        Buchung{{ workingCount === 1 ? '' : 'en' }}
      </span>
    </template>

    <Message v-if="error" severity="error" :closable="true" @close="error = null">
      {{ error }}
    </Message>

    <div class="bt-ai-row">
      <Checkbox v-model="promoteAiTags" inputId="bt-promote-ai" binary />
      <label for="bt-promote-ai" class="bt-ai-label">KI-Tags übernehmen</label>
      <span class="bt-ai-hint">
        {{
          promoteAiTags
            ? 'KI-Tags werden zu manuellen Tags hochgestuft'
            : 'KI-Tags werden entfernt'
        }}
      </span>
    </div>

    <div class="bt-search-row">
      <InputText
        v-model="search"
        placeholder="Suchen"
        class="bt-search-input"
      />
      <Button
        v-if="search.length > 0"
        icon="pi pi-times"
        severity="secondary"
        text
        rounded
        aria-label="Suche leeren"
        @click="search = ''"
      />
    </div>

    <ul class="bt-tag-list">
      <template v-if="filteredTagRows.inUse.length > 0">
        <li
          v-for="row in filteredTagRows.inUse"
          :key="'use-' + row.name"
          class="bt-tag-row bt-tag-row-inuse"
        >
          <Checkbox
            :model-value="row.state === 'checked'"
            :indeterminate="row.state === 'tristate'"
            :binary="true"
            :aria-label="row.name"
            @update:model-value="(v: boolean | null) => cycleState(row, v)"
          />
          <span class="bt-tag-label">{{ row.name }}</span>
        </li>
        <li
          v-if="filteredTagRows.others.length > 0"
          class="bt-tag-divider"
        />
      </template>
      <li
        v-for="row in filteredTagRows.others"
        :key="'rest-' + row.name"
        class="bt-tag-row"
      >
        <Checkbox
          :model-value="row.state === 'checked'"
          :indeterminate="row.state === 'tristate'"
          :binary="true"
          :aria-label="row.name"
          @update:model-value="(v: boolean | null) => cycleState(row, v)"
        />
        <span class="bt-tag-label">{{ row.name }}</span>
      </li>
      <li
        v-if="filteredTagRows.inUse.length === 0 && filteredTagRows.others.length === 0"
        class="bt-tag-empty"
      >
        Keine Tags gefunden.
      </li>
    </ul>

    <template #footer>
      <Button
        label="Abbrechen"
        severity="secondary"
        text
        :disabled="saving"
        @click="close"
      />
      <Button
        label="Speichern"
        icon="pi pi-check"
        :disabled="!hasChanges"
        :loading="saving"
        @click="save"
      />
    </template>
  </Dialog>
</template>

<style scoped>
.dlg-title {
  font-weight: 600;
}

.bt-ai-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem;
  padding: 0.6rem 0.75rem;
  background: var(--p-content-background);
  border: 1px solid var(--p-content-border-color);
  border-radius: 0.5rem;
  margin-bottom: 0.5rem;
}
.bt-ai-label {
  font-weight: 500;
  cursor: pointer;
}
.bt-ai-hint {
  font-size: 0.8rem;
  color: var(--p-text-muted-color);
}

.bt-search-row {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  margin-bottom: 0.5rem;
}
.bt-search-input {
  width: 100%;
}

.bt-tag-list {
  list-style: none;
  padding: 0;
  margin: 0;
  background: var(--p-content-background);
  border: 1px solid var(--p-content-border-color);
  border-radius: 0.5rem;
  overflow: hidden;
  max-height: 50vh;
  overflow-y: auto;
}
.bt-tag-row {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.6rem 0.75rem;
  border-bottom: 1px solid var(--p-content-border-color);
}
.bt-tag-row:last-child {
  border-bottom: none;
}
.bt-tag-row-inuse {
  background: var(--p-content-hover-background);
}
.bt-tag-divider {
  height: 0;
  border-top: 2px solid var(--p-content-border-color);
}
.bt-tag-label {
  flex: 1;
  word-break: break-word;
}
.bt-tag-empty {
  padding: 1rem;
  text-align: center;
  color: var(--p-text-muted-color);
  font-style: italic;
}
</style>
