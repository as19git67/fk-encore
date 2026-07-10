<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import Button from 'primevue/button'
import InputText from 'primevue/inputtext'
import InputNumber from 'primevue/inputnumber'
import Textarea from 'primevue/textarea'
import Select from 'primevue/select'
import DatePicker from 'primevue/datepicker'
import Dialog from 'primevue/dialog'
import Message from 'primevue/message'
import DataTable from 'primevue/datatable'
import Column from 'primevue/column'
import Tag from 'primevue/tag'
import {
  getMeter,
  updateMeter,
  deleteMeter,
  replaceMeterDevice,
  listReadings,
  addReading,
  updateReading,
  deleteReading,
  listApiKeys,
  createApiKey,
  deleteApiKey,
  ocrMeterReading,
  METER_TYPE_LABELS,
  METER_TYPE_ICONS,
  type MeterDetail,
  type MeterType,
  type Reading,
  type ApiKey,
} from '../api/meters'
import { listGroups, type GroupSummary } from '../api/documents'
import { useAuthStore } from '../stores/auth'
import { toLocalIsoDateTime } from '../utils/dateFormat'

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()
const canManage = computed(() => auth.hasPermission('meters.manage'))
const canEnter = computed(() => auth.hasPermission('meters.read_entry'))

const meterId = computed(() => Number(route.params.id))

const detail = ref<MeterDetail | null>(null)
const groups = ref<GroupSummary[]>([])
const loading = ref(false)
const error = ref('')

const typeOptions = (Object.keys(METER_TYPE_LABELS) as MeterType[]).map((value) => ({
  label: METER_TYPE_LABELS[value],
  value,
}))

function typeLabel(t: MeterType) {
  return METER_TYPE_LABELS[t]
}
function typeIcon(t: MeterType) {
  return METER_TYPE_ICONS[t]
}
function fmt(value: number | null, decimals: number) {
  if (value === null) return '–'
  return value.toLocaleString('de-DE', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })
}
function fmtDateTime(iso: string | null) {
  if (!iso) return '–'
  return new Date(iso).toLocaleString('de-DE')
}

async function loadGroups(): Promise<GroupSummary[]> {
  try {
    const res = await listGroups()
    return res.items
  } catch {
    return []
  }
}

const groupOptions = computed(() => [
  { label: 'Privat (nur ich)', value: null },
  ...groups.value.map((g) => ({ label: g.name, value: g.id })),
])

async function loadDetail() {
  loading.value = true
  error.value = ''
  try {
    detail.value = await getMeter(meterId.value)
    await Promise.all([
      loadReadings(),
      canManage.value ? loadApiKeys() : Promise.resolve(),
    ])
  } catch (err: any) {
    error.value = err.message || 'Fehler beim Laden'
  } finally {
    loading.value = false
  }
}

// ── Edit dialog ──────────────────────────────────────────────────────────────

interface EditForm {
  name: string
  type: MeterType
  unit: string
  location: string
  notes: string
  decimals: number
  groupId: number | null
}

const showEdit = ref(false)
const saving = ref(false)
const editForm = ref<EditForm>({
  name: '',
  type: 'electricity',
  unit: '',
  location: '',
  notes: '',
  decimals: 1,
  groupId: null,
})

function openEdit() {
  if (!detail.value) return
  editForm.value = {
    name: detail.value.name,
    type: detail.value.type,
    unit: detail.value.unit,
    location: detail.value.location ?? '',
    notes: detail.value.notes ?? '',
    decimals: detail.value.decimals,
    groupId: detail.value.groupId,
  }
  showEdit.value = true
}

async function handleSave() {
  if (!detail.value || !editForm.value.name.trim()) {
    error.value = 'Name darf nicht leer sein'
    return
  }
  saving.value = true
  error.value = ''
  try {
    await updateMeter(detail.value.id, {
      name: editForm.value.name.trim(),
      type: editForm.value.type,
      unit: editForm.value.unit.trim(),
      location: editForm.value.location.trim() || undefined,
      notes: editForm.value.notes.trim() || undefined,
      decimals: editForm.value.decimals,
      groupId: editForm.value.groupId,
    })
    showEdit.value = false
    await loadDetail()
  } catch (err: any) {
    error.value = err.message || 'Fehler beim Speichern'
  } finally {
    saving.value = false
  }
}

