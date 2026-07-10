<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import Button from 'primevue/button'
import InputText from 'primevue/inputtext'
import InputNumber from 'primevue/inputnumber'
import Textarea from 'primevue/textarea'
import Select from 'primevue/select'
import DatePicker from 'primevue/datepicker'
import Dialog from 'primevue/dialog'
import Message from 'primevue/message'
import Tag from 'primevue/tag'
import {
  listMeters,
  createMeter,
  updateMeter,
  deleteMeter,
  importWaterHistory,
  importElectricityHistory,
  METER_TYPE_LABELS,
  METER_TYPE_ICONS,
  type MeterListItem,
  type MeterType,
} from '../api/meters'
import { listGroups, type GroupSummary } from '../api/documents'
import { useAuthStore } from '../stores/auth'
import { toLocalIsoDateTime } from '../utils/dateFormat'

const router = useRouter()
const auth = useAuthStore()
const canManage = computed(() => auth.hasPermission('meters.manage'))

const meters = ref<MeterListItem[]>([])
const groups = ref<GroupSummary[]>([])
const loading = ref(false)
const error = ref('')

const typeOptions = (Object.keys(METER_TYPE_LABELS) as MeterType[]).map((value) => ({
  label: METER_TYPE_LABELS[value],
  value,
}))

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

function openDetail(m: MeterListItem) {
  router.push({ name: 'zaehler-detail', params: { id: m.id } })
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
    await load()
  } catch (err: any) {
    error.value = err.message || 'Fehler beim Löschen'
  }
}

// ── History imports ─────────────────────────────────────────────────────────

const importingWater = ref(false)
const importingElec = ref(false)
const importMsg = ref('')

const showWaterImport = computed(
  () => canManage.value && !meters.value.some((m) => m.type === 'water' && m.name === 'Wasser'),
)
const showElecImport = computed(
  () => canManage.value && !meters.value.some((m) => m.type === 'electricity' && m.name === 'Hausstrom'),
)

async function handleImportWater() {
  importingWater.value = true
  error.value = ''
  importMsg.value = ''
  try {
    const res = await importWaterHistory()
    if (res.alreadyImported) {
      importMsg.value = 'Wasser-Historie war bereits importiert.'
    } else {
      importMsg.value = `Wasser-Import: ${res.devices} Geräte, ${res.readings} Ablesungen.`
    }
    await load()
  } catch (err: any) {
    error.value = err.message || 'Fehler beim Import'
  } finally {
    importingWater.value = false
  }
}

async function handleImportElec() {
  importingElec.value = true
  error.value = ''
  importMsg.value = ''
  try {
    const res = await importElectricityHistory()
    if (res.alreadyImported) {
      importMsg.value = 'Strom-Historie war bereits importiert.'
    } else {
      importMsg.value = `Strom-Import: ${res.metersCreated} Zähler, ${res.devicesCreated} Geräte, ${res.readingsCreated} Ablesungen.`
    }
    await load()
  } catch (err: any) {
    error.value = err.message || 'Fehler beim Import'
  } finally {
    importingElec.value = false
  }
}

onMounted(load)
</script>

<template>
  <div class="meters-view">
    <div class="header">
      <h1>Zähler</h1>
      <div class="header-actions">
        <Button
          v-if="showElecImport"
          label="Strom-Historie importieren"
          icon="pi pi-upload"
          severity="secondary"
          :loading="importingElec"
          @click="handleImportElec"
        />
        <Button
          v-if="showWaterImport"
          label="Wasser-Historie importieren"
          icon="pi pi-upload"
          severity="secondary"
          :loading="importingWater"
          @click="handleImportWater"
        />
        <Button
          v-if="canManage"
          label="Neuer Zähler"
          icon="pi pi-plus"
          @click="openCreate"
        />
      </div>
    </div>

    <Message v-if="importMsg" severity="success" @close="importMsg = ''" closable>{{ importMsg }}</Message>
    <Message v-if="error" severity="error" @close="error = ''" closable>{{ error }}</Message>

    <div v-if="loading" class="info"><i class="pi pi-spin pi-spinner" /> Zähler werden geladen…</div>
    <div v-else-if="meters.length === 0" class="info">Noch keine Zähler angelegt.</div>

    <div v-else class="meter-grid">
      <div
        v-for="m in meters"
        :key="m.id"
        class="meter-card"
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
        <div v-if="canManage" class="meter-actions" @click.stop>
          <Button icon="pi pi-pencil" text rounded severity="secondary" v-tooltip.top="'Bearbeiten'" @click="openEdit(m)" />
          <Button icon="pi pi-trash" text rounded severity="danger" v-tooltip.top="'Löschen'" @click="handleDelete(m)" />
        </div>
      </div>
    </div>

    <!-- Create / edit dialog -->
    <Dialog
      v-model:visible="showForm"
      :header="form.id === null ? 'Neuer Zähler' : 'Zähler bearbeiten'"
      modal
      :style="{ width: '32rem', maxWidth: '95vw' }"
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
.header-actions {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
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
.section-title {
  font-weight: 600;
  color: var(--p-text-color);
  margin-top: 0.5rem;
}
</style>
