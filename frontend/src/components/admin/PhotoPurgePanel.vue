<script setup lang="ts">
import { computed, ref } from 'vue'
import Button from 'primevue/button'
import Dialog from 'primevue/dialog'
import InputText from 'primevue/inputtext'
import Message from 'primevue/message'
import RadioButton from 'primevue/radiobutton'
import { purgePhotos, type PurgeResult } from '../../api/photos'
import { useScanQueueStatus } from '../../composables/useScanQueueStatus'

const { refresh: refreshScanQueue } = useScanQueueStatus()

const purgeDialogVisible = ref(false)
const purgeMode = ref<'db' | 'all'>('db')
const purgeConfirmText = ref('')
const purgeLoading = ref(false)
const purgeError = ref('')
const purgeResult = ref<PurgeResult | null>(null)

const PURGE_CONFIRM_KEYWORD = 'LÖSCHEN'
const canConfirmPurge = computed(
  () => purgeConfirmText.value.trim().toUpperCase() === PURGE_CONFIRM_KEYWORD && !purgeLoading.value
)

function openPurgeDialog() {
  purgeMode.value = 'db'
  purgeConfirmText.value = ''
  purgeError.value = ''
  purgeResult.value = null
  purgeDialogVisible.value = true
}

async function handlePurge() {
  if (!canConfirmPurge.value) return
  purgeLoading.value = true
  purgeError.value = ''
  try {
    const res = await purgePhotos(purgeMode.value === 'all')
    purgeResult.value = res
    purgeConfirmText.value = ''
    // Keep dialog open so the admin can inspect the result.
    await refreshScanQueue()
  } catch (err: any) {
    purgeError.value = err.message || 'Fehler beim Löschen der Fotodaten'
  } finally {
    purgeLoading.value = false
  }
}

const purgeDbTotals = computed(() => {
  if (!purgeResult.value) return 0
  return Object.values(purgeResult.value.dbCounts).reduce((s, n) => s + n, 0)
})
</script>