async function handleDelete() {
  if (!detail.value) return
  if (!confirm(`Zähler „${detail.value.name}“ mit allen Geräten und Ablesungen löschen?`)) return
  error.value = ''
  try {
    await deleteMeter(detail.value.id)
    router.push({ name: 'zaehler-list' })
  } catch (err: any) {
    error.value = err.message || 'Fehler beim Löschen'
  }
}

// ── Device replace ───────────────────────────────────────────────────────────

const showReplace = ref(false)
const replacing = ref(false)
const replaceForm = ref({
  swapAt: new Date(),
  finalValue: 0,
  newSerial: '',
  newStartValue: 0,
})

function openReplace() {
  if (!detail.value) return
  const active = detail.value.devices.find((d) => d.active)
  replaceForm.value = {
    swapAt: new Date(),
    finalValue: active?.startValue ?? 0,
    newSerial: '',
    newStartValue: 0,
  }
  showReplace.value = true
}

async function handleReplace() {
  if (!detail.value) return
  replacing.value = true
  error.value = ''
  try {
    await replaceMeterDevice(detail.value.id, {
      swapAt: toLocalIsoDateTime(replaceForm.value.swapAt),
      finalValue: replaceForm.value.finalValue,
      newSerialNumber: replaceForm.value.newSerial.trim() || undefined,
      newStartValue: replaceForm.value.newStartValue,
    })
    showReplace.value = false
    await loadDetail()
  } catch (err: any) {
    error.value = err.message || 'Fehler beim Gerätewechsel'
  } finally {
    replacing.value = false
  }
}

// ── Readings ─────────────────────────────────────────────────────────────────

const readings = ref<Reading[]>([])
const totalReadings = ref(0)
const readingsFirst = ref(0)
const readingsRows = 20
const loadingReadings = ref(false)

async function loadReadings(offset = 0) {
  if (!detail.value) return
  loadingReadings.value = true
  try {
    const res = await listReadings(detail.value.id, readingsRows, offset)
    readings.value = res.readings
    totalReadings.value = res.total
    readingsFirst.value = offset
  } catch (err: any) {
    error.value = err.message || 'Fehler beim Laden der Ablesungen'
  } finally {
    loadingReadings.value = false
  }
}

function onReadingsPage(event: { first: number }) {
  loadReadings(event.first)
}

const showReading = ref(false)
const savingReading = ref(false)
const readingForm = ref<{ id: number | null; value: number; takenAt: Date; notes: string }>({
  id: null,
  value: 0,
  takenAt: new Date(),
  notes: '',
})

function canEditReading(r: Reading): boolean {
  if (canManage.value) return true
  return canEnter.value && r.enteredBy === (auth.user?.id ?? -1)
}

function openReadingEntry() {
  readingForm.value = { id: null, value: 0, takenAt: new Date(), notes: '' }
  showReading.value = true
}

function openReadingEdit(r: Reading) {
  readingForm.value = {
    id: r.id,
    value: r.value,
    takenAt: new Date(r.takenAt),
    notes: r.notes ?? '',
  }
  showReading.value = true
}

async function handleSaveReading() {
  if (!detail.value) return
  savingReading.value = true
  error.value = ''
  try {
    if (readingForm.value.id === null) {
      await addReading(detail.value.id, {
        value: readingForm.value.value,
        takenAt: toLocalIsoDateTime(readingForm.value.takenAt),
        notes: readingForm.value.notes.trim() || undefined,
      })
    } else {
      await updateReading(readingForm.value.id, {
        value: readingForm.value.value,
        takenAt: toLocalIsoDateTime(readingForm.value.takenAt),
        notes: readingForm.value.notes.trim() || undefined,
      })
    }
    showReading.value = false
    await loadDetail()
  } catch (err: any) {
    error.value = err.message || 'Fehler beim Speichern der Ablesung'
  } finally {
    savingReading.value = false
  }
}

async function handleDeleteReading(r: Reading) {
  if (!confirm('Ablesung wirklich löschen?')) return
  error.value = ''
  try {
    await deleteReading(r.id)
    await loadDetail()
  } catch (err: any) {
    error.value = err.message || 'Fehler beim Löschen der Ablesung'
  }
}

// ── OCR photo capture ────────────────────────────────────────────────────────

const ocrLoading = ref(false)
const ocrError = ref('')
const ocrFileInput = ref<HTMLInputElement | null>(null)

function triggerOcrUpload() {
  ocrFileInput.value?.click()
}

