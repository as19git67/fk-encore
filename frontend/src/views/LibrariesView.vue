<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import ProgressSpinner from 'primevue/progressspinner'
import DataTable from 'primevue/datatable'
import Column from 'primevue/column'
import InputText from 'primevue/inputtext'
import Button from 'primevue/button'
import Dialog from 'primevue/dialog'
import Select from 'primevue/select'
import InputNumber from 'primevue/inputnumber'
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
  type AvailableDirectory,
} from '../api/libraries'
import { useAuthStore } from '../stores/auth'
import { formatDateShort } from '../utils/dateFormat'
import { useRealtimeEvent } from '../composables/useRealtime'

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
  auto_albums: boolean
  favorite_rating_threshold: number
}>({
  name: '',
  path: '',
  import_mode: 'link',
  auto_import: false,
  auto_albums: false,
  favorite_rating_threshold: 0,
})
const saving = ref(false)

// Path picker state (create mode) — supports deep navigation via `sub`.
const availablePaths = ref<AvailableDirectory[]>([])
const availableRoot = ref('')
const rootMounted = ref(false)
const currentSub = ref('')
const currentAbs = ref('')
const currentRegistered = ref(false)
const currentMounted = ref(false)
const loadingPaths = ref(false)

// Breadcrumb segments derived from currentSub. The library root itself is not
// shown as a labelled segment — a dedicated home button represents it.
const pathSegments = computed<{ label: string; sub: string }[]>(() => {
  if (!currentSub.value) return []
  const parts = currentSub.value.split('/')
  const segs: { label: string; sub: string }[] = []
  let acc = ''
  for (const p of parts) {
    acc = acc ? `${acc}/${p}` : p
    segs.push({ label: p, sub: acc })
  }
  return segs
})

// Delete confirmation
const showDeleteConfirm = ref(false)
const libraryToDelete = ref<PhotoLibrary | null>(null)

// Error detail popup
const showErrorDialog = ref(false)
const errorDialogMsg = ref('')
function openErrorDialog(msg: string) {
  errorDialogMsg.value = msg
  showErrorDialog.value = true
}

// Per-row busy flags so users see immediate feedback. A Set lets multiple
// libraries scan/reconcile concurrently without their spinners racing each
// other like a single shared ref would.
const busyIds = ref<Set<number>>(new Set())
function isBusy(id: number): boolean {
  return busyIds.value.has(id)
}
function markBusy(id: number, busy: boolean) {
  const next = new Set(busyIds.value)
  if (busy) next.add(id)
  else next.delete(id)
  busyIds.value = next
}

