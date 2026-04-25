<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import FileUpload from 'primevue/fileupload'
import Button from 'primevue/button'
import Checkbox from 'primevue/checkbox'
import Dialog from 'primevue/dialog'
import Message from 'primevue/message'
import { importFinanzkraft, type ImportResponse } from '../../api/finance'

const router = useRouter()
const selected = ref<File | null>(null)
const running = ref(false)
const result = ref<ImportResponse | null>(null)
const error = ref<string | null>(null)

// "Wipe first" = TRUNCATE finance_*-tables before importing. Useful for
// iterative testing of mapping changes. Behind a confirmation dialog so
// no one nukes their data with a stray click.
const wipeFirst = ref(false)
const confirmVisible = ref(false)

// Number of newly inserted accounts — drives the post-import "Zugriffe
// vergeben"-CTA. Skipped (already-existing) accounts already have their
// ACL from a previous run, so they don't count.
const newAccountCount = computed<number>(() => {
  const counts = result.value?.counts as Record<string, number> | undefined
  return counts?.accounts ?? 0
})

function onSelect(event: { files: File[] }) {
  selected.value = event.files[0] ?? null
  error.value = null
  result.value = null
}

function onClickStart() {
  if (!selected.value) return
  if (wipeFirst.value) {
    confirmVisible.value = true
    return
  }
  void runImport()
}

async function runImport() {
  confirmVisible.value = false
  if (!selected.value) return
  running.value = true
  error.value = null
  result.value = null
  try {
    const text = await selected.value.text()
    const parsed = JSON.parse(text)
    result.value = await importFinanzkraft(parsed, {
      wipeFirst: wipeFirst.value,
    })
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    running.value = false
  }
}

function downloadErrors() {
  if (!result.value) return
  const blob = new Blob([JSON.stringify(result.value.errors, null, 2)], {
    type: 'application/json',
  })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = 'finanzkraft-import-errors.json'
  a.click()
  URL.revokeObjectURL(url)
}
</script>