async function handleOcrFile(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0]
  if (!file || !detail.value) return
  ocrLoading.value = true
  ocrError.value = ''
  try {
    const result = await ocrMeterReading(detail.value.id, file)
    if (result.value !== null) {
      readingForm.value.value = result.value
      readingForm.value.notes = `OCR (${Math.round(result.confidence * 100)}%)`
    } else {
      ocrError.value = 'Kein Zählerstand erkannt. Bitte manuell eingeben.'
    }
  } catch (err: any) {
    ocrError.value = err.message || 'OCR-Dienst nicht erreichbar'
  } finally {
    ocrLoading.value = false
    if (ocrFileInput.value) ocrFileInput.value.value = ''
  }
}

// ── API keys ─────────────────────────────────────────────────────────────────

const apiKeys = ref<ApiKey[]>([])
const loadingKeys = ref(false)
const showCreateKey = ref(false)
const creatingKey = ref(false)
const newKeyName = ref('')
const newKeyToken = ref('')

async function loadApiKeys() {
  if (!detail.value) return
  loadingKeys.value = true
  try {
    const res = await listApiKeys(detail.value.id)
    apiKeys.value = res.keys
  } catch {
    apiKeys.value = []
  } finally {
    loadingKeys.value = false
  }
}

function openCreateKey() {
  newKeyName.value = ''
  newKeyToken.value = ''
  showCreateKey.value = true
}

async function handleCreateKey() {
  if (!detail.value || !newKeyName.value.trim()) return
  creatingKey.value = true
  error.value = ''
  try {
    const result = await createApiKey(detail.value.id, newKeyName.value.trim())
    newKeyToken.value = result.token
    await loadApiKeys()
  } catch (err: any) {
    error.value = err.message || 'Fehler beim Erstellen des API-Keys'
  } finally {
    creatingKey.value = false
  }
}

async function handleDeleteKey(key: ApiKey) {
  if (!confirm(`API-Key „${key.name}“ wirklich löschen?`)) return
  error.value = ''
  try {
    await deleteApiKey(key.id)
    await loadApiKeys()
  } catch (err: any) {
    error.value = err.message || 'Fehler beim Löschen des API-Keys'
  }
}

function copyToken() {
  if (newKeyToken.value) navigator.clipboard.writeText(newKeyToken.value)
}

onMounted(async () => {
  groups.value = await loadGroups()
  await loadDetail()
})

watch(meterId, () => loadDetail())
</script>

