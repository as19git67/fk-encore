<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import CollectionScopeBar from '../components/collections/CollectionScopeBar.vue'
import FileButton from '../components/collections/FileButton.vue'
import Button from 'primevue/button'
import InputText from 'primevue/inputtext'
import InputNumber from 'primevue/inputnumber'
import Textarea from 'primevue/textarea'
import Select from 'primevue/select'
import DatePicker from 'primevue/datepicker'
import Dialog from 'primevue/dialog'
import Message from 'primevue/message'
import Tag from 'primevue/tag'
import { useConfirm } from 'primevue/useconfirm'
import PageLayout from '../components/layout/PageLayout.vue'
import {
  listMeters,
  createMeter,
  updateMeter,
  deleteMeter,
  getMeterHousehold,
  setMeterHousehold,
  shareMetersWithHousehold,
  METER_TYPE_LABELS,
  METER_TYPE_ICONS,
  METER_ROLE_LABELS,
  type MeterHouseholdState,
  type MeterListItem,
  type MeterRole,
  type MeterType,
} from '../api/meters'
import { listGroups, type GroupSummary } from '../api/documents'
import { useAuthStore } from '../stores/auth'
import { toLocalIsoDateTime } from '../utils/dateFormat'
import { decimalInputPt } from '../utils/inputNumberPt'
import { sortMetersByTypeAndName } from '../utils/meterSort'
import { MODULE_LIST_ANCHORS, anchorKey, saveListAnchor } from '../utils/listAnchor'

/** One key for this list — anchor and scroll offset are stored under it. */
const ANCHOR_KEY = MODULE_LIST_ANCHORS.meter.key

const router = useRouter()
const route = useRoute()

/** `?collection=` limits the list to one collection's meters (#1548). */
const collectionScope = computed<number | null>(() => {
  const id = Number(route.query.collection)
  return Number.isInteger(id) && id > 0 ? id : null
})
function clearCollectionScope() {
  const { collection: _drop, ...rest } = route.query
  void router.replace({ query: rest })
}
const auth = useAuthStore()
const confirm = useConfirm()
const canManage = computed(() => auth.hasPermission('meters.manage'))

const meters = ref<MeterListItem[]>([])
const groups = ref<GroupSummary[]>([])
const household = ref<MeterHouseholdState | null>(null)
const householdId = computed(() => household.value?.household?.id ?? null)
const loading = ref(false)
const error = ref('')

const typeOptions = (Object.keys(METER_TYPE_LABELS) as MeterType[]).map((value) => ({
  label: METER_TYPE_LABELS[value],
  value,
}))
const roleOptions: Array<{ label: string; value: MeterRole | null }> = [
  { label: 'Keine Report-Rolle', value: null },
  ...(Object.keys(METER_ROLE_LABELS) as MeterRole[]).map((value) => ({
    label: METER_ROLE_LABELS[value],
    value,
  })),
]

const DEFAULT_UNIT: Record<MeterType, string> = {
  electricity: 'kWh',
  water: 'm³',
  gas: 'm³',
  operating_hours: 'h',
}

watch(collectionScope, () => void load())

async function load() {
  loading.value = true
  error.value = ''
  try {
    const [mRes, gRes, hRes] = await Promise.all([
      listMeters({ collection: collectionScope.value ?? undefined }),
      loadGroups(),
      getMeterHousehold().catch(() => null),
    ])
    meters.value = mRes.meters
    groups.value = gRes
    household.value = hRes
  } catch (err: any) {
    error.value = err.message || 'Fehler beim Laden der Zähler'
  } finally {
    loading.value = false
  }
}

/** The list reads by type and then by name, so a meter is where you look for it. */
const sortedMeters = computed(() => sortMetersByTypeAndName(meters.value))

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
  ...groups.value.map((g) => ({
    label: g.id === householdId.value ? `${g.name} (Haushalt)` : g.name,
    value: g.id,
  })),
])

/** Who else sees the meter, and whose it is when it is not the caller's (#1647). */
function sharingLabel(m: MeterListItem): string {
  const owner = m.ownerUserId === auth.user?.id ? '' : ` · von ${m.ownerName}`
  if (m.groupId === null) return `Privat${owner}`
  return `${m.household ? 'Haushalt' : 'Gruppe'} „${m.groupName ?? ''}“${owner}`
}
function sharingIcon(m: MeterListItem): string {
  if (m.groupId === null) return 'pi pi-lock'
  return m.household ? 'pi pi-home' : 'pi pi-users'
}

function typeLabel(t: MeterType) {
  return METER_TYPE_LABELS[t]
}
function typeIcon(t: MeterType) {
  return METER_TYPE_ICONS[t]
}
function roleLabel(role: MeterRole | null) {
  return role ? METER_ROLE_LABELS[role] : null
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
  // Remember the card, not just the offset: a new reading changes the card's
  // height, so the way back would otherwise land next to it.
  saveListAnchor(ANCHOR_KEY, { kind: 'meter', id: m.id })
  router.push({ name: 'zaehler-detail', params: { id: m.id } })
}