<template>
  <div class="page">
    <header class="page-header">
      <h1>Datenimport (Finanzkraft-JSON)</h1>
    </header>
    <p class="hint">
      Importiert Bankkontakte, Konten, Transaktionen und Tags aus einem
      Finanzkraft-Export. Credentials und ACL werden **nicht** importiert
      und müssen manuell gesetzt werden.
    </p>

    <Message v-if="error" severity="error" :closable="true" @close="error = null">
      {{ error }}
    </Message>

    <section class="card">
      <FileUpload
        mode="basic"
        accept=".json,application/json"
        :auto="false"
        choose-label="Datei wählen"
        :customUpload="true"
        @select="onSelect"
      />
      <p v-if="selected" class="hint">
        {{ selected.name }} · {{ (selected.size / 1024 / 1024).toFixed(2) }} MB
      </p>
      <div class="wipe-row">
        <Checkbox v-model="wipeFirst" inputId="wipeFirst" binary />
        <label for="wipeFirst">
          <strong>Vorher alle Finanzdaten löschen</strong>
          <span class="hint">
            (Bankkontakte, Konten, Transaktionen, Tags, ACL, Salden,
            offene TAN-Sessions). Stammdaten bleiben.
          </span>
        </label>
      </div>
      <div class="actions">
        <Button
          label="Import starten"
          icon="pi pi-cloud-upload"
          :disabled="!selected || running"
          :loading="running"
          @click="onClickStart"
        />
      </div>
    </section>

    <Message
      v-if="result && newAccountCount > 0"
      severity="info"
      :closable="false"
      class="post-import-cta"
    >
      <p>
        {{ newAccountCount }} neue {{ newAccountCount === 1 ? 'Konto' : 'Konten' }}
        importiert. Damit non-admin User sie sehen, müssen jetzt manuell
        Zugriffe vergeben werden.
      </p>
      <Button
        label="Konto-Zugriffe vergeben"
        icon="pi pi-key"
        size="small"
        @click="router.push({ name: 'finance-admin-access' })"
      />
    </Message>

    <section v-if="result" class="card">
      <h2>Ergebnis</h2>
      <table class="result-table">
        <thead>
          <tr>
            <th>Entität</th>
            <th>Neu</th>
            <th>Übersprungen</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="entity in Object.keys(result.counts)" :key="entity">
            <td>{{ entity }}</td>
            <td>{{ (result.counts as any)[entity] }}</td>
            <td>{{ (result.skipped as any)[entity] }}</td>
          </tr>
        </tbody>
      </table>

      <div v-if="result.errors.length > 0" class="errors">
        <p>
          <strong>{{ result.errors.length }}</strong> Validierungsfehler
          <Button label="Als JSON herunterladen" size="small" text @click="downloadErrors" />
        </p>
        <ul>
          <li v-for="(e, i) in result.errors.slice(0, 10)" :key="i">
            <code>{{ e.entity }} #{{ e.row }}</code>: {{ e.message }}
          </li>
          <li v-if="result.errors.length > 10" class="hint">
            … {{ result.errors.length - 10 }} weitere (siehe Download).
          </li>
        </ul>
      </div>
    </section>

    <Dialog
      v-model:visible="confirmVisible"
      modal
      header="Wirklich alle Finanzdaten löschen?"
      :style="{ width: '32rem' }"
    >
      <p>
        Beim Import werden zuerst <strong>alle</strong> Bankkontakte,
        Konten, Transaktionen, Tags, ACL-Einträge, Saldenhistorie und
        offene TAN-Sessions <strong>unwiderruflich gelöscht</strong> und
        anschließend die Datei eingespielt.
      </p>
      <p class="hint">
        Stammdaten (Währungen, Kontotypen, Zeiträume) bleiben erhalten.
      </p>
      <template #footer>
        <Button
          label="Abbrechen"
          severity="secondary"
          text
          :disabled="running"
          @click="confirmVisible = false"
        />
        <Button
          label="Löschen + Importieren"
          icon="pi pi-trash"
          severity="danger"
          :loading="running"
          @click="runImport"
        />
      </template>
    </Dialog>
  </div>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  padding: 1.5rem;
  max-width: 48rem;
}
@media (max-width: 640px) {
  .page {
    padding: 0.75rem;
    gap: 0.75rem;
  }
  .card {
    padding: 0.75rem;
  }
}
.page-header h1 {
  margin: 0;
}
.card {
  border: 1px solid var(--p-content-border-color);
  border-radius: 0.5rem;
  padding: 1rem 1.25rem;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}
.card h2 {
  margin: 0;
  font-size: 1rem;
}
.actions {
  display: flex;
  justify-content: flex-end;
}
.wipe-row {
  display: flex;
  gap: 0.6rem;
  align-items: flex-start;
  padding: 0.6rem 0.85rem;
  background: color-mix(in srgb, var(--p-red-500, #ef4444) 8%, transparent);
  border-left: 3px solid var(--p-red-500, #ef4444);
  border-radius: 6px;
}
.wipe-row label {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
  cursor: pointer;
  line-height: 1.35;
}
.wipe-row label .hint {
  font-size: 0.85rem;
}
.result-table {
  width: 100%;
  border-collapse: collapse;
}
.result-table th,
.result-table td {
  padding: 0.25rem 0.5rem;
  text-align: left;
}
.result-table td:not(:first-child),
.result-table th:not(:first-child) {
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.errors ul {
  list-style: none;
  padding: 0;
  margin: 0.5rem 0 0;
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}
.errors code {
  background: var(--p-surface-100);
  padding: 0.1rem 0.25rem;
  border-radius: 0.2rem;
}
.hint {
  color: var(--p-text-muted-color);
  margin: 0;
}
.post-import-cta :deep(.p-message-text) {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  align-items: flex-start;
}
.post-import-cta p {
  margin: 0;
}
</style>
