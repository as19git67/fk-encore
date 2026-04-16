<script setup lang="ts">
import { ref, onMounted } from 'vue'
import DataTable from 'primevue/datatable'
import Column from 'primevue/column'
import InputText from 'primevue/inputtext'
import Button from 'primevue/button'
import Dialog from 'primevue/dialog'
import Select from 'primevue/select'
import ToggleSwitch from 'primevue/toggleswitch'
import Tag from 'primevue/tag'
import Message from 'primevue/message'
import {
  listLibraries,
  listAvailablePaths,
  createLibrary,
  updateLibrary,
  deleteLibrary,
  scanLibrary,
  reconcileLibrary,
  type PhotoLibrary,
  type LibraryImportMode,
  type ScanReport,
  type AvailableDirectory,
} from '../api/libraries'
import { useAuthStore } from '../stores/auth'
import { formatDateShort } from '../utils/dateFormat'

const auth = useAuthStore()
const libraries = ref<PhotoLibrary[]>([])
const loading = ref(true)
const error = ref('')
const info = ref('')

const importModeOptions: { label: string; value: LibraryImportMode }[] = [
  { label: 'Verlinken (Datei bleibt am Ort)', value: 'link' },
  { label: 'Verschieben (in Upload-Verzeichnis)', value: 'move' },
]

// Edit / create dialog state
const showEditDialog = ref(false)
const editingId = ref<number | null>(null)
const form = ref<{
  name: string
  path: string
  import_mode: LibraryImportMode
  auto_import: boolean
}>({
  name: '',
  path: '',
  import_mode: 'link',
  auto_import: false,
})
const saving = ref(false)

// Path picker state (create mode)
const availablePaths = ref<AvailableDirectory[]>([])
const availableRoot = ref('')
const rootMounted = ref(false)
const loadingPaths = ref(false)

// Delete confirmation
const showDeleteConfirm = ref(false)
const libraryToDelete = ref<PhotoLibrary | null>(null)

// Per-row busy flags so users see immediate feedback
const busyId = ref<number | null>(null)

async function loadData() {
  loading.value = true
  error.value = ''
  try {
    const res = await listLibraries()
    libraries.value = res.libraries
  } catch (err: any) {
    error.value = err.message || 'Fehler beim Laden'
  } finally {
    loading.value = false
  }
}

async function openCreateDialog() {
  editingId.value = null
  form.value = { name: '', path: '', import_mode: 'link', auto_import: false }
  showEditDialog.value = true
  loadingPaths.value = true
  try {
    const res = await listAvailablePaths()
    availableRoot.value = res.root
    rootMounted.value = res.root_mounted
    availablePaths.value = res.directories
  } catch (err: any) {
    error.value = err.message || 'Verzeichnisse konnten nicht geladen werden'
    availablePaths.value = []
  } finally {
    loadingPaths.value = false
  }
}

function openEditDialog(lib: PhotoLibrary) {
  editingId.value = lib.id
  form.value = {
    name: lib.name,
    path: lib.path,
    import_mode: lib.import_mode,
    auto_import: lib.auto_import,
  }
  showEditDialog.value = true
}

async function handleSave() {
  if (!form.value.name.trim()) return
  if (editingId.value === null && !form.value.path.trim()) return
  error.value = ''
  saving.value = true
  try {
    if (editingId.value === null) {
      await createLibrary({
        name: form.value.name.trim(),
        path: form.value.path.trim(),
        import_mode: form.value.import_mode,
        auto_import: form.value.auto_import,
      })
      info.value = 'Bibliothek angelegt.'
    } else {
      await updateLibrary(editingId.value, {
        name: form.value.name.trim(),
        import_mode: form.value.import_mode,
        auto_import: form.value.auto_import,
      })
      info.value = 'Bibliothek aktualisiert.'
    }
    showEditDialog.value = false
    await loadData()
  } catch (err: any) {
    error.value = err.message || 'Speichern fehlgeschlagen'
  } finally {
    saving.value = false
  }
}

function confirmDelete(lib: PhotoLibrary) {
  libraryToDelete.value = lib
  showDeleteConfirm.value = true
}

async function handleDelete() {
  if (!libraryToDelete.value) return
  error.value = ''
  try {
    await deleteLibrary(libraryToDelete.value.id)
    info.value = `Bibliothek "${libraryToDelete.value.name}" entfernt.`
  } catch (err: any) {
    error.value = err.message || 'Bibliothek konnte nicht entfernt werden'
  } finally {
    showDeleteConfirm.value = false
    libraryToDelete.value = null
    await loadData()
  }
}

async function runScan(lib: PhotoLibrary) {
  error.value = ''
  info.value = ''
  busyId.value = lib.id
  try {
    const report: ScanReport = await scanLibrary(lib.id)
    info.value = `Scan "${lib.name}": ${report.imported} importiert, `
      + `${report.skipped_duplicate} Duplikate, `
      + `${report.skipped_unsupported} nicht unterstützt, `
      + `${report.errors} Fehler (${report.scanned} insgesamt).`
    await loadData()
  } catch (err: any) {
    error.value = err.message || 'Scan fehlgeschlagen'
  } finally {
    busyId.value = null
  }
}

