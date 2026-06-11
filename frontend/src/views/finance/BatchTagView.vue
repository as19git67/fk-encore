<script setup lang="ts">
/**
 * Tags-für-N-Buchungen: tristate-Editor für die Mehrfachauswahl.
 *
 * Zustand pro Tag:
 *   • checked   — alle ausgewählten Buchungen haben den Tag
 *   • tristate  — manche haben ihn, andere nicht
 *   • unchecked — keine Buchung hat den Tag
 *
 * Beim Speichern werden nur die Diffs gegen den Initialzustand
 * verschickt:
 *   • unchecked → checked   ⇒ add (alle bekommen ihn)
 *   • checked   → unchecked ⇒ remove (alle verlieren ihn)
 *   • tristate  → checked   ⇒ add (die ohne bekommen ihn dazu)
 *   • tristate  → unchecked ⇒ remove (die mit verlieren ihn)
 *   • tristate  → tristate (unverändert) ⇒ keine Änderung
 *
 * Backend-Aufruf läuft in einer DB-Transaction, also alles oder
 * nichts.
 */

import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import Button from 'primevue/button'
import InputText from 'primevue/inputtext'
import Checkbox from 'primevue/checkbox'
import Message from 'primevue/message'
import { useTagsStore } from '../../stores/finance/tags'
import { useTxSelectionStore } from '../../stores/finance/selection'
import { useTransactionsStore } from '../../stores/finance/transactions'

const router = useRouter()
const tagsStore = useTagsStore()
const selectionStore = useTxSelectionStore()
const txStore = useTransactionsStore()

type CheckState = 'checked' | 'tristate' | 'unchecked'

interface TagRow {
  name: string
  initial: CheckState
  state: CheckState
  /** True when at least one selected transaction already carries this
   *  tag — used to sort "in use" tags above the rest. */
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
  const total = selectionStore.items.length
  if (total === 0) return { state: 'unchecked', inUse: false }
  let withTag = 0
  for (const tx of selectionStore.items) {
    if (tx.tags.some((t) => t.name === tagName)) withTag++
  }
  if (withTag === 0) return { state: 'unchecked', inUse: false }
  if (withTag === total) return { state: 'checked', inUse: true }
  return { state: 'tristate', inUse: true }
}

onMounted(async () => {
  if (selectionStore.count === 0) {
    // No selection — there's nothing to edit. Bounce back to the
    // overview rather than rendering an empty list.
    void router.push({ name: 'finance-overview' })
    return
  }
  if (tagsStore.items.length === 0) {
    await tagsStore.refresh('all')
  }
  // Build the working set: every known tag plus any tag that's already
  // on a selected transaction (in case the tag store is stale).
  const knownNames = new Set(tagsStore.items.map((t) => t.name))
  for (const tx of selectionStore.items) {
    for (const t of tx.tags) knownNames.add(t.name)
  }
  tagRows.value = [...knownNames].sort((a, b) => a.localeCompare(b)).map(
    (name) => {
      const init = computeInitialState(name)
      return { name, initial: init.state, state: init.state, inUse: init.inUse }
    },
  )
})

const filteredTagRows = computed(() => {
  const q = search.value.trim().toLowerCase()
  const matches = (r: TagRow) =>
    q.length === 0 || r.name.toLowerCase().includes(q)
  // "In Use"-Tags zuerst, danach der Rest. Innerhalb jeder Gruppe
  // alphabetisch (oben schon sortiert).
  const inUse = tagRows.value.filter((r) => r.inUse && matches(r))
  const others = tagRows.value.filter((r) => !r.inUse && matches(r))
  return { inUse, others }
})

function cycleState(row: TagRow, checked: boolean | null) {
  // PrimeVue's binary checkbox emits true/false. We translate that
  // into our 3-state model:
  //   • clicking from `tristate` → checked
  //   • clicking from `unchecked` → checked
  //   • clicking from `checked` → unchecked
  // Re-reaching `tristate` is only possible by clicking again on a
  // tag that started out tristate (toggle back to keep-as-is).
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

function goBack() {
  router.back()
}

async function save() {
  if (!hasChanges.value || saving.value) return
  saving.value = true
  error.value = null
  // Diff against the initial state and translate to add/remove.
  const add: string[] = []
  const remove: string[] = []
  for (const row of dirtyRows.value) {
    if (row.state === 'checked') add.push(row.name)
    else if (row.state === 'unchecked') remove.push(row.name)
    // 'tristate' as a target (initial=='tristate' && state=='tristate')
    // is a no-op and isn't even in dirtyRows.
  }
  try {
    await txStore.batchTag({
      transaction_ids: selectionStore.ids,
      add,
      remove,
      promote_ai_tags: promoteAiTags.value,
    })
    // Update selectionStore so re-entering this view shows current state.
    selectionStore.set(selectionStore.items.map((tx) => {
      let tags = tx.tags.filter((t) => {
        if (t.source === 'user' && remove.includes(t.name)) return false
        if (t.source === 'ai' && promoteAiTags.value === false) return false
        return true
      })
      // Promote: convert remaining ai tags to user
      if (promoteAiTags.value === true) {
        tags = tags.map((t) => t.source === 'ai' ? { ...t, source: 'user' as const, confidence: null } : t)
      }
      // Add new user tags (avoid duplicates)
      const existingNames = new Set(tags.map((t) => t.name))
      for (const name of add) {
        if (!existingNames.has(name)) tags.push({ name, source: 'user', confidence: null })
      }
      return { ...tx, tags }
    }))
    void router.back()
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div class="page">
    <header class="bt-header">
      <Button
        label="Zurück"
        icon="pi pi-chevron-left"
        severity="secondary"
        @click="goBack"
      />
      <h1 class="bt-title">
        Tags für {{ selectionStore.count }} Buchung{{ selectionStore.count === 1 ? '' : 'en' }}
      </h1>
      <Button
        label="Speichern"
        icon="pi pi-check"
        :disabled="!hasChanges"
        :loading="saving"
        @click="save"
      />
    </header>

    <Message v-if="error" severity="error" :closable="false">
      {{ error }}
    </Message>

    <div class="bt-ai-row">
      <Checkbox v-model="promoteAiTags" inputId="promote-ai" binary />
      <label for="promote-ai" class="bt-ai-label">KI-Tags übernehmen</label>
      <span class="bt-ai-hint">{{ promoteAiTags ? 'KI-Tags werden zu manuellen Tags hochgestuft' : 'KI-Tags werden entfernt' }}</span>
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
  </div>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  padding: 1rem;
}
@media (max-width: 640px) {
  .page {
    padding: 0.5rem;
  }
}

.bt-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  background: var(--p-primary-700, #1f6e3a);
  color: var(--p-primary-contrast-color, #fff);
  padding: 0.6rem 0.75rem;
  border-radius: 0.5rem;
  position: sticky;
  top: 0;
  z-index: 1;
}
.bt-title {
  margin: 0;
  font-size: 1rem;
  font-weight: 600;
  text-align: center;
  flex: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.bt-header :deep(.p-button) {
  background: rgba(255, 255, 255, 0.18);
  border: 1px solid transparent;
  color: var(--p-primary-contrast-color, #fff);
}
.bt-header :deep(.p-button:hover) {
  background: rgba(255, 255, 255, 0.3);
}
.bt-header :deep(.p-button:disabled) {
  opacity: 0.5;
}

.bt-ai-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.6rem 0.75rem;
  background: var(--p-content-background);
  border: 1px solid var(--p-content-border-color);
  border-radius: 0.5rem;
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
}
.bt-tag-row {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.75rem 1rem;
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
