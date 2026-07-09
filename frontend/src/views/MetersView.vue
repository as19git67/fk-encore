<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
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
  listMeters,
  getMeter,
  createMeter,
  updateMeter,
  deleteMeter,
  replaceMeterDevice,
  listReadings,
  addReading,
  updateReading,
  deleteReading,
  METER_TYPE_LABELS,
  METER_TYPE_ICONS,
  type MeterListItem,
  type MeterDetail,
  type MeterType,
  type Reading,
} from '../api/meters'
import { listGroups, type GroupSummary } from '../api/documents'
import { useAuthStore } from '../stores/auth'
import { toLocalIsoDateTime } from '../utils/dateFormat'

const auth = useAuthStore()
const canManage = computed(() => auth.hasPermission('meters.manage'))
const canEnter = computed(() => auth.hasPermission('meters.read_entry'))

const meters = ref<MeterListItem[]>([])
const groups = ref<GroupSummary[]>([])
const loading = ref(false)
const error = ref('')

const typeOptions = (Object.keys(METER_TYPE_LABELS) as MeterType[]).map((value) => ({
  label: METER_TYPE_LABELS[value],
  value,
}))

// Sensible default unit per meter type, prefilled when creating.
const DEFAULT_UNIT: Record<MeterType, string> = {
  electricity: 'kWh',
  water: 'm³',
  gas: 'm³',
  operating_hours: 'h',
}

async function load() {
  loading.value = true
  error.value = ''
  try {
    const [mRes, gRes] = await Promise.all([listMeters(), loadGroups()])
    meters.value = mRes.meters
    groups.value = gRes
  } catch (err: any) {
    error.value = err.message || 'Fehler beim Laden der Zähler'
  } finally {
    loading.value = false
  }
}

async function loadGroups(): Promise<GroupSummary[]> {
  try {
    const res = await listGroups()
    return res.items
  } catch {
    // Groups are optional (a user may not use them); never block the page.
    return []
  }
}

const groupOptions = computed(() => [
  { label: 'Privat (nur ich)', value: null },
  ...groups.value.map((g) => ({ label: g.name, value: g.id })),
])

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

// ── Create / edit dialog ─────────────────────────────────────────────────────

interface MeterForm {
  id: number | null
  name: string
  type: MeterType
  unit: string
  location: string
  notes: string
  decimals: number
  groupId: number | null
  // Initial device (create only).
  deviceSerial: string
  deviceInstalledAt: Date
  deviceStartValue: number
}

const showForm = ref(false)
const saving = ref(false)
const form = ref<MeterForm>(emptyForm())

function emptyForm(): MeterForm {
  return {
    id: null,
    name: '',
    type: 'electricity',
    unit: DEFAULT_UNIT.electricity,
    location: '',
    notes: '',
    decimals: 1,
    groupId: null,
    deviceSerial: '',
    deviceInstalledAt: new Date(),
    deviceStartValue: 0,
  }
}

function openCreate() {
  form.value = emptyForm()
  showForm.value = true
}

function openEdit(m: MeterListItem) {
  form.value = {
    id: m.id,
    name: m.name,
    type: m.type,
    unit: m.unit,
    location: m.location ?? '',
    notes: m.notes ?? '',
    decimals: m.decimals,
    groupId: m.groupId,
    deviceSerial: '',
    deviceInstalledAt: new Date(),
    deviceStartValue: 0,
  }
  showForm.value = true
}

function onTypeChange() {
  // Only prefill the unit while creating and when it still matches a default,
  // so we never clobber a deliberately chosen unit on an existing meter.
  if (form.value.id === null) {
    form.value.unit = DEFAULT_UNIT[form.value.type]
  }
}

