<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import Button from 'primevue/button'
import Message from 'primevue/message'
import ProgressBar from 'primevue/progressbar'
import { uploadDocument } from '../api/documents'

interface QueuedFile {
  file: File
  status: 'pending' | 'uploading' | 'done' | 'error' | 'duplicate'
  message?: string
  documentId?: number
}

const router = useRouter()
const queue = ref<QueuedFile[]>([])
const dragActive = ref(false)
const uploading = ref(false)
const fileInput = ref<HTMLInputElement | null>(null)

function onFilesPicked(ev: Event) {
  const input = ev.target as HTMLInputElement
  if (!input.files) return
  addFiles(Array.from(input.files))
  input.value = ''
}

function onDrop(ev: DragEvent) {
  ev.preventDefault()
  dragActive.value = false
  if (!ev.dataTransfer) return
  addFiles(Array.from(ev.dataTransfer.files))
}

function addFiles(files: File[]) {
  for (const file of files) {
    if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
      queue.value.push({ file, status: 'error', message: 'Nur PDF-Dateien werden unterstützt.' })
      continue
    }
    queue.value.push({ file, status: 'pending' })
  }
}

function removeItem(idx: number) {
  queue.value.splice(idx, 1)
}

async function uploadAll() {
  if (uploading.value) return
  uploading.value = true
  try {
    for (const item of queue.value) {
      if (item.status !== 'pending') continue
      item.status = 'uploading'
      try {
        const doc = await uploadDocument(item.file)
        item.status = 'done'
        item.documentId = doc.id
      } catch (err: any) {
        const msg = err?.message || 'Upload fehlgeschlagen'
        if (msg.toLowerCase().includes('duplicate') || msg.toLowerCase().includes('bereits')) {
          item.status = 'duplicate'
          item.message = 'Dokument wurde bereits hochgeladen.'
        } else {
          item.status = 'error'
          item.message = msg
        }
      }
    }
  } finally {
    uploading.value = false
  }
}

function clearDone() {
  queue.value = queue.value.filter((i) => i.status !== 'done' && i.status !== 'duplicate')
}

function goToList() {
  router.push({ name: 'dokumente-list' })
}

const pendingCount = () => queue.value.filter((i) => i.status === 'pending').length
const doneCount = () => queue.value.filter((i) => i.status === 'done').length
</script>

<template>
  <div class="upload-view">
    <div class="header">
      <h1 class="title">Dokument hochladen</h1>
      <Button icon="pi pi-arrow-left" label="Zurück" text @click="goToList" />
    </div>

    <div
      class="dropzone"
      :class="{ active: dragActive }"
      @dragover.prevent="dragActive = true"
      @dragleave.prevent="dragActive = false"
      @drop="onDrop"
      @click="fileInput?.click()"
      role="button"
      tabindex="0"
      @keydown.enter="fileInput?.click()"
    >
      <i class="pi pi-cloud-upload dropzone-icon" />
      <div class="dropzone-text">
        <strong>PDFs hier ablegen</strong>
        <span>oder klicken, um Dateien auszuwählen</span>
      </div>
      <input
        ref="fileInput"
        type="file"
        accept="application/pdf,.pdf"
        multiple
        hidden
        @change="onFilesPicked"
      />
    </div>

    <div v-if="queue.length > 0" class="queue-block">
      <div class="queue-header">
        <span>{{ queue.length }} Datei(en) in der Warteschlange</span>
        <div class="queue-actions">
          <Button
            label="Hochladen"
            icon="pi pi-upload"
            :disabled="pendingCount() === 0 || uploading"
            :loading="uploading"
            @click="uploadAll"
          />
          <Button
            v-if="doneCount() > 0"
            label="Abgeschlossene entfernen"
            icon="pi pi-check"
            text
            @click="clearDone"
          />
        </div>
      </div>

      <div class="queue-list">
        <div v-for="(item, idx) in queue" :key="idx" class="queue-item">
          <i class="pi pi-file-pdf file-icon" />
          <div class="queue-item-body">
            <div class="queue-item-title">{{ item.file.name }}</div>
            <div class="queue-item-sub">
              <span>{{ (item.file.size / 1024).toFixed(1) }} KB</span>
              <span v-if="item.status === 'pending'" class="status-pending">Wartet</span>
              <span v-else-if="item.status === 'uploading'" class="status-uploading">Wird hochgeladen…</span>
              <span v-else-if="item.status === 'done'" class="status-done">
                <i class="pi pi-check-circle" /> Hochgeladen – wird klassifiziert
              </span>
              <span v-else-if="item.status === 'duplicate'" class="status-duplicate">
                <i class="pi pi-info-circle" /> Bereits vorhanden
              </span>
              <span v-else-if="item.status === 'error'" class="status-error">
                <i class="pi pi-times-circle" /> {{ item.message }}
              </span>
            </div>
            <ProgressBar
              v-if="item.status === 'uploading'"
              mode="indeterminate"
              class="queue-progress"
            />
          </div>
          <Button
            v-if="item.status !== 'uploading'"
            icon="pi pi-times"
            text
            rounded
            size="small"
            @click="removeItem(idx)"
          />
        </div>
      </div>
    </div>

    <Message v-if="doneCount() > 0 && pendingCount() === 0 && !uploading" severity="success">
      {{ doneCount() }} Dokument(e) hochgeladen. Klassifikation läuft im Hintergrund.
    </Message>
  </div>