<template>
  <div class="meter-detail-view">
    <div v-if="loading" class="info"><i class="pi pi-spin pi-spinner" /> Wird geladen…</div>
    <template v-else-if="detail">
      <!-- Header -->
      <div class="detail-top">
        <Button icon="pi pi-arrow-left" text rounded severity="secondary" @click="router.push({ name: 'zaehler-list' })" v-tooltip.right="'Zurück'" />
        <div class="detail-title">
          <h1><i :class="typeIcon(detail.type)" /> {{ detail.name }}</h1>
          <div class="detail-subtitle">
            <Tag :value="typeLabel(detail.type)" severity="secondary" />
            <span v-if="detail.location"><i class="pi pi-map-marker" /> {{ detail.location }}</span>
          </div>
        </div>
        <div class="detail-top-actions">
          <Button v-if="canEnter" label="Neue Ablesung" icon="pi pi-plus" size="small" @click="openReadingEntry" />
          <Button v-if="canManage" icon="pi pi-pencil" text rounded severity="secondary" v-tooltip.top="'Bearbeiten'" @click="openEdit" />
          <Button v-if="canManage" icon="pi pi-trash" text rounded severity="danger" v-tooltip.top="'Löschen'" @click="handleDelete" />
        </div>
      </div>

      <!-- Figures -->
      <div class="figures-bar">
        <div class="figure">
          <span class="figure-label">Letzter Stand</span>
          <span class="figure-value">{{ fmt(detail.lastReadingValue, detail.decimals) }} {{ detail.unit }}</span>
          <span class="figure-sub">{{ fmtDateTime(detail.lastReadingAt) }}</span>
        </div>
        <div class="figure">
          <span class="figure-label">Gesamt (absolut)</span>
          <span class="figure-value">{{ fmt(detail.absoluteTotal, detail.decimals) }} {{ detail.unit }}</span>
        </div>
        <div class="figure">
          <span class="figure-label">Aktives Gerät</span>
          <span class="figure-value">{{ detail.activeDeviceSerial ?? '–' }}</span>
        </div>
      </div>

      <Message v-if="error" severity="error" @close="error = ''" closable>{{ error }}</Message>

      <!-- Device history -->
      <div class="section-header">
        <h2><i class="pi pi-cog" /> Gerätehistorie</h2>
        <Button v-if="canManage" label="Gerät ersetzen" icon="pi pi-refresh" size="small" @click="openReplace" />
      </div>
      <DataTable :value="detail.devices" size="small">
        <Column field="serialNumber" header="Seriennummer">
          <template #body="{ data }">{{ data.serialNumber ?? '–' }}</template>
        </Column>
        <Column header="Von">
          <template #body="{ data }">{{ fmtDateTime(data.installedAt) }}</template>
        </Column>
        <Column header="Bis">
          <template #body="{ data }">{{ data.removedAt ? fmtDateTime(data.removedAt) : 'aktiv' }}</template>
        </Column>
        <Column header="Startwert">
          <template #body="{ data }">{{ fmt(data.startValue, detail!.decimals) }}</template>
        </Column>
        <Column header="Endwert">
          <template #body="{ data }">{{ data.endValue === null ? '–' : fmt(data.endValue, detail!.decimals) }}</template>
        </Column>
        <Column header="Status">
          <template #body="{ data }">
            <Tag :value="data.active ? 'aktiv' : 'ersetzt'" :severity="data.active ? 'success' : 'secondary'" />
          </template>
        </Column>
      </DataTable>

      <!-- Readings -->
      <div class="section-header">
        <h2><i class="pi pi-list" /> Ablesungen</h2>
        <Button v-if="canEnter" label="Neue Ablesung" icon="pi pi-plus" size="small" @click="openReadingEntry" />
      </div>
      <div v-if="loadingReadings" class="info"><i class="pi pi-spin pi-spinner" /> Ablesungen…</div>
      <div v-else-if="readings.length === 0" class="info">Noch keine Ablesungen erfasst.</div>
      <DataTable v-else :value="readings" size="small" lazy paginator :rows="readingsRows" :total-records="totalReadings" :first="readingsFirst" @page="onReadingsPage">
        <Column header="Datum">
          <template #body="{ data }">{{ fmtDateTime(data.takenAt) }}</template>
        </Column>
        <Column header="Wert">
          <template #body="{ data }">{{ fmt(data.value, detail!.decimals) }} {{ detail!.unit }}</template>
        </Column>
        <Column header="Absolut">
          <template #body="{ data }">{{ fmt(data.absoluteValue, detail!.decimals) }} {{ detail!.unit }}</template>
        </Column>
        <Column header="Quelle">
          <template #body="{ data }">
            <Tag :value="data.source" severity="secondary" />
          </template>
        </Column>
        <Column field="notes" header="Notiz">
          <template #body="{ data }">{{ data.notes ?? '' }}</template>
        </Column>
        <Column style="width: 6rem">
          <template #body="{ data }">
            <div class="reading-actions" v-if="canEditReading(data)">
              <Button icon="pi pi-pencil" text rounded size="small" severity="secondary" v-tooltip.left="'Bearbeiten'" @click="openReadingEdit(data)" />
              <Button icon="pi pi-trash" text rounded size="small" severity="danger" v-tooltip.left="'Löschen'" @click="handleDeleteReading(data)" />
            </div>
          </template>
        </Column>
      </DataTable>

      <!-- API keys -->
      <template v-if="canManage">
        <div class="section-header">
          <h2><i class="pi pi-key" /> API-Keys</h2>
          <Button label="Neuer Key" icon="pi pi-plus" size="small" @click="openCreateKey" />
        </div>
        <div v-if="loadingKeys" class="info"><i class="pi pi-spin pi-spinner" /> Keys…</div>
        <div v-else-if="apiKeys.length === 0" class="info">Keine API-Keys vorhanden.</div>
        <DataTable v-else :value="apiKeys" size="small">
          <Column field="name" header="Name" />
          <Column header="Erstellt">
            <template #body="{ data }">{{ fmtDateTime(data.createdAt) }}</template>
          </Column>
          <Column header="Zuletzt genutzt">
            <template #body="{ data }">{{ data.lastUsedAt ? fmtDateTime(data.lastUsedAt) : 'nie' }}</template>
          </Column>
          <Column header="Status">
            <template #body="{ data }">
              <Tag :value="data.disabledAt ? 'deaktiviert' : 'aktiv'" :severity="data.disabledAt ? 'danger' : 'success'" />
            </template>
          </Column>
          <Column style="width: 4rem">
            <template #body="{ data }">
              <Button icon="pi pi-trash" text rounded size="small" severity="danger" v-tooltip.left="'Löschen'" @click="handleDeleteKey(data)" />
            </template>
          </Column>
        </DataTable>
      </template>
    </template>
    <div v-else class="info">Zähler nicht gefunden.</div>

    <!-- Edit dialog -->
    <Dialog v-model:visible="showEdit" header="Zähler bearbeiten" modal :style="{ width: '32rem', maxWidth: '95vw' }">
      <div class="form-grid">
        <label>Name
          <InputText v-model="editForm.name" autofocus />
        </label>
        <label>Typ
          <Select v-model="editForm.type" :options="typeOptions" option-label="label" option-value="value" />
        </label>
        <label>Einheit
          <InputText v-model="editForm.unit" />
        </label>
        <label>Standort
          <InputText v-model="editForm.location" />
        </label>
        <label>Nachkommastellen
          <InputNumber v-model="editForm.decimals" :min="0" :max="3" show-buttons />
        </label>
        <label>Sichtbarkeit
          <Select v-model="editForm.groupId" :options="groupOptions" option-label="label" option-value="value" />
        </label>
        <label class="full">Notizen
          <Textarea v-model="editForm.notes" rows="2" auto-resize />
        </label>
      </div>
      <template #footer>
        <Button label="Abbrechen" text @click="showEdit = false" />
        <Button label="Speichern" icon="pi pi-check" :loading="saving" @click="handleSave" />
      </template>
    </Dialog>

    <!-- Replace device dialog -->
    <Dialog v-model:visible="showReplace" header="Gerät ersetzen" modal :style="{ width: '30rem', maxWidth: '95vw' }">
      <p class="hint">
        Das aktuelle Gerät wird mit dem Endstand abgeschlossen; das neue Gerät startet
        beim angegebenen Wert. Der absolute Gesamtstand bleibt dadurch fortlaufend.
      </p>
      <div class="form-grid">
        <label>Wechsel am
          <DatePicker v-model="replaceForm.swapAt" show-time hour-format="24" date-format="dd.mm.yy" />
        </label>
        <label>Endstand altes Gerät
          <InputNumber v-model="replaceForm.finalValue" :min-fraction-digits="0" :max-fraction-digits="3" />
        </label>
        <label>Seriennummer neu
          <InputText v-model="replaceForm.newSerial" />
        </label>
        <label>Startwert neu
          <InputNumber v-model="replaceForm.newStartValue" :min-fraction-digits="0" :max-fraction-digits="3" />
        </label>
      </div>
      <template #footer>
        <Button label="Abbrechen" text @click="showReplace = false" />
        <Button label="Ersetzen" icon="pi pi-refresh" :loading="replacing" @click="handleReplace" />
      </template>
    </Dialog>

    <!-- Reading entry / edit dialog -->
    <Dialog
      v-model:visible="showReading"
      :header="readingForm.id === null ? 'Neue Ablesung' : 'Ablesung bearbeiten'"
      modal
      :style="{ width: '26rem', maxWidth: '95vw' }"
    >
      <div class="form-grid form-grid--stack">
        <label>Zeitpunkt
          <DatePicker v-model="readingForm.takenAt" show-time hour-format="24" date-format="dd.mm.yy" />
        </label>
        <label>Zählerstand
          <div class="ocr-row">
            <InputNumber v-model="readingForm.value" :min-fraction-digits="0" :max-fraction-digits="3" autofocus class="ocr-input" />
            <Button
              v-if="readingForm.id === null"
              icon="pi pi-camera"
              severity="secondary"
              v-tooltip.top="'Foto-Erkennung'"
              :loading="ocrLoading"
              @click="triggerOcrUpload"
            />
          </div>
        </label>
        <Message v-if="ocrError" severity="warn" :closable="false" class="ocr-msg">{{ ocrError }}</Message>
        <label>Notiz
          <Textarea v-model="readingForm.notes" rows="2" auto-resize />
        </label>
      </div>
      <input ref="ocrFileInput" type="file" accept="image/*" capture="environment" style="display:none" @change="handleOcrFile" />
      <template #footer>
        <Button label="Abbrechen" text @click="showReading = false" />
        <Button label="Speichern" icon="pi pi-check" :loading="savingReading" @click="handleSaveReading" />
      </template>
    </Dialog>

    <!-- Create API key dialog -->
    <Dialog v-model:visible="showCreateKey" header="Neuer API-Key" modal :style="{ width: '28rem', maxWidth: '95vw' }">
      <template v-if="!newKeyToken">
        <div class="form-grid form-grid--stack">
          <label>Bezeichnung
            <InputText v-model="newKeyName" autofocus placeholder="z.B. Shelly EM" />
          </label>
        </div>
      </template>
      <template v-else>
        <p class="hint">Der Token wird nur einmal angezeigt. Jetzt kopieren!</p>
        <div class="token-display">
          <code>{{ newKeyToken }}</code>
          <Button icon="pi pi-copy" text rounded severity="secondary" v-tooltip.top="'Kopieren'" @click="copyToken" />
        </div>
      </template>
      <template #footer>
        <template v-if="!newKeyToken">
          <Button label="Abbrechen" text @click="showCreateKey = false" />
          <Button label="Erstellen" icon="pi pi-plus" :loading="creatingKey" :disabled="!newKeyName.trim()" @click="handleCreateKey" />
        </template>
        <template v-else>
          <Button label="Schließen" @click="showCreateKey = false" />
        </template>
      </template>
    </Dialog>
  </div>