interface MeterForm {
  id: number | null
  name: string
  type: MeterType
  role: MeterRole | null
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
    role: null,
    unit: DEFAULT_UNIT.electricity,
    location: '',
    notes: '',
    decimals: 1,
    // A new meter belongs to the household unless the user picks otherwise.
    groupId: householdId.value,
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
    role: m.role,
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
        role: form.value.role,
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
        role: form.value.role,
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
  confirm.require({
    message: `Zähler „${m.name}“ mit allen Geräten und Ablesungen löschen? Diese Aktion kann nicht rückgängig gemacht werden.`,
    header: 'Zähler löschen',
    icon: 'pi pi-exclamation-triangle',
    rejectLabel: 'Abbrechen',
    acceptLabel: 'Endgültig löschen',
    acceptClass: 'p-button-danger',
    accept: () => void performDelete(m),
  })
}

async function performDelete(m: MeterListItem) {
  error.value = ''
  try {
    await deleteMeter(m.id)
    await load()
  } catch (err: any) {
    error.value = err.message || 'Fehler beim Löschen'
  }
}

// ── Household (#1647) ────────────────────────────────────────────────────────

const showHousehold = ref(false)
const householdChoice = ref<number | null>(null)
const savingHousehold = ref(false)
const sharing = ref(false)
const householdError = ref('')
const householdNotice = ref('')

const householdOptions = computed(() => [
  { label: 'Kein Haushalt', value: null, disabled: household.value?.household?.myRole === 'member' },
  ...(household.value?.groups ?? []).map((g) => ({
    label: g.myRole === 'owner' ? g.name : `${g.name} (nur Gruppen-Besitzer)`,
    value: g.id,
    disabled: g.myRole !== 'owner',
  })),
])

function openHousehold() {
  householdChoice.value = householdId.value
  householdError.value = ''
  showHousehold.value = true
}

async function saveHousehold() {
  savingHousehold.value = true
  householdError.value = ''
  try {
    household.value = await setMeterHousehold(householdChoice.value)
    showHousehold.value = false
    await load()
  } catch (err: any) {
    householdError.value = err.message || 'Haushalt konnte nicht gespeichert werden'
  } finally {
    savingHousehold.value = false
  }
}

async function shareAllWithHousehold() {
  sharing.value = true
  error.value = ''
  try {
    const res = await shareMetersWithHousehold()
    householdNotice.value =
      res.shared === 1 ? '1 Zähler ist jetzt mit dem Haushalt geteilt.' : `${res.shared} Zähler sind jetzt mit dem Haushalt geteilt.`
    await load()
  } catch (err: any) {
    error.value = err.message || 'Zähler konnten nicht geteilt werden'
  } finally {
    sharing.value = false
  }
}

onMounted(load)
</script>