async function runReconcile(lib: PhotoLibrary) {
  error.value = ''
  info.value = ''
  busyId.value = lib.id
  try {
    const res = await reconcileLibrary(lib.id)
    info.value = `Abgleich "${lib.name}": ${res.removed} verwaiste Einträge entfernt.`
    await loadData()
  } catch (err: any) {
    error.value = err.message || 'Abgleich fehlgeschlagen'
  } finally {
    busyId.value = null
  }
}

function modeLabel(mode: LibraryImportMode): string {
  return mode === 'link' ? 'Verlinken' : 'Verschieben'
}

onMounted(loadData)
</script>

<template>
  <div class="libraries-view">
    <h1 class="title">Externe Bibliotheken</h1>

    <p class="hint">
      Externe Bibliotheken importieren Fotos aus Verzeichnissen unterhalb von
      <code>PHOTO_LIBRARIES_ROOT</code>. Im Modus
      <strong>Verlinken</strong> bleibt die Datei am Ort, im Modus
      <strong>Verschieben</strong> wird sie in das Upload-Verzeichnis übernommen.
    </p>

    <Message v-if="error" severity="error" :closable="true" class="mb" @close="error = ''">
      {{ error }}
    </Message>
    <Message v-if="info" severity="success" :closable="true" class="mb" @close="info = ''">
      {{ info }}
    </Message>

    <div v-if="auth.hasPermission('photos.libraries.manage')" class="toolbar mb">
      <Button label="Neue Bibliothek" icon="pi pi-plus" @click="openCreateDialog" />
    </div>

    <DataTable
      :value="libraries"
      :loading="loading"
      striped-rows
      paginator
      :rows="10"
      data-key="id"
      table-style="min-width: 60rem"
    >
      <Column field="id" header="ID" sortable style="width: 4rem" />
      <Column field="name" header="Name" sortable style="width: 12rem" />
      <Column field="path" header="Pfad">
        <template #body="{ data }">
          <code class="path">{{ data.path }}</code>
        </template>
      </Column>
      <Column header="Modus" style="width: 9rem">
        <template #body="{ data }">
          <Tag
            :value="modeLabel(data.import_mode)"
            :severity="data.import_mode === 'link' ? 'info' : 'warn'"
          />
        </template>
      </Column>
      <Column header="Auto-Import" style="width: 8rem">
        <template #body="{ data }">
          <Tag
            :value="data.auto_import ? 'an' : 'aus'"
            :severity="data.auto_import ? 'success' : 'secondary'"
          />
        </template>
      </Column>
      <Column header="Letzter Scan" style="width: 10rem">
        <template #body="{ data }">
          <span v-if="data.last_scan_at">{{ formatDateShort(data.last_scan_at) }}</span>
          <span v-else class="muted">—</span>
        </template>
      </Column>
      <Column header="Aktionen" style="width: 14rem">
        <template #body="{ data }">
          <div class="action-buttons">
            <Button
              v-if="auth.hasPermission('photos.libraries.manage')"
              icon="pi pi-search"
              severity="success"
              text
              rounded
              :loading="busyId === data.id"
              v-tooltip="'Scan ausführen'"
              @click="runScan(data)"
            />
            <Button
              v-if="auth.hasPermission('photos.libraries.manage') && data.import_mode === 'link'"
              icon="pi pi-sync"
              severity="info"
              text
              rounded
              :loading="busyId === data.id"
              v-tooltip="'Abgleich (verwaiste Einträge entfernen)'"
              @click="runReconcile(data)"
            />
            <Button
              v-if="auth.hasPermission('photos.libraries.manage')"
              icon="pi pi-pencil"
              severity="secondary"
              text
              rounded
              v-tooltip="'Bearbeiten'"
              @click="openEditDialog(data)"
            />
            <Button
              v-if="auth.hasPermission('photos.libraries.manage')"
              icon="pi pi-trash"
              severity="danger"
              text
              rounded
              v-tooltip="'Entfernen'"
              @click="confirmDelete(data)"
            />
          </div>
        </template>
      </Column>
      <template #empty>
        <div class="empty">Keine Bibliotheken konfiguriert.</div>
      </template>
    </DataTable>

    <!-- Create / Edit Dialog -->
    <Dialog
      v-model:visible="showEditDialog"
      :header="editingId === null ? 'Neue Bibliothek' : 'Bibliothek bearbeiten'"
      :modal="true"
      :style="{ width: '500px' }"
    >
      <div class="form">
        <div class="field">
          <label for="lib-name">Name</label>
          <InputText id="lib-name" v-model="form.name" autocomplete="off" />
        </div>

        <div class="field">
          <label for="lib-path">Pfad</label>
          <Select
            v-if="editingId === null"
            id="lib-path"
            v-model="form.path"
            :options="availablePaths"
            option-label="name"
            option-value="rel_path"
            :option-disabled="(opt: AvailableDirectory) => opt.already_registered"
            :loading="loadingPaths"
            :placeholder="loadingPaths ? 'Lade Verzeichnisse…' : 'Unterverzeichnis wählen'"
            :empty-message="'Keine Verzeichnisse unter ' + availableRoot"
          >
            <template #option="{ option }">
              <div class="path-option">
                <span class="path-option-name">
                  <i
                    :class="option.mounted ? 'pi pi-server mount-ok' : 'pi pi-folder mount-unknown'"
                    v-tooltip="option.mounted ? 'Volume-Mount erkannt' : 'kein Volume-Mount erkannt'"
                  />
                  {{ option.name }}
                </span>
                <span v-if="option.already_registered" class="muted small">
                  (bereits registriert)
                </span>
              </div>
            </template>
          </Select>
          <InputText
            v-else
            id="lib-path"
            v-model="form.path"
            autocomplete="off"
            disabled
          />
          <small v-if="editingId === null" class="hint-small">
            Auswahl direkter Unterverzeichnisse unter
            <code>{{ availableRoot || 'PHOTO_LIBRARIES_ROOT' }}</code>.
            <span v-if="!loadingPaths">
              <span v-if="rootMounted" class="mount-ok">Volume-Mount auf Root erkannt.</span>
              <span v-else class="mount-warn">
                Kein Volume-Mount auf Root erkannt — ggf. in der Docker-Compose
                nicht konfiguriert.
              </span>
            </span>
          </small>
          <small v-else class="hint-small">Pfad kann nach Anlage nicht geändert werden.</small>
        </div>

        <div class="field">
          <label for="lib-mode">Importmodus</label>
          <Select
            id="lib-mode"
            v-model="form.import_mode"
            :options="importModeOptions"
            option-label="label"
            option-value="value"
          />
        </div>

        <div class="field row">
          <ToggleSwitch v-model="form.auto_import" input-id="lib-auto" />
          <label for="lib-auto">Automatischer Import (Watcher aktivieren)</label>
        </div>
      </div>

      <template #footer>
        <Button label="Abbrechen" severity="secondary" @click="showEditDialog = false" />
        <Button
          :label="editingId === null ? 'Anlegen' : 'Speichern'"
          :loading="saving"
          :disabled="!form.name.trim() || (editingId === null && !form.path.trim())"
          @click="handleSave"
        />
      </template>
    </Dialog>

    <!-- Delete Confirmation Dialog -->
    <Dialog
      v-model:visible="showDeleteConfirm"
      header="Bibliothek entfernen"
      :modal="true"
      :style="{ width: '440px' }"
    >
      <p>
        Bibliothek <strong>{{ libraryToDelete?.name }}</strong> wirklich entfernen?
      </p>
      <p class="muted small">
        Bereits importierte Fotos bleiben erhalten. Im Modus
        <strong>Verlinken</strong> verweisen sie weiterhin auf den ursprünglichen
        Dateipfad.
      </p>
      <template #footer>
        <Button label="Abbrechen" severity="secondary" @click="showDeleteConfirm = false" />
        <Button label="Entfernen" severity="danger" @click="handleDelete" />
      </template>
    </Dialog>
  </div>