</template>

<style scoped>
.meter-detail-view {
  padding: 1rem;
  max-width: 1100px;
  margin: 0 auto;
}
.info {
  padding: 2rem;
  text-align: center;
  color: var(--p-text-muted-color);
}
.detail-top {
  display: flex;
  align-items: flex-start;
  gap: 0.75rem;
  margin-bottom: 1rem;
}
.detail-title {
  flex: 1;
}
.detail-title h1 {
  margin: 0;
  font-size: 1.4rem;
}
.detail-title h1 i {
  margin-right: 0.4rem;
}
.detail-subtitle {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  margin-top: 0.25rem;
  color: var(--p-text-muted-color);
  font-size: 0.85rem;
}
.detail-subtitle i {
  margin-right: 0.2rem;
}
.detail-top-actions {
  display: flex;
  gap: 0.25rem;
  align-items: center;
}
.figures-bar {
  display: flex;
  gap: 1.5rem;
  margin-bottom: 1.5rem;
  padding: 1rem;
  background: var(--p-content-background);
  border: 1px solid var(--p-content-border-color);
  border-radius: 8px;
  flex-wrap: wrap;
}
.figure {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 120px;
}
.figure-label {
  font-size: 0.75rem;
  color: var(--p-text-muted-color);
}
.figure-value {
  font-weight: 600;
  font-size: 1.1rem;
}
.figure-sub {
  font-size: 0.7rem;
  color: var(--p-text-muted-color);
}
.section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin: 1.5rem 0 0.75rem;
}
.section-header h2 {
  margin: 0;
  font-size: 1.15rem;
}
.section-header h2 i {
  margin-right: 0.4rem;
}
.reading-actions {
  display: flex;
  gap: 0.15rem;
  justify-content: flex-end;
}
.form-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0.75rem;
}
@media (max-width: 480px) {
  .form-grid {
    grid-template-columns: 1fr;
  }
}
.form-grid--stack {
  grid-template-columns: 1fr;
}
.form-grid label {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  font-size: 0.85rem;
  color: var(--p-text-muted-color);
  min-width: 0;
}
.form-grid label.full {
  grid-column: 1 / -1;
}
.form-grid label > :deep(.p-inputtext),
.form-grid label > :deep(.p-select),
.form-grid label > :deep(.p-datepicker),
.form-grid label > :deep(.p-inputnumber),
.form-grid label > :deep(.p-textarea) {
  width: 100%;
}
.form-grid :deep(.p-inputnumber-input),
.form-grid :deep(.p-datepicker-input) {
  width: 100%;
}
.hint {
  color: var(--p-text-muted-color);
  font-size: 0.85rem;
  margin: 0 0 0.75rem;
}
.ocr-row {
  display: flex;
  gap: 0.5rem;
  align-items: flex-start;
}
.ocr-input {
  flex: 1;
  min-width: 0;
}
.ocr-msg {
  margin: 0;
}
.token-display {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  background: var(--p-content-hover-background);
  border: 1px solid var(--p-content-border-color);
  border-radius: 6px;
  padding: 0.5rem 0.75rem;
  word-break: break-all;
}
.token-display code {
  flex: 1;
  font-size: 0.8rem;
}
</style>
