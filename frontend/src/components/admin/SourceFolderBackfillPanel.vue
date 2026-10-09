<script setup lang="ts">
/**
 * Herkunftsordner nachtragen (#1477).
 *
 * The old folder tree is mounted read-only on the server; the admin names
 * its path, the backend hashes every file in it and writes the folder onto
 * the document with the same content. "Prüfen" only reports, "Übernehmen"
 * writes — the report in between is what the admin reads before anything
 * changes.
 */
import { computed, ref } from 'vue'
import Button from 'primevue/button'
import InputText from 'primevue/inputtext'
import Message from 'primevue/message'
import {
  backfillSourceFolders,
  type SourceFolderBackfillResponse,
} from '../../api/documents'

/** Where docker-compose.yml mounts the old tree; a bare-metal install types its own path. */
const root = ref('/mnt/data/documents-source')
const loading = ref(false)
const error = ref('')
const result = ref<SourceFolderBackfillResponse | null>(null)

const canRun = computed(() => root.value.trim().length > 0 && !loading.value)

async function run(apply: boolean) {
  error.value = ''
  loading.value = true
  try {
    result.value = await backfillSourceFolders(root.value.trim(), apply)
  } catch (err: any) {
    result.value = null
    error.value = err?.message || 'Fehler beim Abgleich des Ordnerbaums'
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div class="data-management-group">
    <h3>Herkunftsordner nachtragen</h3>
    <p>
      Liest den alten Ordnerbaum auf dem Server, berechnet den Inhalts-Hash jeder
      PDF und trägt den Ordner bei dem Dokument ein, das dieselben Bytes hat.
      „Prüfen“ zeigt nur, was passieren würde; erst „Übernehmen“ schreibt.
    </p>

    <Message v-if="error" severity="error" class="data-management-group__item" @close="error = ''">
      {{ error }}
    </Message>

    <label class="data-management-group__item source-root">
      <span class="source-root__label">Pfad des alten Ordnerbaums auf dem Server</span>
      <InputText
        v-model="root"
        class="source-root__input"
        placeholder="/mnt/data/documents-source"
        :disabled="loading"
      />
    </label>

    <div class="data-management-group__item source-actions">
      <Button
        icon="pi pi-search"
        outlined
        label="Prüfen"
        :disabled="!canRun"
        :loading="loading && result === null"
        @click="run(false)"
      />
      <Button
        icon="pi pi-check"
        label="Übernehmen"
        :disabled="!canRun || result === null || !result.dry_run || result.updated === 0"
        :loading="loading && result !== null"
        @click="run(true)"
      />
    </div>

    <div v-if="result" class="data-management-group__item">
      <Message :severity="result.truncated || result.ambiguous_files_total > 0 ? 'warn' : 'info'" :closable="false">
        <template v-if="result.dry_run">Probelauf: </template>
        <template v-else>Übernommen: </template>
        {{ result.files_scanned }} Datei(en) gelesen,
        {{ result.matched }} Dokument(e) gefunden,
        {{ result.updated }} Ordner {{ result.dry_run ? 'würden geschrieben' : 'geschrieben' }}.
        {{ result.unmatched_files_total }} Datei(en) ohne Dokument,
        {{ result.unmatched_rows_total }} Dokument(e) ohne Datei im Baum.
        <template v-if="result.ambiguous_files_total > 0">
          {{ result.ambiguous_files_total }} Datei(en) liegen mit gleichem Inhalt in mehreren Ordnern und wurden ausgelassen.
        </template>
        <template v-if="result.truncated">
          Der Baum war größer als das Limit, der Bericht ist unvollständig.
        </template>
      </Message>

      <details v-if="result.matches.length > 0" class="source-report">
        <summary>Zuordnungen ({{ result.matches.length }}{{ result.matched > result.matches.length ? ` von ${result.matched}` : '' }})</summary>
        <ul class="source-report__list">
          <li v-for="m in result.matches" :key="m.document_id">
            <RouterLink :to="{ name: 'dokumente-detail', params: { id: m.document_id } }">#{{ m.document_id }}</RouterLink>
            → {{ m.source_folder ?? '(Wurzel)' }}
            <span v-if="m.previous && m.previous !== m.source_folder" class="text-secondary">(vorher {{ m.previous }})</span>
          </li>
        </ul>
      </details>

      <details v-if="result.unmatched_files.length > 0" class="source-report">
        <summary>Dateien ohne Dokument ({{ result.unmatched_files_total }})</summary>
        <ul class="source-report__list">
          <li v-for="f in result.unmatched_files" :key="f">{{ f }}</li>
        </ul>
      </details>

      <details v-if="result.ambiguous_files.length > 0" class="source-report">
        <summary>Gleicher Inhalt in mehreren Ordnern ({{ result.ambiguous_files_total }})</summary>
        <ul class="source-report__list">
          <li v-for="f in result.ambiguous_files" :key="f">{{ f }}</li>
        </ul>
      </details>
    </div>
  </div>
</template>

<style scoped>
.source-root {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}
.source-root__label {
  color: var(--p-text-muted-color);
  font-size: var(--text-sm);
}
.source-root__input {
  width: 100%;
  max-width: 40rem;
}
.source-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}
.source-report {
  margin-top: var(--space-2);
}
.source-report__list {
  margin: var(--space-1) 0 0;
  padding-left: 1.25rem;
  max-height: 20rem;
  overflow: auto;
  font-size: var(--text-sm);
  overflow-wrap: anywhere;
}
</style>