</template>

<style scoped>
.libraries-view {
  gap: 1rem;
  display: flex;
  flex-direction: column;
}

@media (min-width: 800px) {
  .libraries-view {
    margin-inline: 0.5em;
  }
}

.libraries-view .title {
  font-size: 1.5em;
  font-weight: 600;
  margin-block: 0.25em;
}

.hint {
  margin: 0;
  color: var(--p-text-muted-color);
  font-size: 0.9rem;
}

.hint code {
  font-family: monospace;
  font-size: 0.85rem;
}

.toolbar {
  display: flex;
  gap: 0.5rem;
  align-items: center;
}

.mb {
  margin-bottom: 0.5rem;
}

.path {
  font-family: monospace;
  font-size: 0.85rem;
}

.muted {
  color: var(--p-text-muted-color);
}

.small {
  font-size: 0.85rem;
}

.empty {
  text-align: center;
  padding: 1rem;
  color: var(--p-text-muted-color);
}

.action-buttons {
  display: flex;
  gap: 0.25rem;
}

.form {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  padding-top: 0.5rem;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}

.field.row {
  flex-direction: row;
  align-items: center;
  gap: 0.6rem;
}

.field label {
  font-size: 0.85rem;
  font-weight: 600;
}

.hint-small {
  color: var(--p-text-muted-color);
  font-size: 0.8rem;
}

.hint-small code {
  font-family: monospace;
}

.path-option {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
}

.path-option-name {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
}

.mount-ok {
  color: var(--p-green-500, #22c55e);
}

.mount-unknown {
  color: var(--p-text-muted-color);
}

.mount-warn {
  color: var(--p-orange-500, #f59e0b);
}
</style>
