<script setup lang="ts">
import { ref } from 'vue'
import FileUpload from 'primevue/fileupload'
import Button from 'primevue/button'
import Message from 'primevue/message'
import { importFinanzkraft, type ImportResponse } from '../../api/finance'

const selected = ref<File | null>(null)
const running = ref(false)
const result = ref<ImportResponse | null>(null)
const error = ref<string | null>(null)

function onSelect(event: { files: File[] }) {
  selected.value = event.files[0] ?? null
  error.value = null
  result.value = null
}

async function runImport() {
  if (!selected.value) return
  running.value = true
  error.value = null
  result.value = null
  try {
    const text = await selected.value.text()
    const parsed = JSON.parse(text)
    result.value = await importFinanzkraft(parsed)
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
      <div class="actions">
        <Button
          label="Import starten"
          icon="pi pi-cloud-upload"
          :disabled="!selected || running"
          :loading="running"
          @click="runImport"
        />
      </div>
    </section>

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
</style>