async function handleSave() {
  if (!form.value.name.trim()) {
    error.value = 'Name darf nicht leer sein'
    return
  }
  saving.value = true
  error.value = ''
  try {
    if (form.value.id === null) {
      await createMeter({
        name: form.value.name.trim(),
        type: form.value.type,
        unit: form.value.unit.trim(),
        location: form.value.location.trim() || undefined,
        notes: form.value.notes.trim() || undefined,
        decimals: form.value.decimals,
        groupId: form.value.groupId,
        device: {
          serialNumber: form.value.deviceSerial.trim() || undefined,
          installedAt: toLocalIsoDateTime(form.value.deviceInstalledAt),
          startValue: form.value.deviceStartValue,
        },
      })
    } else {
      await updateMeter(form.value.id, {
        name: form.value.name.trim(),
        type: form.value.type,
        unit: form.value.unit.trim(),
        location: form.value.location.trim() || undefined,
        notes: form.value.notes.trim() || undefined,
        decimals: form.value.decimals,
        groupId: form.value.groupId,
      })
    }
    showForm.value = false
    await load()
  } catch (err: any) {
    error.value = err.message || 'Fehler beim Speichern'
  } finally {
    saving.value = false
  }
}

async function handleDelete(m: MeterListItem) {
  if (!confirm(`Zähler „${m.name}" mit allen Geräten und Ablesungen löschen?`)) return
  error.value = ''
  try {
    await deleteMeter(m.id)
    if (detail.value?.id === m.id) detail.value = null
    await load()
  } catch (err: any) {
    error.value = err.message || 'Fehler beim Löschen'
  }
}

// ── Device history / replace ─────────────────────────────────────────────────

const detail = ref<MeterDetail | null>(null)
const loadingDetail = ref(false)

async function openDetail(m: MeterListItem) {
  loadingDetail.value = true
  error.value = ''
  try {
    detail.value = await getMeter(m.id)
    await loadReadings()
  } catch (err: any) {
    error.value = err.message || 'Fehler beim Laden der Details'
  } finally {
    loadingDetail.value = false
  }
}

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
    await Promise.all([load(), openDetail(detail.value)])
  } catch (err: any) {
    error.value = err.message || 'Fehler beim Gerätewechsel'
  } finally {
    replacing.value = false
  }
}

// ── Readings (Etappe 3) ──────────────────────────────────────────────────────

const readings = ref<Reading[]>([])
const loadingReadings = ref(false)

async function loadReadings() {
  if (!detail.value) return
  loadingReadings.value = true
  try {
    const res = await listReadings(detail.value.id)
    readings.value = res.readings
  } catch (err: any) {
    error.value = err.message || 'Fehler beim Laden der Ablesungen'
  } finally {
    loadingReadings.value = false
  }
}

const showReading = ref(false)
const savingReading = ref(false)
const readingForm = ref<{ id: number | null; value: number; takenAt: Date; notes: string }>({
  id: null,
  value: 0,
  takenAt: new Date(),
  notes: '',
})

/** Whether the caller may edit/delete a given reading. */
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
    await Promise.all([loadReadings(), refreshAfterReading()])
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
    await Promise.all([loadReadings(), refreshAfterReading()])
  } catch (err: any) {
    error.value = err.message || 'Fehler beim Löschen der Ablesung'
  }
}

/** Refresh the meter list + detail so last-reading / absolute totals update. */
async function refreshAfterReading() {
  if (!detail.value) return
  const id = detail.value.id
  await load()
  detail.value = await getMeter(id)
}

onMounted(load)
</script>

