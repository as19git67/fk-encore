<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import Button from 'primevue/button'
import Message from 'primevue/message'
import SelectButton from 'primevue/selectbutton'
import Tag from 'primevue/tag'
import {
  acceptHintSuggestion,
  listHintSuggestions,
  rejectHintSuggestion,
  type CategorySuggestionStatus,
  type HintSuggestion,
  type HintSuggestionKind,
} from '../api/documents'
import { useAuthStore } from '../stores/auth'

const router = useRouter()
const auth = useAuthStore()
const canManage = computed(() => auth.hasPermission('documents.manage_taxonomy'))

const items = ref<HintSuggestion[]>([])
const loading = ref(true)
const error = ref('')
const info = ref('')

const filter = ref<CategorySuggestionStatus>('open')
const filterOptions: Array<{ label: string; value: CategorySuggestionStatus }> = [
  { label: 'Offen', value: 'open' },
  { label: 'Akzeptiert', value: 'accepted' },
  { label: 'Abgelehnt', value: 'rejected' },
]

const kindFilter = ref<HintSuggestionKind | ''>('')
const kindOptions: Array<{ label: string; value: HintSuggestionKind | '' }> = [
  { label: 'Alle', value: '' },
  { label: 'Steuer-Hints', value: 'tax-section' },
  { label: 'Kategorie-Hints', value: 'category' },
]

const acceptingById = ref<Record<number, boolean>>({})
const rejectingById = ref<Record<number, boolean>>({})

async function load() {
  loading.value = true
  error.value = ''
  try {
    const res = await listHintSuggestions(
      filter.value,
      kindFilter.value || undefined,
    )
    items.value = res.items
  } catch (err: any) {
    error.value = err.message || 'Vorschläge konnten nicht geladen werden'
  } finally {
    loading.value = false
  }
}

watch([filter, kindFilter], load)

function kindLabel(kind: HintSuggestionKind): string {
  return kind === 'tax-section' ? 'Steuer-Anlage' : 'Kategorie'
}

function kindSeverity(kind: HintSuggestionKind) {
  return kind === 'tax-section' ? 'info' : 'secondary'
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return ''
  const d = new Date(dateStr)
  if (Number.isNaN(d.getTime())) return dateStr
  return d.toLocaleDateString('de-DE', { day: '2-digit', month: 'short', year: 'numeric' })
}

async function handleAccept(s: HintSuggestion) {
  if (!window.confirm(`Hint-Vorschlag für „${s.target_slug}" als nützlich markieren?`)) return
  acceptingById.value[s.id] = true
  error.value = ''
  info.value = ''
  try {
    await acceptHintSuggestion(s.id)
    info.value = `Vorschlag für „${s.target_slug}" akzeptiert.`
    await load()
  } catch (err: any) {
    error.value = err.message || 'Akzeptieren fehlgeschlagen'
  } finally {
    acceptingById.value[s.id] = false
  }
}

async function handleReject(s: HintSuggestion) {
  if (!window.confirm(`Hint-Vorschlag für „${s.target_slug}" ablehnen?`)) return
  rejectingById.value[s.id] = true
  error.value = ''
  info.value = ''
  try {
    await rejectHintSuggestion(s.id)
    info.value = 'Vorschlag abgelehnt.'
    await load()
  } catch (err: any) {
    error.value = err.message || 'Ablehnen fehlgeschlagen'
  } finally {
    rejectingById.value[s.id] = false
  }
}

function openExample(documentId: number) {
  router.push({ name: 'dokumente-detail', params: { id: documentId } })
}

onMounted(load)
</script>