<template>
  <div class="data-management-group danger-zone">
    <h3 class="danger-zone__title">Danger Zone</h3>
    <p>
      Entfernt unwiderruflich alle Fotos, Alben, Gesichter, Personen,
      Embeddings und Scan-Queue-Einträge aus der Datenbank. Benutzerkonten,
      Rollen und Berechtigungen bleiben erhalten.
    </p>
    <Button class="data-management-group__item"
      icon="pi pi-trash"
      label="Alle Fotodaten löschen…"
      severity="danger"
      @click="openPurgeDialog"
    />

    <!-- Purge Confirmation Dialog -->
    <Dialog
      v-model:visible="purgeDialogVisible"
      modal
      :closable="!purgeLoading"
      :closeOnEscape="!purgeLoading"
      header="Alle Fotodaten löschen"
      :style="{ width: 'min(520px, 92vw)' }"
    >
      <div v-if="!purgeResult" class="purge-dialog">
        <Message severity="error" :closable="false" class="purge-dialog__warn">
          Diese Aktion ist <strong>nicht umkehrbar</strong>.
          Es werden <strong>alle</strong> Fotos, Alben, Gesichter, Personen,
          Embeddings und Scan-Queue-Einträge entfernt.
        </Message>

        <div class="purge-dialog__options">
          <label class="purge-dialog__option">
            <RadioButton v-model="purgeMode" inputId="purge-mode-db" name="purgeMode" value="db" />
            <span>
              <strong>Nur Datenbank</strong>
              <span class="purge-dialog__hint">
                Löscht alle Datenbank-Einträge. Die Original­dateien und Thumbnails bleiben auf der Festplatte erhalten (verwaist).
              </span>
            </span>
          </label>
          <label class="purge-dialog__option">
            <RadioButton v-model="purgeMode" inputId="purge-mode-all" name="purgeMode" value="all" />
            <span>
              <strong>Datenbank + Dateien</strong>
              <span class="purge-dialog__hint">
                Löscht zusätzlich alle hochgeladenen Fotos und alle zwischengespeicherten Thumbnails von der Festplatte.
              </span>
            </span>
          </label>
        </div>

        <div class="purge-dialog__confirm">
          <label for="purge-confirm-input">
            Bitte zur Bestätigung <strong>{{ PURGE_CONFIRM_KEYWORD }}</strong> eintippen:
          </label>
          <InputText
            id="purge-confirm-input"
            v-model="purgeConfirmText"
            :disabled="purgeLoading"
            autocomplete="off"
          />
        </div>

        <Message v-if="purgeError" severity="error" @close="purgeError = ''">{{ purgeError }}</Message>
      </div>

      <div v-else class="purge-result">
        <Message severity="success" :closable="false">
          Fotodaten wurden gelöscht. Entfernte Datenbank-Einträge: <strong>{{ purgeDbTotals }}</strong>.
        </Message>
        <table class="purge-result__table">
          <thead>
            <tr><th>Tabelle</th><th>Gelöschte Zeilen</th></tr>
          </thead>
          <tbody>
            <tr v-for="(count, table) in purgeResult.dbCounts" :key="table">
              <td>{{ table }}</td>
              <td>{{ count }}</td>
            </tr>
          </tbody>
        </table>
        <div v-if="purgeResult.files.deleted" class="purge-result__files">
          <strong>Dateien:</strong>
          {{ purgeResult.files.uploadsRemoved }} Uploads,
          {{ purgeResult.files.thumbnailsRemoved }} Thumbnail-Shards entfernt
          <span v-if="purgeResult.files.failures > 0">
            — {{ purgeResult.files.failures }} Fehler
          </span>
        </div>
        <div v-else class="purge-result__files">
          <strong>Dateien:</strong> wurden behalten (nur DB-Einträge entfernt).
        </div>
        <div class="purge-result__embeddings">
          <strong>Embedding-Service:</strong>
          <template v-if="purgeResult.embeddingService.ok">
            {{ purgeResult.embeddingService.deleted }} Embeddings gelöscht.
          </template>
          <template v-else>
            <span class="purge-result__warn">
              Fehler: {{ purgeResult.embeddingService.error || 'Service nicht erreichbar' }}
            </span>
          </template>
        </div>
      </div>

      <template #footer>
        <template v-if="!purgeResult">
          <Button
            label="Abbrechen"
            severity="secondary"
            outlined
            :disabled="purgeLoading"
            @click="purgeDialogVisible = false"
          />
          <Button
            :label="purgeMode === 'all' ? 'Alles endgültig löschen' : 'Datenbank leeren'"
            icon="pi pi-trash"
            severity="danger"
            :loading="purgeLoading"
            :disabled="!canConfirmPurge"
            @click="handlePurge"
          />
        </template>
        <template v-else>
          <Button label="Schließen" @click="purgeDialogVisible = false" />
        </template>
      </template>
    </Dialog>
  </div>
</template>

<style scoped src="./adminPanels.css"></style>
<style scoped>
.danger-zone {
  margin-top: 1rem;
  border: 1px solid var(--p-red-400, #e34c4c);
  border-radius: 0.5rem;
  padding: 0.75rem 1rem;
  background: color-mix(in srgb, var(--p-red-50, #fff5f5) 60%, transparent);
}
.danger-zone__title {
  color: var(--p-red-600, #c62828);
}

/* Purge dialog */
.purge-dialog {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}
.purge-dialog__warn {
  margin: 0;
}
.purge-dialog__options {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}
.purge-dialog__option {
  display: flex;
  align-items: flex-start;
  gap: 0.6rem;
  cursor: pointer;
}
.purge-dialog__option span {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
}
.purge-dialog__hint {
  font-size: 0.85rem;
  color: var(--p-text-muted-color);
}
.purge-dialog__confirm {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}
.purge-dialog__confirm label {
  font-size: 0.9rem;
}

/* Purge result */
.purge-result {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}
.purge-result__table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.85rem;
}
.purge-result__table th,
.purge-result__table td {
  padding: 0.25rem 0.5rem;
  border-bottom: 1px solid var(--p-content-border-color);
  text-align: left;
}
.purge-result__table th {
  color: var(--p-text-muted-color);
  font-weight: 600;
  font-size: 0.75rem;
  text-transform: uppercase;
}
.purge-result__files,
.purge-result__embeddings {
  font-size: 0.9rem;
}
.purge-result__warn {
  color: var(--p-red-600, #c62828);
}
</style>