<template>
  <div class="meters-view">
    <div class="header">
      <h1>Zähler</h1>
      <Button
        v-if="canManage"
        label="Neuer Zähler"
        icon="pi pi-plus"
        @click="openCreate"
      />
    </div>

    <Message v-if="error" severity="error" @close="error = ''" closable>{{ error }}</Message>

    <div v-if="loading" class="info"><i class="pi pi-spin pi-spinner" /> Zähler werden geladen…</div>
    <div v-else-if="meters.length === 0" class="info">Noch keine Zähler angelegt.</div>

    <div v-else class="meter-grid">
      <div
        v-for="m in meters"
        :key="m.id"
        class="meter-card"
        :class="{ active: detail?.id === m.id }"
        @click="openDetail(m)"
      >
        <div class="meter-card-head">
          <i :class="typeIcon(m.type)" />
          <span class="meter-name">{{ m.name }}</span>
          <Tag :value="typeLabel(m.type)" severity="secondary" />
        </div>
        <div class="meter-meta">
          <span v-if="m.location"><i class="pi pi-map-marker" /> {{ m.location }}</span>
        </div>
        <div class="meter-figures">
          <div class="figure">
            <span class="figure-label">Letzter Stand</span>
            <span class="figure-value">{{ fmt(m.lastReadingValue, m.decimals) }} {{ m.unit }}</span>
            <span class="figure-sub">{{ fmtDateTime(m.lastReadingAt) }}</span>
          </div>
          <div class="figure">
            <span class="figure-label">Gesamt (absolut)</span>
            <span class="figure-value">{{ fmt(m.absoluteTotal, m.decimals) }} {{ m.unit }}</span>
          </div>
        </div>
        <div v-if="canManage || canEnter" class="meter-actions" @click.stop>
          <Button
            v-if="canEnter"
            icon="pi pi-plus-circle"
            text
            rounded
            severity="primary"
            v-tooltip.top="'Ablesen'"
            @click="openDetail(m).then(openReadingEntry)"
          />
          <Button v-if="canManage" icon="pi pi-pencil" text rounded severity="secondary" v-tooltip.top="'Bearbeiten'" @click="openEdit(m)" />
          <Button v-if="canManage" icon="pi pi-trash" text rounded severity="danger" v-tooltip.top="'Löschen'" @click="handleDelete(m)" />
        </div>
      </div>
    </div>

    <!-- Device history -->
    <div v-if="loadingDetail" class="info"><i class="pi pi-spin pi-spinner" /> Details…</div>
    <div v-else-if="detail" class="detail-panel">
      <div class="detail-header">
        <h2><i :class="typeIcon(detail.type)" /> {{ detail.name }} — Gerätehistorie</h2>
        <Button
          v-if="canManage"
          label="Gerät ersetzen"
          icon="pi pi-refresh"
          size="small"
          @click="openReplace"
        />
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
          <template #body="{ data }">{{ fmt(data.startValue, detail.decimals) }}</template>
        </Column>
        <Column header="Endwert">
          <template #body="{ data }">{{ data.endValue === null ? '–' : fmt(data.endValue, detail.decimals) }}</template>
        </Column>
        <Column header="Status">
          <template #body="{ data }">
            <Tag :value="data.active ? 'aktiv' : 'ersetzt'" :severity="data.active ? 'success' : 'secondary'" />
          </template>
        </Column>
      </DataTable>

      <!-- Readings -->
      <div class="detail-header readings-header">
        <h2><i class="pi pi-list" /> Ablesungen</h2>
        <Button
          v-if="canEnter"
          label="Neue Ablesung"
          icon="pi pi-plus"
          size="small"
          @click="openReadingEntry"
        />
      </div>
      <div v-if="loadingReadings" class="info"><i class="pi pi-spin pi-spinner" /> Ablesungen…</div>
      <div v-else-if="readings.length === 0" class="info">Noch keine Ablesungen erfasst.</div>
      <DataTable v-else :value="readings" size="small" paginator :rows="10">
        <Column header="Datum">
          <template #body="{ data }">{{ fmtDateTime(data.takenAt) }}</template>
        </Column>
        <Column header="Wert">
          <template #body="{ data }">{{ fmt(data.value, detail.decimals) }} {{ detail.unit }}</template>
        </Column>
        <Column header="Absolut">
          <template #body="{ data }">{{ fmt(data.absoluteValue, detail.decimals) }} {{ detail.unit }}</template>
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
    </div>

    <!-- Create / edit dialog -->
    <Dialog
      v-model:visible="showForm"
      :header="form.id === null ? 'Neuer Zähler' : 'Zähler bearbeiten'"
      modal
      :style="{ width: '32rem' }"
    >
      <div class="form-grid">
        <label>Name
          <InputText v-model="form.name" autofocus />
        </label>
        <label>Typ
          <Select v-model="form.type" :options="typeOptions" option-label="label" option-value="value" @change="onTypeChange" />
        </label>
        <label>Einheit
          <InputText v-model="form.unit" />
        </label>
        <label>Standort
          <InputText v-model="form.location" />
        </label>
        <label>Nachkommastellen
          <InputNumber v-model="form.decimals" :min="0" :max="3" show-buttons />
        </label>
        <label>Sichtbarkeit
          <Select v-model="form.groupId" :options="groupOptions" option-label="label" option-value="value" />
        </label>
        <label class="full">Notizen
          <Textarea v-model="form.notes" rows="2" auto-resize />
        </label>

        <template v-if="form.id === null">
          <div class="section-title full">Erstes Gerät</div>
          <label>Seriennummer
            <InputText v-model="form.deviceSerial" />
          </label>
          <label>Eingebaut am
            <DatePicker v-model="form.deviceInstalledAt" show-time hour-format="24" date-format="dd.mm.yy" />
          </label>
          <label>Startwert
            <InputNumber v-model="form.deviceStartValue" :min-fraction-digits="0" :max-fraction-digits="3" />
          </label>
        </template>
      </div>
      <template #footer>
        <Button label="Abbrechen" text @click="showForm = false" />
        <Button label="Speichern" icon="pi pi-check" :loading="saving" @click="handleSave" />
      </template>
    </Dialog>

    <!-- Replace-device dialog -->
    <Dialog v-model:visible="showReplace" header="Gerät ersetzen" modal :style="{ width: '30rem' }">
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
      :style="{ width: '26rem' }"
    >
      <div class="form-grid">
        <label>Zeitpunkt
          <DatePicker v-model="readingForm.takenAt" show-time hour-format="24" date-format="dd.mm.yy" />
        </label>
        <label>Zählerstand
          <InputNumber v-model="readingForm.value" :min-fraction-digits="0" :max-fraction-digits="3" autofocus />
        </label>
        <label class="full">Notiz
          <Textarea v-model="readingForm.notes" rows="2" auto-resize />
        </label>
      </div>
      <template #footer>
        <Button label="Abbrechen" text @click="showReading = false" />
        <Button label="Speichern" icon="pi pi-check" :loading="savingReading" @click="handleSaveReading" />
      </template>
    </Dialog>
  </div>
