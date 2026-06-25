<script setup lang="ts">
/**
 * Arbeitskorb (work-item basket, issue #750).
 *
 * The documents counterpart of the finance work-item basket: documents the
 * classifier wasn't sure about (low confidence) or that failed land here for
 * the user to handle. Select one or more and schedule a follow-up to park them
 * out of the basket until a chosen date; or open one to review it directly.
 */
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import Button from 'primevue/button'
import Checkbox from 'primevue/checkbox'
import Tag from 'primevue/tag'
import Message from 'primevue/message'
import DocumentThumbnail from '../components/DocumentThumbnail.vue'
import DocumentFollowUpDialog from '../components/DocumentFollowUpDialog.vue'
import { getDocumentBasket, type DocumentSummary } from '../api/documents'

const router = useRouter()

const items = ref<DocumentSummary[]>([])
const total = ref(0)
const loading = ref(false)
const loadError = ref('')
const selected = ref<Set<number>>(new Set())
const followUpOpen = ref(false)
const info = ref('')

const allSelected = computed(
  () => items.value.length > 0 && items.value.every((d) => selected.value.has(d.id)),
)
const selectedIds = computed(() => [...selected.value])

async function load() {
  loading.value = true
  loadError.value = ''
  try {
    const res = await getDocumentBasket({ limit: 200 })
    items.value = res.items
    total.value = res.total
    // Drop selections for documents that are no longer in the basket.
    selected.value = new Set(
      [...selected.value].filter((id) => res.items.some((d) => d.id === id)),
    )
  } catch (err: any) {
    loadError.value = err?.message ?? 'Fehler beim Laden des Arbeitskorbs.'
  } finally {
    loading.value = false
  }
}

function toggle(id: number, checked: boolean) {
  const next = new Set(selected.value)
  if (checked) next.add(id)
  else next.delete(id)
  selected.value = next
}

function toggleAll(checked: boolean) {
  selected.value = checked ? new Set(items.value.map((d) => d.id)) : new Set()
}

function openDoc(id: number) {
  router.push({ name: 'dokumente-detail', params: { id } })
}

function onFollowUpDone(payload: { scheduled: number }) {
  info.value = `${payload.scheduled} ${payload.scheduled === 1 ? 'Dokument' : 'Dokumente'} auf Wiedervorlage gelegt.`
  selected.value = new Set()
  void load()
}

function confidencePct(doc: DocumentSummary): number | null {
  if (doc.classification_confidence == null) return null
  return Math.round(doc.classification_confidence * 100)
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return ''
  const d = new Date(dateStr)
  if (Number.isNaN(d.getTime())) return dateStr
  return d.toLocaleDateString('de-DE', { day: '2-digit', month: 'short', year: 'numeric' })
}

onMounted(load)
</script>

<template>
  <div class="basket-view">
    <header class="bv-header">
      <div class="bv-header-left">
        <h2 class="bv-title">
          Arbeitskorb
          <span class="bv-count">({{ total }})</span>
        </h2>
        <p class="bv-sub">
          Neu eingescannte Dokumente mit niedriger KI-Konfidenz oder Fehlern.
        </p>
      </div>
      <div class="bv-header-right">
        <Button
          icon="pi pi-clock"
          label="Wiedervorlage"
          :disabled="selectedIds.length === 0"
          @click="followUpOpen = true"
        />
        <Button icon="pi pi-refresh" text rounded :loading="loading" @click="load" />
      </div>
    </header>

    <Message v-if="info" severity="success" :closable="true" @close="info = ''">
      {{ info }}
    </Message>
    <Message v-if="loadError" severity="error" :closable="true" @close="loadError = ''">
      {{ loadError }}
    </Message>

    <div v-if="items.length > 0" class="bv-selectall">
      <Checkbox
        :model-value="allSelected"
        :binary="true"
        input-id="bv-all"
        @update:model-value="toggleAll"
      />
      <label for="bv-all">Alle auswählen ({{ selectedIds.length }} gewählt)</label>
    </div>

    <div v-if="!loading && items.length === 0 && !loadError" class="bv-empty">
      <i class="pi pi-check-circle" />
      <p>Der Arbeitskorb ist leer.</p>
    </div>

    <ul class="bv-list">
      <li v-for="doc in items" :key="doc.id" class="bv-card">
        <Checkbox
          :model-value="selected.has(doc.id)"
          :binary="true"
          @update:model-value="(v: boolean) => toggle(doc.id, v)"
        />
        <button type="button" class="bv-thumb" @click="openDoc(doc.id)">
          <DocumentThumbnail :id="doc.id" :alt="doc.title ?? doc.original_filename" />
        </button>
        <div class="bv-body" @click="openDoc(doc.id)">
          <div class="bv-row1">
            <span class="bv-name">{{ doc.title || doc.original_filename }}</span>
            <Tag
              v-if="doc.status === 'failed'"
              severity="danger"
              value="Fehler"
            />
            <Tag
              v-else-if="confidencePct(doc) != null"
              severity="warn"
              :value="`Prüfen · ${confidencePct(doc)}%`"
            />
          </div>
          <div class="bv-meta">
            <span v-if="doc.sender"><i class="pi pi-building" /> {{ doc.sender }}</span>
            <span v-if="doc.doc_date"><i class="pi pi-calendar" /> {{ formatDate(doc.doc_date) }}</span>
            <span v-if="doc.last_error" class="bv-error">
              <i class="pi pi-exclamation-triangle" /> {{ doc.last_error }}
            </span>
          </div>
        </div>
      </li>
    </ul>

    <DocumentFollowUpDialog
      v-model:visible="followUpOpen"
      :document-ids="selectedIds"
      @done="onFollowUpDone"
    />
  </div>
</template>

<style scoped>
.basket-view {
  max-width: 960px;
  margin: 0 auto;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.bv-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 12px;
  flex-wrap: wrap;
}
.bv-title {
  font-size: 1.4rem;
  font-weight: 600;
  margin: 0;
}
.bv-count {
  font-weight: 400;
  color: var(--p-text-muted-color);
  margin-left: 6px;
}
.bv-sub {
  margin: 4px 0 0;
  color: var(--p-text-muted-color);
  font-size: 0.85rem;
}
.bv-header-right {
  display: flex;
  align-items: center;
  gap: 8px;
}
.bv-selectall {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 0.85rem;
  color: var(--p-text-muted-color);
}
.bv-empty {
  text-align: center;
  color: var(--p-text-muted-color);
  padding: 48px 16px;
}
.bv-empty .pi-check-circle {
  font-size: 2.5rem;
  color: var(--p-green-500, #22c55e);
  margin-bottom: 12px;
}
.bv-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.bv-card {
  display: flex;
  align-items: center;
  gap: 12px;
  background: var(--p-content-background);
  border: 1px solid var(--p-content-border-color);
  border-radius: 10px;
  padding: 10px 12px;
}
.bv-thumb {
  flex: 0 0 56px;
  width: 56px;
  height: 72px;
  border: 0;
  padding: 0;
  background: var(--p-content-hover-background);
  border-radius: 6px;
  overflow: hidden;
  cursor: pointer;
}
.bv-thumb :deep(img) {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.bv-body {
  flex: 1 1 auto;
  min-width: 0;
  cursor: pointer;
}
.bv-row1 {
  display: flex;
  align-items: center;
  gap: 8px;
}
.bv-name {
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.bv-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin-top: 4px;
  color: var(--p-text-muted-color);
  font-size: 0.8rem;
}
.bv-meta i {
  margin-right: 3px;
}
.bv-error {
  color: var(--p-red-500, #ef4444);
}
</style>