</template>

<style scoped>
.upload-view {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  padding-inline: 0.5em;
  max-width: 860px;
  margin: 0 auto;
  width: 100%;
}

@media (min-width: 800px) { .upload-view { padding-inline: 1em; } }

.title { font-size: 1.5em; font-weight: 600; margin-block: 0.25em; }

.header { display: flex; justify-content: space-between; align-items: center; }

.dropzone {
  border: 2px dashed var(--p-content-border-color);
  border-radius: 12px;
  padding: 2.5rem 1rem;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.75rem;
  cursor: pointer;
  background: var(--p-surface-card);
  transition: border-color 0.2s, background 0.2s;
  text-align: center;
}
.dropzone:hover,
.dropzone:focus-visible,
.dropzone.active {
  border-color: var(--p-primary-color);
  background: color-mix(in srgb, var(--p-primary-color) 8%, transparent);
  outline: none;
}
.dropzone-icon { font-size: 2.5rem; color: var(--p-primary-color); }
.dropzone-text {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}
.dropzone-text strong { font-size: 1rem; }
.dropzone-text span { color: var(--p-text-muted-color); font-size: 0.9rem; }

.queue-block {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}
.queue-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.5rem;
}
.queue-actions { display: flex; gap: 0.5rem; }
.queue-list { display: flex; flex-direction: column; gap: 0.5rem; }
.queue-item {
  display: flex;
  gap: 0.75rem;
  align-items: center;
  padding: 0.6rem 0.8rem;
  background: var(--p-surface-card);
  border: 1px solid var(--p-content-border-color);
  border-radius: 8px;
}
.file-icon { font-size: 1.25rem; color: var(--p-primary-color); }
.queue-item-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 0.25rem; }
.queue-item-title {
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.queue-item-sub { display: flex; gap: 0.75rem; font-size: 0.85rem; color: var(--p-text-muted-color); flex-wrap: wrap; }
.queue-item-sub span { display: inline-flex; align-items: center; gap: 0.25rem; }
.status-done { color: var(--p-green-500, #10b981); }
.status-duplicate { color: var(--p-yellow-600, #d97706); }
.status-error { color: var(--p-red-500, #ef4444); }
.status-uploading { color: var(--p-primary-color); }

.queue-progress {
  height: 4px;
  margin-top: 0.25rem;
}
</style>