</template>

<style scoped>
.meters-view {
  padding: 1rem;
  max-width: 1100px;
  margin: 0 auto;
}
.header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 1rem;
}
.header h1 {
  margin: 0;
}
.info {
  padding: 2rem;
  text-align: center;
  color: var(--p-text-muted-color);
}
.meter-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 1rem;
}
.meter-card {
  border: 1px solid var(--p-content-border-color);
  border-radius: 8px;
  padding: 1rem;
  background: var(--p-content-background);
  cursor: pointer;
  transition: background 0.15s;
}
.meter-card:hover {
  background: var(--p-content-hover-background);
}
.meter-card.active {
  border-color: var(--p-primary-color);
}
.meter-card-head {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 0.5rem;
}
.meter-name {
  font-weight: 600;
  flex: 1;
}
.meter-meta {
  color: var(--p-text-muted-color);
  font-size: 0.85rem;
  min-height: 1.2rem;
  margin-bottom: 0.75rem;
}
.meter-meta i {
  margin-right: 0.25rem;
}
.meter-figures {
  display: flex;
  gap: 1rem;
}
.figure {
  display: flex;
  flex-direction: column;
  flex: 1;
}
.figure-label {
  font-size: 0.75rem;
  color: var(--p-text-muted-color);
}
.figure-value {
  font-weight: 600;
  font-size: 1.05rem;
}
.figure-sub {
  font-size: 0.7rem;
  color: var(--p-text-muted-color);
}
.meter-actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.25rem;
  margin-top: 0.5rem;
}
.detail-panel {
  margin-top: 1.5rem;
  border-top: 1px solid var(--p-content-border-color);
  padding-top: 1rem;
}
.detail-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 0.75rem;
}
.detail-header h2 {
  margin: 0;
  font-size: 1.15rem;
}
.detail-header h2 i {
  margin-right: 0.4rem;
}
.readings-header {
  margin-top: 1.5rem;
}
.reading-actions {
  display: flex;
  gap: 0.15rem;
  justify-content: flex-end;
}
.form-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.75rem;
}
.form-grid label {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  font-size: 0.85rem;
  color: var(--p-text-muted-color);
}
.form-grid label.full {
  grid-column: 1 / -1;
}
.section-title {
  font-weight: 600;
  color: var(--p-text-color);
  margin-top: 0.5rem;
}
.hint {
  color: var(--p-text-muted-color);
  font-size: 0.85rem;
  margin: 0 0 0.75rem;
}
</style>
