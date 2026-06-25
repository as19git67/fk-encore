<script setup lang="ts">
/**
 * Später (the "Later" list, issue #750).
 *
 * Every pending follow-up the user has scheduled, soonest first. Each row shows
 * when the document returns to the work-item basket and lets the user cancel
 * the follow-up (returning it to the basket immediately) or open the document.
 */
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import Button from 'primevue/button'
import Message from 'primevue/message'
import DocumentThumbnail from '../components/DocumentThumbnail.vue'
import {
  listDocumentFollowUps,
  deleteDocumentFollowUp,
  type DocumentFollowUp,
} from '../api/documents'
import { parseLocalDate } from '../utils/dateFormat'

const router = useRouter()

const items = ref<DocumentFollowUp[]>([])
const loading = ref(false)
const loadError = ref('')
const info = ref('')
const removing = ref<Set<number>>(new Set())

async function load() {
  loading.value = true
  loadError.value = ''
  try {
    const res = await listDocumentFollowUps()
    items.value = res.items
  } catch (err: any) {
    loadError.value = err?.message ?? 'Fehler beim Laden der Wiedervorlagen.'
  } finally {
    loading.value = false
  }
}

function openDoc(id: number) {
  router.push({ name: 'dokumente-detail', params: { id } })
}

async function cancel(documentId: number) {
  if (removing.value.has(documentId)) return
  removing.value = new Set(removing.value).add(documentId)
  try {
    await deleteDocumentFollowUp(documentId)
    items.value = items.value.filter((f) => f.document.id !== documentId)
    info.value = 'Wiedervorlage aufgehoben — Dokument ist zurück im Arbeitskorb.'
  } catch (err: any) {
    loadError.value = err?.message ?? 'Aufheben fehlgeschlagen.'
  } finally {
    const next = new Set(removing.value)
    next.delete(documentId)
    removing.value = next
  }
}

function formatDate(dateStr: string): string {
  const d = parseLocalDate(dateStr)
  if (Number.isNaN(d.getTime())) return dateStr
  return d.toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: 'long', year: 'numeric' })
}

function isDue(dateStr: string): boolean {
  const d = parseLocalDate(dateStr)
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  return d.getTime() <= today.getTime()
}

onMounted(load)
</script>

<template>
  <div class="later-view">
    <header class="lv-header">
      <div>
        <h2 class="lv-title">
          Später
          <span class="lv-count">({{ items.length }})</span>
        </h2>
        <p class="lv-sub">Dokumente auf Wiedervorlage — sortiert nach Fälligkeit.</p>
      </div>
      <Button icon="pi pi-refresh" text rounded :loading="loading" @click="load" />
    </header>

    <Message v-if="info" severity="success" :closable="true" @close="info = ''">
      {{ info }}
    </Message>
    <Message v-if="loadError" severity="error" :closable="true" @close="loadError = ''">
      {{ loadError }}
    </Message>

    <div v-if="!loading && items.length === 0 && !loadError" class="lv-empty">
      <i class="pi pi-clock" />
      <p>Keine Wiedervorlagen geplant.</p>
    </div>

    <ul class="lv-list">
      <li v-for="f in items" :key="f.document.id" class="lv-card">
        <button type="button" class="lv-thumb" @click="openDoc(f.document.id)">
          <DocumentThumbnail :id="f.document.id" :alt="f.document.title ?? f.document.original_filename" />
        </button>
        <div class="lv-body" @click="openDoc(f.document.id)">
          <span class="lv-name">{{ f.document.title || f.document.original_filename }}</span>
          <div class="lv-meta">
            <span class="lv-date" :class="{ 'lv-date--due': isDue(f.follow_up_date) }">
              <i class="pi pi-clock" /> {{ formatDate(f.follow_up_date) }}
            </span>
            <span v-if="f.note" class="lv-note"><i class="pi pi-comment" /> {{ f.note }}</span>
          </div>
        </div>
        <Button
          icon="pi pi-times"
          label="Aufheben"
          text
          severity="secondary"
          :loading="removing.has(f.document.id)"
          @click="cancel(f.document.id)"
        />
      </li>
    </ul>
  </div>
</template>

<style scoped>
.later-view {
  max-width: 960px;
  margin: 0 auto;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.lv-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 12px;
}
.lv-title {
  font-size: 1.4rem;
  font-weight: 600;
  margin: 0;
}
.lv-count {
  font-weight: 400;
  color: var(--p-text-muted-color);
  margin-left: 6px;
}
.lv-sub {
  margin: 4px 0 0;
  color: var(--p-text-muted-color);
  font-size: 0.85rem;
}
.lv-empty {
  text-align: center;
  color: var(--p-text-muted-color);
  padding: 48px 16px;
}
.lv-empty .pi-clock {
  font-size: 2.5rem;
  margin-bottom: 12px;
}
.lv-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.lv-card {
  display: flex;
  align-items: center;
  gap: 12px;
  background: var(--p-content-background);
  border: 1px solid var(--p-content-border-color);
  border-radius: 10px;
  padding: 10px 12px;
}
.lv-thumb {
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
.lv-thumb :deep(img) {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.lv-body {
  flex: 1 1 auto;
  min-width: 0;
  cursor: pointer;
}
.lv-name {
  font-weight: 600;
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.lv-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin-top: 4px;
  color: var(--p-text-muted-color);
  font-size: 0.8rem;
}
.lv-meta i {
  margin-right: 3px;
}
.lv-date--due {
  color: var(--p-orange-500, #f97316);
  font-weight: 600;
}
</style>