async function loadData(silent = false) {
  if (!silent) loading.value = true
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

async function loadPickerAt(sub: string) {
  loadingPaths.value = true
  try {
    const res = await listAvailablePaths(sub)
    availableRoot.value = res.root
    rootMounted.value = res.root_mounted
    currentSub.value = res.sub
    currentAbs.value = res.abs_path
    currentRegistered.value = res.current_registered
    currentMounted.value = res.current_mounted
    availablePaths.value = res.directories
  } catch (err: any) {
    error.value = err.message || 'Verzeichnisse konnten nicht geladen werden'
    availablePaths.value = []
  } finally {
    loadingPaths.value = false
  }
}

async function openCreateDialog() {
  editingId.value = null
  form.value = {
    name: '',
    path: '',
    import_mode: 'link',
    auto_import: false,
    auto_albums: false,
    favorite_rating_threshold: 0,
  }
  showEditDialog.value = true
  await loadPickerAt('')
}

function openEditDialog(lib: PhotoLibrary) {
  editingId.value = lib.id
  form.value = {
    name: lib.name,
    path: lib.path,
    import_mode: lib.import_mode,
    auto_import: lib.auto_import,
    auto_albums: lib.auto_albums,
    favorite_rating_threshold: lib.favorite_rating_threshold ?? 0,
  }
  showEditDialog.value = true
}

function navigateInto(dir: AvailableDirectory) {
  loadPickerAt(dir.rel_path)
}

function navigateTo(sub: string) {
  loadPickerAt(sub)
}

function selectDirectory(dir: AvailableDirectory) {
  if (dir.already_registered) return
  form.value.path = dir.rel_path
}

function selectCurrent() {
  if (!currentSub.value || currentRegistered.value) return
  form.value.path = currentSub.value
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
        auto_albums: form.value.auto_albums,
        favorite_rating_threshold: form.value.favorite_rating_threshold,
      })
      info.value = 'Bibliothek angelegt.'
    } else {
      await updateLibrary(editingId.value, {
        name: form.value.name.trim(),
        import_mode: form.value.import_mode,
        auto_import: form.value.auto_import,
        auto_albums: form.value.auto_albums,
        favorite_rating_threshold: form.value.favorite_rating_threshold,
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

function appendInfo(line: string) {
  info.value = info.value ? `${info.value}\n${line}` : line
}

function appendError(line: string) {
  error.value = error.value ? `${error.value}\n${line}` : line
}

async function runScan(lib: PhotoLibrary) {
  if (isBusy(lib.id)) return
  markBusy(lib.id, true)
  try {
    const res = await scanLibrary(lib.id)
    appendInfo(
      res.queued
        ? `Scan "${lib.name}" eingereiht.`
        : `Scan "${lib.name}" läuft bereits.`,
    )
    await loadData()
  } catch (err: any) {
    appendError(`Scan "${lib.name}": ${err.message || 'fehlgeschlagen'}`)
  } finally {
    markBusy(lib.id, false)
  }
}

async function runReconcile(lib: PhotoLibrary) {
  if (isBusy(lib.id)) return
  markBusy(lib.id, true)
  try {
    const res = await reconcileLibrary(lib.id)
    appendInfo(
      res.queued
        ? `Abgleich "${lib.name}" eingereiht.`
        : `Abgleich "${lib.name}" läuft bereits.`,
    )
    await loadData()
  } catch (err: any) {
    appendError(`Abgleich "${lib.name}": ${err.message || 'fehlgeschlagen'}`)
  } finally {
    markBusy(lib.id, false)
  }
}

function modeLabel(mode: LibraryImportMode): string {
  return mode === 'link' ? 'Verlinken' : 'Verschieben'
}

useRealtimeEvent('scan-queue', 'state.changed', () => { loadData(true) })

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

    <Message v-if="error" severity="error" :closable="true" class="mb multiline" @close="error = ''">
      {{ error }}
    </Message>
    <Message v-if="info" severity="success" :closable="true" class="mb multiline" @close="info = ''">
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
    >
      <Column field="id" header="ID" sortable style="width: 4rem" class="mobile-hidden" headerClass="mobile-hidden" />
      <Column field="name" header="Name" sortable style="width: 12rem" />
      <Column field="path" header="Pfad" class="mobile-hidden" headerClass="mobile-hidden">
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
      <Column header="Auto-Import" style="width: 8rem" class="mobile-hidden" headerClass="mobile-hidden">
        <template #body="{ data }">
          <Tag
            :value="data.auto_import ? 'an' : 'aus'"
            :severity="data.auto_import ? 'success' : 'secondary'"
          />
        </template>
      </Column>
      <Column header="Auto-Alben" style="width: 8rem" class="mobile-hidden" headerClass="mobile-hidden">
        <template #body="{ data }">
          <Tag
            :value="data.auto_albums ? 'an' : 'aus'"
            :severity="data.auto_albums ? 'success' : 'secondary'"
          />
        </template>
      </Column>
      <Column header="Favorit ab" style="width: 8rem" class="mobile-hidden" headerClass="mobile-hidden">
        <template #body="{ data }">
          <Tag
            v-if="data.favorite_rating_threshold > 0"
            :value="`≥ ${data.favorite_rating_threshold} ★`"
            severity="warn"
          />
          <Tag v-else value="aus" severity="secondary" />
        </template>
      </Column>
      <Column header="Letzter Scan" style="width: 10rem" class="mobile-hidden" headerClass="mobile-hidden">
        <template #body="{ data }">
          <span v-if="data.last_scan_at">{{ formatDateShort(data.last_scan_at) }}</span>
          <span v-else class="muted">—</span>
        </template>
      </Column>
      <Column header="Scan-Status" style="width: 10rem">
        <template #body="{ data }">
          <span v-if="!data.active_scan" class="muted">—</span>
          <span v-else-if="data.active_scan.status === 'processing'" class="scan-running">
            <ProgressSpinner style="width: 1.25rem; height: 1.25rem" stroke-width="5" />
            <span v-if="data.active_scan.reconcile">
              Abgleich läuft<template v-if="data.active_scan.scanned"> · {{ data.active_scan.scanned }} geprüft<template v-if="data.active_scan.errors"> ({{ data.active_scan.errors }} Fehler)</template></template>
            </span>
            <span v-else>
              Scan läuft<template v-if="data.active_scan.scanned"> · {{ data.active_scan.imported ?? 0 }} von {{ data.active_scan.scanned }} importiert<template v-if="data.active_scan.errors"> ({{ data.active_scan.errors }} Fehler)</template></template>
            </span>
          </span>
          <span v-else-if="data.active_scan.status === 'pending'" class="scan-running">
            <Tag :value="data.active_scan.reconcile ? 'Abgleich wartet' : 'Scan wartet'" severity="info" />
          </span>
          <span v-else-if="data.active_scan.status === 'failed'" class="scan-error">
            <Tag
              :value="data.active_scan.reconcile ? 'Abgleich Fehler' : 'Scan Fehler'"
              severity="danger"
              :class="data.active_scan.error_msg ? 'scan-error-clickable' : ''"
              v-tooltip="data.active_scan.error_msg ? 'Klicken für Details' : undefined"
              @click="data.active_scan.error_msg && openErrorDialog(data.active_scan.error_msg)"
            />
          </span>
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
              :loading="isBusy(data.id)"
              :disabled="isBusy(data.id)"
              v-tooltip="'Scan ausführen'"
              @click="runScan(data)"
            />
            <Button
              v-if="auth.hasPermission('photos.libraries.manage') && data.import_mode === 'link'"
              icon="pi pi-sync"
              severity="info"
              text
              rounded
              :loading="isBusy(data.id)"
              :disabled="isBusy(data.id)"
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
          <label>Pfad</label>
          <div v-if="editingId === null" class="picker">
            <div class="breadcrumb">
              <button
                type="button"
                class="crumb home"
                :disabled="!currentSub"
                v-tooltip="'Zur Wurzel wechseln'"
                @click="navigateTo('')"
              >
                <i class="pi pi-home" />
              </button>
              <template v-for="(seg, i) in pathSegments" :key="seg.sub">
                <span class="sep">/</span>
                <button
                  type="button"
                  class="crumb"
                  :disabled="i === pathSegments.length - 1"
                  @click="navigateTo(seg.sub)"
                >{{ seg.label }}</button>
              </template>
            </div>
            <div class="selected-row">
              <span class="muted small">Ausgewählt:</span>
              <code v-if="form.path" class="path">{{ form.path }}</code>
              <span v-else class="muted small"><em>nichts gewählt</em></span>
              <Button
                v-if="currentSub"
                :label="currentRegistered ? 'Aktueller Ordner bereits registriert' : 'Aktuellen Ordner wählen'"
                size="small"
                :disabled="currentRegistered"
                @click="selectCurrent"
              />
            </div>
            <ul class="dir-list">
              <li v-if="loadingPaths" class="muted small">Lade Verzeichnisse…</li>
              <li v-else-if="availablePaths.length === 0" class="muted small">
                Keine Unterverzeichnisse in <code>{{ currentAbs }}</code>.
              </li>
              <li
                v-for="dir in availablePaths"
                :key="dir.abs_path"
                class="dir-item"
                :class="{ selected: form.path === dir.rel_path }"
              >
                <button
                  type="button"
                  class="dir-name"
                  v-tooltip="'Reingehen'"
                  @click="navigateInto(dir)"
                >
                  <i
                    :class="dir.mounted ? 'pi pi-server mount-ok' : 'pi pi-folder mount-unknown'"
                  />
                  {{ dir.name }}
                </button>
                <span v-if="dir.already_registered" class="muted small">
                  (bereits registriert)
                </span>
                <Button
                  :label="form.path === dir.rel_path ? 'Gewählt' : 'Wählen'"
                  size="small"
                  :severity="form.path === dir.rel_path ? 'success' : undefined"
                  :disabled="dir.already_registered"
                  @click="selectDirectory(dir)"
                />
              </li>
            </ul>
          </div>
          <InputText
            v-else
            id="lib-path"
            v-model="form.path"
            autocomplete="off"
            disabled
          />
          <small v-if="editingId === null" class="hint-small">
            Beliebig tief unterhalb von
            <code>{{ availableRoot || 'PHOTO_LIBRARIES_ROOT' }}</code>.
            <span v-if="!loadingPaths">
              <span v-if="rootMounted" class="mount-ok">Volume-Mount unterhalb Root erkannt.</span>
              <span v-else class="mount-warn">
                Kein Volume-Mount unterhalb Root erkannt — ggf. in der Docker-Compose
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

        <div class="field row">
          <ToggleSwitch v-model="form.auto_albums" input-id="lib-auto-albums" />
          <label for="lib-auto-albums">
            Auto-Alben aus Unterverzeichnissen (voller Unterpfad = Albumname;
            Dateien direkt im Library-Wurzelverzeichnis kommen in ein Album
            mit dem Library-Namen)
          </label>
        </div>

        <div class="field">
          <label for="lib-fav-threshold">Favorit ab Rating (XMP-Sterne)</label>
          <InputNumber
            id="lib-fav-threshold"
            v-model="form.favorite_rating_threshold"
            :min="0"
            :max="5"
            show-buttons
            button-layout="horizontal"
            :step="1"
          />
          <small class="hint-small">
            0 deaktiviert die automatische Favoriten-Markierung. Beim Import wird
            zusätzlich ein Tag <code>Rating-1</code>…<code>Rating-5</code> aus
            dem XMP-Rating übernommen.
          </small>
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

    <!-- Scan Error Detail Dialog -->
    <Dialog
      v-model:visible="showErrorDialog"
      header="Fehlerdetails"
      :modal="true"
      :style="{ width: '520px' }"
    >
      <pre class="error-detail">{{ errorDialogMsg }}</pre>
      <template #footer>
        <Button label="Schließen" severity="secondary" @click="showErrorDialog = false" />
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

.multiline :deep(.p-message-text) {
  white-space: pre-line;
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
  align-items: flex-start;
  gap: 0.6rem;
  flex-wrap: wrap;
}

.field.row :deep(.p-toggleswitch) {
  flex-shrink: 0;
  margin-top: 2px;
}

.field.row label {
  flex: 1;
  min-width: 0;
  white-space: normal;
  line-height: 1.25;
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

.mount-ok {
  color: var(--p-green-500, #22c55e);
}

.mount-unknown {
  color: var(--p-text-muted-color);
}

.mount-warn {
  color: var(--p-orange-500, #f59e0b);
}

.picker {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  border: 1px solid var(--p-content-border-color);
  border-radius: 6px;
  padding: 0.5rem;
  background: var(--p-content-background);
}

.breadcrumb {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0;
  font-family: monospace;
  font-size: 0.85rem;
}

.breadcrumb .sep {
  color: var(--p-text-muted-color);
  padding: 0 0.1rem;
}

.crumb {
  background: none;
  border: 0;
  padding: 0.1rem 0.25rem;
  margin: 0;
  font: inherit;
  color: var(--p-primary-color, #3b82f6);
  cursor: pointer;
  border-radius: 3px;
}

.crumb:hover:not(:disabled) {
  background: var(--p-highlight-background, rgba(59, 130, 246, 0.1));
  text-decoration: underline;
}

.crumb:disabled {
  color: var(--p-text-color);
  cursor: default;
  font-weight: 600;
}

.crumb.home {
  display: inline-flex;
  align-items: center;
}

.selected-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
}

.dir-list {
  list-style: none;
  margin: 0;
  padding: 0;
  max-height: 240px;
  overflow-y: auto;
  border-top: 1px solid var(--p-content-border-color);
  padding-top: 0.25rem;
}

.dir-item {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.25rem 0.25rem;
  border-radius: 4px;
}

.dir-item.selected {
  background: var(--p-highlight-background, rgba(59, 130, 246, 0.1));
}

.dir-name {
  background: none;
  border: 0;
  padding: 0.1rem 0.3rem;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  color: inherit;
  font-size: 0.9rem;
  flex: 1;
  text-align: left;
}

.dir-name:hover {
  text-decoration: underline;
}

.scan-running {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  font-size: 0.85rem;
  color: var(--p-text-muted-color);
}

.scan-running :deep(.p-progressspinner-circle) {
  stroke: var(--p-primary-color);
}

.scan-error {
  display: inline-flex;
  align-items: center;
}

.scan-error-clickable {
  cursor: pointer;
}

.error-detail {
  margin: 0;
  font-family: monospace;
  font-size: 0.85rem;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--p-text-color);
  background: var(--p-content-background);
  border: 1px solid var(--p-content-border-color);
  border-radius: 4px;
  padding: 0.75rem;
  max-height: 60vh;
  overflow-y: auto;
}
</style>