<template>
  <PageLayout title="Zähler" width="normal" :ready="!loading" :anchor-key="ANCHOR_KEY">
    <template #actions>
      <Button
        label="Auswertungen"
        icon="pi pi-chart-line"
        severity="secondary"
        @click="router.push({ name: 'zaehler-auswertungen' })"
      />
      <Button
        v-if="canManage"
        label="Haushalt"
        icon="pi pi-home"
        severity="secondary"
        @click="openHousehold"
      />
      <Button
        v-if="canManage"
        label="Neuer Zähler"
        icon="pi pi-plus"
        @click="openCreate"
      />
    </template>

    <template #notice>
      <CollectionScopeBar
        v-if="collectionScope"
        :collection-id="collectionScope"
        @clear="clearCollectionScope"
      />
      <Message v-if="error" severity="error" @close="error = ''" closable>{{ error }}</Message>
      <Message v-if="householdNotice" severity="success" @close="householdNotice = ''" closable>{{ householdNotice }}</Message>
      <Message
        v-if="canManage && household?.household && household.privateMeterCount > 0 && !collectionScope"
        severity="info"
      >
        <div class="share-notice">
          <span>
            {{ household.privateMeterCount === 1 ? 'Einer deiner Zähler ist' : `${household.privateMeterCount} deiner Zähler sind` }}
            noch privat und für den Haushalt „{{ household.household.name }}“ unsichtbar.
          </span>
          <Button
            label="Alle mit dem Haushalt teilen"
            icon="pi pi-home"
            size="small"
            :loading="sharing"
            @click="shareAllWithHousehold"
          />
        </div>
      </Message>
    </template>

    <div v-if="loading" class="info"><i class="pi pi-spin pi-spinner" /> Zähler werden geladen…</div>
    <div v-else-if="meters.length === 0" class="info">
      {{ collectionScope ? 'In dieser Sammelmappe liegen keine Zähler.' : 'Noch keine Zähler angelegt.' }}
    </div>

    <template v-else>
      <div class="meter-grid">
      <div
        v-for="m in sortedMeters"
        :key="m.id"
        :data-anchor="anchorKey('meter', m.id)"
        class="meter-card scroll-anchor"
        tabindex="0"
        @click="openDetail(m)"
        @keydown.enter="openDetail(m)"
        @keydown.space.prevent="openDetail(m)"
      >
        <div class="meter-card-head">
          <i :class="typeIcon(m.type)" />
          <span class="meter-name">{{ m.name }}</span>
          <Tag :value="typeLabel(m.type)" severity="secondary" />
          <Tag v-if="m.role" :value="roleLabel(m.role)" severity="info" />
        </div>
        <div class="meter-meta">
          <span v-if="m.location"><i class="pi pi-map-marker" /> {{ m.location }}</span>
          <span><i :class="sharingIcon(m)" /> {{ sharingLabel(m) }}</span>
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
        <div class="meter-actions" @click.stop>
          <FileButton :members="[{ entity_type: 'meter', entity_id: m.id }]" :title="m.name" />
          <template v-if="canManage && m.canManage">
            <Button icon="pi pi-pencil" text rounded severity="secondary" aria-label="Bearbeiten" v-tooltip.top="'Bearbeiten'" @click="openEdit(m)" />
            <Button icon="pi pi-trash" text rounded severity="danger" aria-label="Löschen" v-tooltip.top="'Löschen'" @click="handleDelete(m)" />
          </template>
        </div>
      </div>
      </div>
    </template>

    <!-- Create / edit dialog -->
    <Dialog
    class="dialog-sm"
      v-model:visible="showForm"
      :header="form.id === null ? 'Neuer Zähler' : 'Zähler bearbeiten'"
      modal
    >
      <div class="form-grid">
        <label>Name
          <InputText v-model="form.name" autofocus />
        </label>
        <label>Typ
          <Select v-model="form.type" :options="typeOptions" option-label="label" option-value="value" @change="onTypeChange" />
        </label>
        <label>Report-Rolle
          <Select v-model="form.role" :options="roleOptions" option-label="label" option-value="value" />
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
            <InputNumber v-model="form.deviceStartValue" :min-fraction-digits="0" :max-fraction-digits="3" :pt="decimalInputPt" />
          </label>
        </template>
      </div>
      <template #footer>
        <Button label="Abbrechen" text @click="showForm = false" />
        <Button label="Speichern" icon="pi pi-check" :loading="saving" @click="handleSave" />
      </template>
    </Dialog>

    <Dialog class="dialog-sm" v-model:visible="showHousehold" header="Haushalt" modal>
      <div class="household-dialog">
        <p>
          Zähler gehören meist dem ganzen Haushalt. Die Mitglieder der gewählten Gruppe sehen
          die mit ihr geteilten Zähler samt Ablesungen, Auswertungen und Auffälligkeiten und
          können selbst ablesen. Tarife, Annahmen und Standort gelten dann für den ganzen
          Haushalt, damit alle dieselben Kosten sehen. Neue Zähler werden mit dem Haushalt
          geteilt; „Privat“ bleibt wählbar.
        </p>
        <p class="hint">
          Bearbeiten, Löschen, Gerätewechsel und API-Schlüssel bleiben beim Besitzer des
          Zählers und den Besitzern der Gruppe. Festlegen kann den Haushalt nur ein Besitzer
          der Gruppe.
        </p>
        <label>Gruppe
          <Select
            v-model="householdChoice"
            :options="householdOptions"
            option-label="label"
            option-value="value"
            option-disabled="disabled"
            placeholder="Keine Gruppe vorhanden"
          />
        </label>
        <Message v-if="householdError" severity="error">{{ householdError }}</Message>
      </div>
      <template #footer>
        <Button label="Abbrechen" text @click="showHousehold = false" />
        <Button
          label="Speichern"
          icon="pi pi-check"
          :loading="savingHousehold"
          :disabled="householdChoice === householdId"
          @click="saveHousehold"
        />
      </template>
    </Dialog>
  </PageLayout>
</template>

<style scoped>
/* Page frame and title: PageLayout (issue #1272). */
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
  font-size: var(--text-base);
  min-height: 1.2rem;
  margin-bottom: 0.75rem;
  display: flex;
  flex-wrap: wrap;
  gap: 0.25rem var(--space-3);
}
.meter-meta i {
  margin-right: 0.25rem;
}
.share-notice {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2) var(--space-3);
}
.household-dialog {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}
.household-dialog p {
  margin: 0;
}
.household-dialog .hint {
  color: var(--p-text-muted-color);
  font-size: var(--text-sm);
}
.household-dialog label {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  color: var(--p-text-muted-color);
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
  font-size: var(--text-sm);
  color: var(--p-text-muted-color);
}
.figure-value {
  font-weight: 600;
  font-size: var(--text-lg);
}
.figure-sub {
  font-size: var(--text-xs);
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
  font-size: var(--text-base);
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