<template>
  <div class="hints-view">
    <div class="header">
      <h1 class="title">Hint-Vorschläge</h1>
      <div class="filters">
        <SelectButton
          v-model="filter"
          :options="filterOptions"
          optionLabel="label"
          optionValue="value"
          :allowEmpty="false"
        />
        <SelectButton
          v-model="kindFilter"
          :options="kindOptions"
          optionLabel="label"
          optionValue="value"
          :allowEmpty="false"
        />
      </div>
    </div>

    <p class="subtitle">
      Die wöchentliche Analyse geprüfter Dokumente leitet typische Absender und
      Schlüsselwörter pro Steuer-Anlage und Kategorie ab. Die Vorschläge dienen
      als Orientierung, welche Hints verbessert werden könnten.
    </p>

    <Message v-if="!canManage" severity="warn" :closable="false">
      Keine Berechtigung (documents.manage_taxonomy).
    </Message>
    <Message v-if="error" severity="error" @close="error = ''">{{ error }}</Message>
    <Message v-if="info" severity="success" @close="info = ''">{{ info }}</Message>

    <div v-if="loading" class="info-text">
      <i class="pi pi-spin pi-spinner" /> Vorschläge werden geladen…
    </div>
    <div v-else-if="items.length === 0" class="info-text">
      <template v-if="filter === 'open'">Keine offenen Hint-Vorschläge.</template>
      <template v-else-if="filter === 'accepted'">Noch keine Vorschläge akzeptiert.</template>
      <template v-else>Noch keine Vorschläge abgelehnt.</template>
    </div>

    <div v-else class="suggestion-list">
      <div v-for="s in items" :key="s.id" class="suggestion-card">
        <div class="suggestion-head">
          <Tag :value="kindLabel(s.kind)" :severity="kindSeverity(s.kind)" />
          <code class="slug">{{ s.target_slug }}</code>
          <Tag
            v-if="s.status !== 'open'"
            :severity="s.status === 'accepted' ? 'success' : 'secondary'"
            :value="s.status === 'accepted' ? 'Akzeptiert' : 'Abgelehnt'"
          />
          <span v-if="s.updated_at" class="date">{{ formatDate(s.updated_at) }}</span>
        </div>

        <div class="draft-hint">
          <span class="label">Vorgeschlagener Hint:</span>
          <p class="draft-text">{{ s.draft_hint }}</p>
        </div>

        <p v-if="s.rationale" class="rationale">
          <i class="pi pi-info-circle" /> {{ s.rationale }}
        </p>

        <div v-if="s.example_document_ids.length > 0" class="examples">
          <span class="label">Beispiel-Dokumente:</span>
          <Button
            v-for="docId in s.example_document_ids.slice(0, 10)"
            :key="docId"
            :label="`#${docId}`"
            size="small"
            text
            icon="pi pi-external-link"
            @click="openExample(docId)"
          />
          <span v-if="s.example_document_ids.length > 10" class="more">
            … +{{ s.example_document_ids.length - 10 }} weitere
          </span>
        </div>

        <div v-if="s.status === 'open'" class="actions">
          <Button
            label="Nützlich"
            icon="pi pi-check"
            severity="success"
            :loading="acceptingById[s.id]"
            :disabled="!canManage"
            @click="handleAccept(s)"
          />
          <Button
            label="Ablehnen"
            icon="pi pi-times"
            severity="secondary"
            text
            :loading="rejectingById[s.id]"
            :disabled="!canManage"
            @click="handleReject(s)"
          />
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.hints-view {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  width: 100%;
  padding-inline: 0.5em;
}

@media (min-width: 800px) {
  .hints-view { padding-inline: 1em; }
}

.header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 1rem;
  flex-wrap: wrap;
}

.title {
  font-size: 1.5em;
  font-weight: 600;
  margin-block: 0.25em;
}

.filters {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
}

.subtitle {
  font-size: 0.9rem;
  color: var(--p-text-muted-color);
  margin: 0;
  max-width: 70ch;
}

.info-text {
  text-align: center;
  margin-top: 4rem;
  color: var(--p-text-muted-color);
}

.suggestion-list {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.suggestion-card {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  padding: 1rem;
  background: var(--p-content-background);
  border: 1px solid var(--p-content-border-color);
  border-radius: 8px;
}

.suggestion-head {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  flex-wrap: wrap;
}

.slug {
  font-size: 0.85rem;
  font-weight: 600;
}

.date {
  font-size: 0.85rem;
  color: var(--p-text-muted-color);
  margin-left: auto;
}

.draft-hint {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.draft-text {
  margin: 0;
  font-size: 0.9rem;
  padding: 0.5rem 0.75rem;
  background: var(--p-content-hover-background);
  border-radius: 6px;
  white-space: pre-wrap;
}

.rationale {
  margin: 0;
  font-size: 0.85rem;
  color: var(--p-text-muted-color);
  display: inline-flex;
  align-items: flex-start;
  gap: 0.4rem;
}

.examples {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.4rem;
}

.label {
  font-size: 0.85rem;
  color: var(--p-text-muted-color);
}

.more {
  font-size: 0.85rem;
  color: var(--p-text-muted-color);
}

.actions {
  display: flex;
  gap: 0.5rem;
  margin-top: 0.5rem;
}
</style>
