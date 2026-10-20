<script setup lang="ts">
import { searchInputAttrs } from '../../utils/searchInputAttrs'
/**
 * One business (documentation/plans/betriebe-euer.md, stage 1): its fixed
 * assets with the chosen year's depreciation and book value, and its
 * parcels with lessee and rent. The schedule comes from the server for
 * the year in the URL (`?year=`); the page never computes AfA itself.
 */
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import Button from 'primevue/button'
import DataTable from 'primevue/datatable'
import Column from 'primevue/column'
import Dialog from 'primevue/dialog'
import InputText from 'primevue/inputtext'
import InputNumber from 'primevue/inputnumber'
import Textarea from 'primevue/textarea'
import { searchDocuments, type SearchDocumentSummary } from '../../api/documents'
import Select from 'primevue/select'
import DatePicker from 'primevue/datepicker'
import Message from 'primevue/message'
import PageLayout from '../../components/layout/PageLayout.vue'
import ScrollX from '../../components/layout/ScrollX.vue'
import EmptyState from '../../components/layout/EmptyState.vue'
import PageSkeleton from '../../components/layout/PageSkeleton.vue'
import ErrorBanner from '../../components/layout/ErrorBanner.vue'
import { useModuleBack } from '../../composables/useModuleBack'
import { useConfirmAsync } from '../../composables/useConfirmAsync'
import { useAuthStore } from '../../stores/auth'
import { parseLocalDate, toLocalIsoDate } from '../../utils/dateFormat'
import {
  createBusinessAsset, createBusinessParcel, deleteBusiness, deleteBusinessAsset, deleteBusinessParcel, downloadBusinessEuerPdf,
  getBusiness, getBusinessAssetSchedule, getBusinessEuer, linkBusinessDocument, listBusinessDocuments, unlinkBusinessDocument, updateBusiness, updateBusinessAsset, updateBusinessParcel,
  type BusinessDocumentLink, type BusinessDocumentTarget,
  type BusinessAsset, type BusinessAssetKind, type BusinessDetail, type BusinessKind, type BusinessParcel,
  type BusinessTaxSection, type DepreciationYear, type EuerLine, type EuerLineKind, type EuerReport, type ParcelUsage, type PvTaxOverride,
} from '../../api/finance'
import {
  ASSET_KIND_OPTIONS, BUSINESS_KIND_OPTIONS, PARCEL_USAGE_OPTIONS, TAX_SECTION_OPTIONS,
  assetKindLabel, businessKindLabel, parcelUsageLabel, taxSectionLabel,
} from '../../utils/businessLabels'

const route = useRoute()
const router = useRouter()
const authStore = useAuthStore()
const askConfirm = useConfirmAsync()
const { goBack } = useModuleBack('/finanzen', 'finance-businesses')
const canWrite = computed(() => authStore.hasPermission('finance.accounts.manage'))

const id = computed(() => Number(route.params.id))
const thisYear = new Date().getFullYear()
const year = computed({
  get: () => {
    const y = Number(route.query.year)
    return Number.isInteger(y) && y >= 1990 && y <= 2100 ? y : thisYear
  },
  set: (y: number) => {
    void router.replace({ query: { ...route.query, year: y === thisYear ? undefined : String(y) } })
  },
})
const yearOptions = computed(() => {
  const first = Math.min(thisYear - 5, ...(data.value?.assets.map((a) => Number(a.acquisition_date.slice(0, 4))) ?? []))
  const out: number[] = []
  for (let y = thisYear + 1; y >= first; y--) out.push(y)
  return out
})

const data = ref<BusinessDetail | null>(null)
const loading = ref(false)
const error = ref<string | null>(null)
const notice = ref<string | null>(null)

async function load() {
  loading.value = true
  error.value = null
  try {
    data.value = await getBusiness(id.value, year.value)
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : 'Betrieb konnte nicht geladen werden'
  } finally {
    loading.value = false
  }
}

watch([id, year], load, { immediate: true })

const title = computed(() => data.value?.business.name ?? 'Betrieb')
const hint = computed(() => data.value ? `${businessKindLabel(data.value.business.kind)} · ${taxSectionLabel(data.value.business.tax_section)}` : undefined)

const eur = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' })
const num = new Intl.NumberFormat('de-DE')
function money(v: string | number | null | undefined): string {
  if (v === null || v === undefined || v === '') return '–'
  const n = Number(v)
  return Number.isFinite(n) ? eur.format(n) : String(v)
}
function fmtDate(v: string | null | undefined): string {
  return v ? parseLocalDate(v.slice(0, 10)).toLocaleDateString('de-DE') : '–'
}
function pct(v: string): string {
  return `${num.format(Number(v))} %`
}
function toDate(v: string | null | undefined): Date | null {
  return v ? parseLocalDate(v.slice(0, 10)) : null
}
function fromDate(d: Date | null): string | null {
  return d ? toLocalIsoDate(d) : null
}
function parcelLabel(p: BusinessParcel): string {
  return `${p.gemarkung}${p.flur ? `, Flur ${p.flur}` : ''}, Flst. ${p.flurstueck}`
}

function fail(e: unknown, fallback: string): string {
  return e instanceof Error ? e.message : fallback
}

// ── business ────────────────────────────────────────────────────────────

const businessDialog = ref(false)
const businessSaving = ref(false)
const businessError = ref<string | null>(null)
interface BusinessForm {
  name: string
  kind: BusinessKind
  tax_section: BusinessTaxSection
  notes: string
  booking_tag: string
  document_category: string
  pv_capacity_kwp: number | null
  pv_commissioned_on: Date | null
  pv_tax_override: PvTaxOverride | 'auto'
}

const businessForm = ref<BusinessForm>({ name: '', kind: 'landwirtschaft', tax_section: 'anlage-l', notes: '', booking_tag: '', document_category: '', pv_capacity_kwp: null, pv_commissioned_on: null, pv_tax_override: 'auto' })

const PV_TAX_OPTIONS: { value: PvTaxOverride | 'auto'; label: string }[] = [
  { value: 'auto', label: 'Aus Leistung und Jahr ableiten (§ 3 Nr. 72 EStG)' },
  { value: 'exempt', label: 'Steuerfrei' },
  { value: 'taxable', label: 'Steuerpflichtig' },
]

function openBusinessEdit() {
  const b = data.value!.business
  businessForm.value = {
    name: b.name, kind: b.kind, tax_section: b.tax_section, notes: b.notes ?? '', booking_tag: b.booking_tag ?? '', document_category: b.document_category ?? '',
    pv_capacity_kwp: b.pv_capacity_kwp === null ? null : Number(b.pv_capacity_kwp), pv_commissioned_on: toDate(b.pv_commissioned_on), pv_tax_override: b.pv_tax_override ?? 'auto',
  }
  businessError.value = null
  businessDialog.value = true
}

async function saveBusiness() {
  businessSaving.value = true
  businessError.value = null
  try {
    const f = businessForm.value
    await updateBusiness(id.value, {
      name: f.name, kind: f.kind, tax_section: f.tax_section, notes: f.notes || null,
      booking_tag: f.booking_tag.trim() || null, document_category: f.document_category.trim() || null,
      pv_capacity_kwp: f.pv_capacity_kwp, pv_commissioned_on: fromDate(f.pv_commissioned_on), pv_tax_override: f.pv_tax_override === 'auto' ? null : f.pv_tax_override,
    })
    businessDialog.value = false
    await load()
    await loadEuer()
  } catch (e: unknown) {
    businessError.value = fail(e, 'Speichern fehlgeschlagen')
  } finally {
    businessSaving.value = false
  }
}

async function removeBusiness() {
  const b = data.value!.business
  const ok = await askConfirm({
    header: 'Betrieb löschen',
    message: `„${b.name}“ mit ${b.asset_count} Anlagegütern und ${b.parcel_count} Flächen löschen? Buchungen und Dokumente bleiben erhalten.`,
    acceptLabel: 'Löschen',
    danger: true,
  })
  if (!ok) return
  try {
    await deleteBusiness(id.value)
    void router.push({ name: 'finance-businesses' })
  } catch (e: unknown) {
    error.value = fail(e, 'Löschen fehlgeschlagen')
  }
}

// ── EÜR ─────────────────────────────────────────────────────────────────

const euer = ref<EuerReport | null>(null)
const euerLoading = ref(false)
const euerError = ref<string | null>(null)
const euerOpen = ref<Set<string>>(new Set())
const pdfBusy = ref(false)

async function loadEuer() {
  euerLoading.value = true
  euerError.value = null
  try {
    euer.value = await getBusinessEuer(id.value, year.value)
  } catch (e: unknown) {
    euerError.value = fail(e, 'EÜR konnte nicht geladen werden')
  } finally {
    euerLoading.value = false
  }
}

watch([id, year], loadEuer, { immediate: true })

function lineKey(l: EuerLine): string {
  return `${l.kind}-${l.name}`
}

function toggleLine(l: EuerLine) {
  const key = lineKey(l)
  if (euerOpen.value.has(key)) euerOpen.value.delete(key)
  else euerOpen.value.add(key)
}

function cents(c: number): string {
  return eur.format(c / 100)
}

async function downloadPdf() {
  pdfBusy.value = true
  try {
    await downloadBusinessEuerPdf(id.value, year.value)
  } catch (e: unknown) {
    error.value = fail(e, 'PDF konnte nicht erstellt werden')
  } finally {
    pdfBusy.value = false
  }
}

const documentsRoute = computed(() => {
  const slug = data.value?.business.document_category
  return slug ? { name: 'dokumente-list', query: { category: slug, dateFrom: `${year.value}-01-01`, dateTo: `${year.value}-12-31` } } : null
})

// ── EÜR lines editor ────────────────────────────────────────────────────

interface LineForm { name: string; kind: EuerLineKind; tags: string; form_line: string }

const linesDialog = ref(false)
const linesSaving = ref(false)
const linesError = ref<string | null>(null)
const lineForms = ref<LineForm[]>([])
const LINE_KIND_OPTIONS: { value: EuerLineKind; label: string }[] = [
  { value: 'income', label: 'Einnahme' },
  { value: 'expense', label: 'Ausgabe' },
]

function openLinesEdit() {
  lineForms.value = (data.value?.business.euer_lines ?? []).map((l) => ({ name: l.name, kind: l.kind, tags: l.tags.join(', '), form_line: l.form_line ?? '' }))
  linesError.value = null
  linesDialog.value = true
}

function addLine(kind: EuerLineKind) {
  lineForms.value.push({ name: '', kind, tags: '', form_line: '' })
}

function removeLine(i: number) {
  lineForms.value.splice(i, 1)
}

function moveLine(i: number, dir: -1 | 1) {
  const j = i + dir
  if (j < 0 || j >= lineForms.value.length) return
  const list = lineForms.value
  ;[list[i], list[j]] = [list[j]!, list[i]!]
}

async function saveLines() {
  const lines = lineForms.value
    .map((l) => ({ name: l.name.trim(), kind: l.kind, tags: l.tags.split(',').map((t) => t.trim()).filter(Boolean), form_line: l.form_line.trim() || null }))
    .filter((l) => l.name)
  linesSaving.value = true
  linesError.value = null
  try {
    await updateBusiness(id.value, { euer_lines: lines })
    linesDialog.value = false
    await load()
    await loadEuer()
  } catch (e: unknown) {
    linesError.value = fail(e, 'Speichern fehlgeschlagen')
  } finally {
    linesSaving.value = false
  }
}

// ── documents ───────────────────────────────────────────────────────────

const docs = ref<BusinessDocumentLink[]>([])
const docsLoading = ref(false)
const docsError = ref<string | null>(null)

async function loadDocs() {
  docsLoading.value = true
  docsError.value = null
  try {
    docs.value = (await listBusinessDocuments(id.value)).items
  } catch (e: unknown) {
    docsError.value = fail(e, 'Dokumente konnten nicht geladen werden')
  } finally {
    docsLoading.value = false
  }
}

watch(id, loadDocs, { immediate: true })

interface DocGroup { key: string; label: string; items: BusinessDocumentLink[] }

/** The links by what they hang on: the business first, then each asset and parcel in page order. */
const docGroups = computed<DocGroup[]>(() => {
  const groups: DocGroup[] = []
  const general = docs.value.filter((d) => d.target_kind === 'business')
  if (general.length) groups.push({ key: 'business', label: 'Betrieb', items: general })
  for (const a of data.value?.assets ?? []) {
    const items = docs.value.filter((d) => d.target_kind === 'asset' && d.target_id === a.id)
    if (items.length) groups.push({ key: `asset-${a.id}`, label: `Anlagegut ${a.name}`, items })
  }
  for (const p of data.value?.parcels ?? []) {
    const items = docs.value.filter((d) => d.target_kind === 'parcel' && d.target_id === p.id)
    if (items.length) groups.push({ key: `parcel-${p.id}`, label: `Fläche ${parcelLabel(p)}`, items })
  }
  const orphans = docs.value.filter((d) => !groups.some((g) => g.items.includes(d)))
  if (orphans.length) groups.push({ key: 'other', label: 'Ohne Ziel', items: orphans })
  return groups
})

function docTitle(d: BusinessDocumentLink): string {
  return d.document ? (d.document.title ?? d.document.original_filename) : `Dokument ${d.document_id} (nicht lesbar)`
}

async function removeDoc(d: BusinessDocumentLink) {
  const ok = await askConfirm({ header: 'Verknüpfung lösen', message: `„${docTitle(d)}“ vom Betrieb lösen? Das Dokument selbst bleibt erhalten.`, acceptLabel: 'Lösen', danger: true })
  if (!ok) return
  try {
    await unlinkBusinessDocument(d.id)
    await loadDocs()
  } catch (e: unknown) {
    docsError.value = fail(e, 'Lösen fehlgeschlagen')
  }
}

// ── link a document ─────────────────────────────────────────────────────

interface TargetOption { value: string; label: string; kind: BusinessDocumentTarget; id: number | null }

const linkDialog = ref(false)
const linkSaving = ref(false)
const linkError = ref<string | null>(null)
const linkQuery = ref('')
const linkOnlyCategory = ref(true)
const linkResults = ref<SearchDocumentSummary[]>([])
const linkSearching = ref(false)
const linkTarget = ref('business')
const linkNote = ref('')
let linkSearchTimer: ReturnType<typeof setTimeout> | null = null

const targetOptions = computed<TargetOption[]>(() => [
  { value: 'business', label: 'Betrieb allgemein', kind: 'business', id: null },
  ...(data.value?.assets ?? []).map((a) => ({ value: `asset-${a.id}`, label: `Anlagegut: ${a.name}`, kind: 'asset' as const, id: a.id })),
  ...(data.value?.parcels ?? []).map((p) => ({ value: `parcel-${p.id}`, label: `Fläche: ${parcelLabel(p)}`, kind: 'parcel' as const, id: p.id })),
])

function openLink(target = 'business') {
  linkTarget.value = target
  linkQuery.value = ''
  linkNote.value = ''
  linkResults.value = []
  linkError.value = null
  linkOnlyCategory.value = !!data.value?.business.document_category
  linkDialog.value = true
  void runLinkSearch()
}

async function runLinkSearch() {
  linkSearching.value = true
  try {
    const filters = linkOnlyCategory.value && data.value?.business.document_category ? { category: data.value.business.document_category } : {}
    const res = await searchDocuments(linkQuery.value.trim(), 'hybrid', 20, filters)
    linkResults.value = res.items
  } catch (e: unknown) {
    linkError.value = fail(e, 'Suche fehlgeschlagen')
  } finally {
    linkSearching.value = false
  }
}

function onLinkQuery() {
  if (linkSearchTimer) clearTimeout(linkSearchTimer)
  linkSearchTimer = setTimeout(() => void runLinkSearch(), 300)
}

watch(linkOnlyCategory, () => void runLinkSearch())

function alreadyLinked(docId: number): boolean {
  const t = targetOptions.value.find((o) => o.value === linkTarget.value)
  return docs.value.some((d) => d.document_id === docId && d.target_kind === t?.kind && (d.target_id ?? null) === (t?.id ?? null))
}

async function pickDoc(d: SearchDocumentSummary) {
  const t = targetOptions.value.find((o) => o.value === linkTarget.value)
  if (!t) return
  linkSaving.value = true
  linkError.value = null
  try {
    await linkBusinessDocument(id.value, { document_id: d.id, target_kind: t.kind, target_id: t.id, note: linkNote.value.trim() || null })
    await loadDocs()
    linkDialog.value = false
  } catch (e: unknown) {
    linkError.value = fail(e, 'Verknüpfen fehlgeschlagen')
  } finally {
    linkSaving.value = false
  }
}

// ── assets ──────────────────────────────────────────────────────────────

interface AssetForm {
  name: string
  kind: BusinessAssetKind
  acquisition_date: Date | null
  acquisition_cost: number | null
  afa_rate_pct: number | null
  afa_start_date: Date | null
  disposal_date: Date | null
  disposal_proceeds: number | null
  notes: string
}

const assetDialog = ref(false)
const assetSaving = ref(false)
const assetError = ref<string | null>(null)
const assetId = ref<number | null>(null)
const assetForm = ref<AssetForm>(blankAsset())

function blankAsset(): AssetForm {
  return { name: '', kind: 'gebaeude', acquisition_date: null, acquisition_cost: null, afa_rate_pct: 2, afa_start_date: null, disposal_date: null, disposal_proceeds: null, notes: '' }
}

function openAssetCreate() {
  assetId.value = null
  assetForm.value = blankAsset()
  assetError.value = null
  assetDialog.value = true
}

function openAssetEdit(a: BusinessAsset) {
  assetId.value = a.id
  assetForm.value = {
    name: a.name, kind: a.kind, acquisition_date: toDate(a.acquisition_date), acquisition_cost: Number(a.acquisition_cost),
    afa_rate_pct: Number(a.afa_rate_pct), afa_start_date: toDate(a.afa_start_date), disposal_date: toDate(a.disposal_date),
    disposal_proceeds: a.disposal_proceeds === null ? null : Number(a.disposal_proceeds), notes: a.notes ?? '',
  }
  assetError.value = null
  assetDialog.value = true
}

/** The kind's usual rate, unless the user typed one of their own. */
function onAssetKindChange(kind: BusinessAssetKind) {
  const option = ASSET_KIND_OPTIONS.find((o) => o.value === kind)
  if (option) assetForm.value.afa_rate_pct = option.rate
}

async function saveAsset() {
  const f = assetForm.value
  if (!f.name.trim() || !f.acquisition_date || f.acquisition_cost === null) {
    assetError.value = 'Name, Anschaffungsdatum und Anschaffungskosten sind Pflicht.'
    return
  }
  assetSaving.value = true
  assetError.value = null
  const input = {
    name: f.name.trim(), kind: f.kind, acquisition_date: toLocalIsoDate(f.acquisition_date), acquisition_cost: f.acquisition_cost,
    afa_rate_pct: f.afa_rate_pct ?? undefined, afa_start_date: fromDate(f.afa_start_date), disposal_date: fromDate(f.disposal_date),
    disposal_proceeds: f.disposal_date ? f.disposal_proceeds : null, notes: f.notes || null,
  }
  try {
    if (assetId.value) await updateBusinessAsset(assetId.value, input)
    else await createBusinessAsset(id.value, input)
    assetDialog.value = false
    await load()
  } catch (e: unknown) {
    assetError.value = fail(e, 'Speichern fehlgeschlagen')
  } finally {
    assetSaving.value = false
  }
}

async function removeAsset(a: BusinessAsset) {
  const ok = await askConfirm({ header: 'Anlagegut löschen', message: `„${a.name}“ aus dem Verzeichnis löschen?`, acceptLabel: 'Löschen', danger: true })
  if (!ok) return
  try {
    await deleteBusinessAsset(a.id)
    await load()
  } catch (e: unknown) {
    error.value = fail(e, 'Löschen fehlgeschlagen')
  }
}

// ── schedule of one asset ───────────────────────────────────────────────

const scheduleDialog = ref(false)
const scheduleAsset = ref<BusinessAsset | null>(null)
const scheduleRows = ref<DepreciationYear[]>([])
const scheduleLoading = ref(false)

async function openSchedule(a: BusinessAsset) {
  scheduleAsset.value = a
  scheduleRows.value = []
  scheduleDialog.value = true
  scheduleLoading.value = true
  try {
    scheduleRows.value = (await getBusinessAssetSchedule(a.id, Math.max(year.value, thisYear))).rows
  } catch (e: unknown) {
    error.value = fail(e, 'AfA-Plan konnte nicht geladen werden')
    scheduleDialog.value = false
  } finally {
    scheduleLoading.value = false
  }
}

// ── parcels ─────────────────────────────────────────────────────────────

interface ParcelForm {
  gemarkung: string
  flur: string
  flurstueck: string
  area_m2: number | null
  usage: ParcelUsage
  lessee: string
  lease_from: Date | null
  lease_to: Date | null
  annual_rent: number | null
  asset_id: number | null
  notes: string
}

const parcelDialog = ref(false)
const parcelSaving = ref(false)
const parcelError = ref<string | null>(null)
const parcelId = ref<number | null>(null)
const parcelForm = ref<ParcelForm>(blankParcel())

function blankParcel(): ParcelForm {
  return { gemarkung: '', flur: '', flurstueck: '', area_m2: null, usage: 'acker', lessee: '', lease_from: null, lease_to: null, annual_rent: null, asset_id: null, notes: '' }
}

const landAssets = computed(() => [
  { id: null as number | null, name: 'Kein Anlagegut' },
  ...(data.value?.assets.filter((a) => a.kind === 'flaeche').map((a) => ({ id: a.id as number | null, name: a.name })) ?? []),
])

function openParcelCreate() {
  parcelId.value = null
  parcelForm.value = blankParcel()
  parcelError.value = null
  parcelDialog.value = true
}

function openParcelEdit(p: BusinessParcel) {
  parcelId.value = p.id
  parcelForm.value = {
    gemarkung: p.gemarkung, flur: p.flur ?? '', flurstueck: p.flurstueck, area_m2: p.area_m2, usage: p.usage, lessee: p.lessee ?? '',
    lease_from: toDate(p.lease_from), lease_to: toDate(p.lease_to), annual_rent: p.annual_rent === null ? null : Number(p.annual_rent),
    asset_id: p.asset_id, notes: p.notes ?? '',
  }
  parcelError.value = null
  parcelDialog.value = true
}

async function saveParcel() {
  const f = parcelForm.value
  if (!f.gemarkung.trim() || !f.flurstueck.trim()) {
    parcelError.value = 'Gemarkung und Flurstück sind Pflicht.'
    return
  }
  parcelSaving.value = true
  parcelError.value = null
  const input = {
    gemarkung: f.gemarkung.trim(), flur: f.flur.trim() || null, flurstueck: f.flurstueck.trim(), area_m2: f.area_m2, usage: f.usage,
    lessee: f.lessee.trim() || null, lease_from: fromDate(f.lease_from), lease_to: fromDate(f.lease_to), annual_rent: f.annual_rent,
    asset_id: f.asset_id, notes: f.notes || null,
  }
  try {
    if (parcelId.value) await updateBusinessParcel(parcelId.value, input)
    else await createBusinessParcel(id.value, input)
    parcelDialog.value = false
    await load()
  } catch (e: unknown) {
    parcelError.value = fail(e, 'Speichern fehlgeschlagen')
  } finally {
    parcelSaving.value = false
  }
}

async function removeParcel(p: BusinessParcel) {
  const ok = await askConfirm({ header: 'Fläche löschen', message: `${parcelLabel(p)} löschen?`, acceptLabel: 'Löschen', danger: true })
  if (!ok) return
  try {
    await deleteBusinessParcel(p.id)
    await load()
  } catch (e: unknown) {
    error.value = fail(e, 'Löschen fehlgeschlagen')
  }
}
</script>

<template>
  <PageLayout :title="title" :hint="hint" width="wide" :ready="!loading">
    <template #actions>
      <Button icon="pi pi-arrow-left" text rounded aria-label="Zurück" @click="goBack" />
      <Select v-model="year" :options="yearOptions" size="small" aria-label="Steuerjahr" class="year-select" />
      <Button v-if="canWrite && data" icon="pi pi-pencil" text rounded aria-label="Betrieb bearbeiten" @click="openBusinessEdit" />
      <Button v-if="canWrite && data" icon="pi pi-trash" text rounded severity="danger" aria-label="Betrieb löschen" @click="removeBusiness" />
    </template>

    <template #notice>
      <ErrorBanner v-if="error" :message="error" closable @retry="load" @close="error = null" />
      <Message v-if="notice" severity="success" closable @close="notice = null">{{ notice }}</Message>
    </template>

    <PageSkeleton v-if="loading && !data" variant="list" :count="6" />

    <template v-else-if="data">
      <p v-if="data.business.notes" class="notes">{{ data.business.notes }}</p>

      <section class="section">
        <header class="section-head">
          <h2>Anlagegüter {{ data.year }}</h2>
          <Button v-if="canWrite" label="Anlagegut" icon="pi pi-plus" size="small" severity="secondary" outlined @click="openAssetCreate" />
        </header>

        <EmptyState
          v-if="data.assets.length === 0"
          icon="pi pi-box"
          title="Noch kein Anlagegut"
          message="Gebäude, Maschinen, die PV-Anlage oder Grund und Boden — mit Anschaffungsdatum, Kosten und AfA-Satz."
        />
        <ScrollX v-else>
          <DataTable :value="data.assets" size="small" data-key="id" class="assets-table">
            <Column field="name" header="Anlagegut">
              <template #body="{ data: a }">
                <span class="cell-name">{{ a.name }}</span>
                <span class="cell-sub">{{ assetKindLabel(a.kind) }}<template v-if="a.disposal_date"> · verkauft {{ fmtDate(a.disposal_date) }}</template></span>
              </template>
            </Column>
            <Column header="Anschaffung" class="col-num">
              <template #body="{ data: a }">
                <span class="cell-name">{{ money(a.acquisition_cost) }}</span>
                <span class="cell-sub">{{ fmtDate(a.acquisition_date) }}</span>
              </template>
            </Column>
            <Column header="AfA-Satz" class="col-num">
              <template #body="{ data: a }">{{ pct(a.afa_rate_pct) }}</template>
            </Column>
            <Column :header="`AfA ${data.year}`" class="col-num">
              <template #body="{ data: a }">
                <span class="cell-name">{{ money(a.depreciation.afa) }}</span>
                <span v-if="a.depreciation.months > 0 && a.depreciation.months < 12" class="cell-sub">{{ a.depreciation.months }} Monate</span>
              </template>
            </Column>
            <Column :header="`Buchwert ${data.year}`" class="col-num">
              <template #body="{ data: a }">
                <span class="cell-name">{{ money(a.depreciation.book_value) }}</span>
                <span v-if="a.depreciation.disposal_result !== null" class="cell-sub">Veräußerung {{ money(a.depreciation.disposal_result) }}</span>
              </template>
            </Column>
            <Column class="col-actions">
              <template #body="{ data: a }">
                <Button icon="pi pi-list" text rounded size="small" aria-label="AfA-Plan anzeigen" @click="openSchedule(a)" />
                <Button v-if="canWrite" icon="pi pi-pencil" text rounded size="small" aria-label="Anlagegut bearbeiten" @click="openAssetEdit(a)" />
                <Button v-if="canWrite" icon="pi pi-trash" text rounded size="small" severity="danger" aria-label="Anlagegut löschen" @click="removeAsset(a)" />
              </template>
            </Column>
            <template #footer>
              <div class="totals">
                <span>Anschaffungskosten {{ money(data.totals.acquisition_cost) }}</span>
                <span>AfA {{ data.year }}: <strong>{{ money(data.totals.afa) }}</strong></span>
                <span>Buchwert Ende {{ data.year }}: <strong>{{ money(data.totals.book_value) }}</strong></span>
              </div>
            </template>
          </DataTable>
        </ScrollX>
      </section>

      <section v-if="data.pv" class="section">
        <header class="section-head">
          <h2>Photovoltaik {{ year }}</h2>
          <span class="section-actions">
            <RouterLink :to="{ name: 'zaehler-auswertungen' }" class="section-link">Zähler-Auswertungen</RouterLink>
            <Button v-if="canWrite" label="Anlage bearbeiten" icon="pi pi-pencil" text size="small" @click="openBusinessEdit" />
          </span>
        </header>
        <div :class="['pv-card', { 'pv-card--exempt': data.pv.status.exempt === true, 'pv-card--taxable': data.pv.status.exempt === false }]">
          <dl class="pv-facts">
            <div>
              <dt>Leistung</dt>
              <dd>
                <template v-if="data.pv.capacity_kwp">{{ num.format(Number(data.pv.capacity_kwp)) }} kWp<span v-if="data.pv.capacity_source === 'meters'" class="cell-sub-inline"> (aus den Zählertarifen)</span></template>
                <template v-else>nicht eingetragen<span v-if="canWrite" class="cell-sub-inline"> (über „Anlage bearbeiten“)</span></template>
              </dd>
            </div>
            <div>
              <dt>Inbetriebnahme</dt>
              <dd>{{ fmtDate(data.pv.commissioned_on) }}</dd>
            </div>
            <div>
              <dt>Einspeisung {{ year }} laut Zählern</dt>
              <dd>
                <template v-if="data.pv.feed_in && data.pv.feed_in.revenue_eur !== null">
                  {{ eur.format(data.pv.feed_in.revenue_eur) }}<span v-if="data.pv.feed_in.exported_kwh !== null" class="cell-sub-inline"> für {{ num.format(Math.round(data.pv.feed_in.exported_kwh)) }} kWh</span><span v-if="!data.pv.feed_in.complete" class="cell-sub-inline"> (Ablesungen unvollständig)</span>
                </template>
                <template v-else>keine Zählerdaten</template>
              </dd>
            </div>
          </dl>
          <p class="pv-status">
            <i :class="['pi', data.pv.status.exempt === true ? 'pi-check-circle' : data.pv.status.exempt === false ? 'pi-info-circle' : 'pi-question-circle']" aria-hidden="true" />
            <strong>{{ data.pv.status.exempt === true ? 'Steuerfrei' : data.pv.status.exempt === false ? 'Steuerpflichtig' : 'Status offen' }}</strong>
            {{ data.pv.status.reason }}
            <span v-if="data.pv.status.source === 'override'" class="cell-sub-inline">(manuell festgelegt)</span>
          </p>
        </div>
      </section>

      <section class="section">
        <header class="section-head">
          <h2>Einnahmen-Überschuss-Rechnung {{ year }}</h2>
          <span class="section-actions">
            <Button v-if="canWrite" label="Zeilen" icon="pi pi-sliders-h" size="small" severity="secondary" outlined @click="openLinesEdit" />
            <Button label="PDF" icon="pi pi-file-pdf" size="small" severity="secondary" outlined :loading="pdfBusy" :disabled="!euer" @click="downloadPdf" />
          </span>
        </header>

        <ErrorBanner v-if="euerError" :message="euerError" closable @retry="loadEuer" @close="euerError = null" />
        <PageSkeleton v-else-if="euerLoading && !euer" variant="list" :count="4" />
        <template v-else-if="euer">
          <Message v-if="euer.tax_exempt?.exempt === true" severity="info" :closable="false">
            Steuerfrei nach § 3 Nr. 72 EStG: diese Aufstellung dient nur der Information, nichts davon gehört in die Anlage G oder die Anlage EÜR.
          </Message>
          <p class="euer-intro">
            <template v-if="euer.tag">Buchungen mit dem Tag „{{ euer.tag }}“ ({{ euer.booking_count }} in {{ euer.year }}), nach ihren weiteren Tags den Zeilen zugeordnet; die AfA kommt aus dem Anlagenverzeichnis.</template>
            <template v-else>Der Betrieb hat noch keinen Buchungs-Tag. Trage ihn unter „Betrieb bearbeiten“ ein, damit seine Buchungen hier erscheinen.</template>
            <RouterLink v-if="documentsRoute" :to="documentsRoute" class="euer-docs-link">Belege {{ year }} in den Dokumenten</RouterLink>
          </p>

          <ScrollX>
            <table class="euer-table">
              <tbody>
                <tr class="euer-head"><th colspan="3">Betriebseinnahmen</th></tr>
                <template v-for="l in euer.income" :key="lineKey(l)">
                  <tr :class="['euer-line', { 'euer-line--other': l.other }]">
                    <td class="euer-form">{{ l.form_line ?? '' }}</td>
                    <td>
                      <button v-if="l.count" type="button" class="euer-toggle" :aria-expanded="euerOpen.has(lineKey(l))" @click="toggleLine(l)">
                        <i :class="['pi', euerOpen.has(lineKey(l)) ? 'pi-chevron-down' : 'pi-chevron-right']" aria-hidden="true" />
                        {{ l.name }} <span class="cell-sub-inline">({{ l.count }})</span>
                      </button>
                      <span v-else class="euer-empty">{{ l.name }}</span>
                    </td>
                    <td class="col-num">{{ cents(l.sum) }}</td>
                  </tr>
                  <tr v-for="b in (euerOpen.has(lineKey(l)) ? l.bookings : [])" :key="b.id" class="euer-booking">
                    <td></td>
                    <td><RouterLink :to="{ name: 'finance-transaction-detail', params: { id: b.id } }">{{ fmtDate(b.booking_date) }} · {{ b.counterparty ?? '–' }}<span v-if="b.purpose" class="cell-sub-inline"> · {{ b.purpose }}</span></RouterLink><span v-if="!b.is_tax_relevant" class="euer-flag"> nicht steuerrelevant</span></td>
                    <td class="col-num">{{ money(b.amount) }}</td>
                  </tr>
                </template>
                <tr class="euer-sum"><td></td><td>Summe Betriebseinnahmen</td><td class="col-num">{{ cents(euer.total_income) }}</td></tr>

                <tr class="euer-head"><th colspan="3">Betriebsausgaben</th></tr>
                <template v-for="l in euer.expenses" :key="lineKey(l)">
                  <tr :class="['euer-line', { 'euer-line--other': l.other }]">
                    <td class="euer-form">{{ l.form_line ?? '' }}</td>
                    <td>
                      <button v-if="l.count" type="button" class="euer-toggle" :aria-expanded="euerOpen.has(lineKey(l))" @click="toggleLine(l)">
                        <i :class="['pi', euerOpen.has(lineKey(l)) ? 'pi-chevron-down' : 'pi-chevron-right']" aria-hidden="true" />
                        {{ l.name }} <span class="cell-sub-inline">({{ l.count }})</span>
                      </button>
                      <span v-else class="euer-empty">{{ l.name }}</span>
                    </td>
                    <td class="col-num">{{ cents(l.sum) }}</td>
                  </tr>
                  <tr v-for="b in (euerOpen.has(lineKey(l)) ? l.bookings : [])" :key="b.id" class="euer-booking">
                    <td></td>
                    <td><RouterLink :to="{ name: 'finance-transaction-detail', params: { id: b.id } }">{{ fmtDate(b.booking_date) }} · {{ b.counterparty ?? '–' }}<span v-if="b.purpose" class="cell-sub-inline"> · {{ b.purpose }}</span></RouterLink><span v-if="!b.is_tax_relevant" class="euer-flag"> nicht steuerrelevant</span></td>
                    <td class="col-num">{{ money(b.amount) }}</td>
                  </tr>
                </template>
                <tr class="euer-line">
                  <td class="euer-form"></td>
                  <td>Absetzung für Abnutzung (AfA)<span v-if="euer.afa.assets.length" class="cell-sub-inline"> ({{ euer.afa.assets.map((a) => a.name).join(', ') }})</span></td>
                  <td class="col-num">{{ cents(euer.afa.sum) }}</td>
                </tr>
                <tr class="euer-sum"><td></td><td>Summe Betriebsausgaben</td><td class="col-num">{{ cents(euer.total_expenses) }}</td></tr>

                <tr class="euer-result"><td></td><td>{{ euer.result >= 0 ? 'Gewinn' : 'Verlust' }}</td><td class="col-num">{{ cents(euer.result) }}</td></tr>
              </tbody>
            </table>
          </ScrollX>

          <ul v-if="euer.hints.length" class="euer-hints">
            <li v-for="h in euer.hints" :key="h">{{ h }}</li>
          </ul>
        </template>
      </section>

      <section v-if="data.business.kind === 'landwirtschaft' || data.parcels.length > 0 || canWrite" class="section">
        <header class="section-head">
          <h2>Flächen</h2>
          <Button v-if="canWrite" label="Fläche" icon="pi pi-plus" size="small" severity="secondary" outlined @click="openParcelCreate" />
        </header>

        <EmptyState
          v-if="data.parcels.length === 0"
          icon="pi pi-map"
          title="Noch keine Fläche"
          message="Flurstücke mit Gemarkung, Größe, Nutzung, Pächter und Jahrespacht."
        />
        <ScrollX v-else>
          <DataTable :value="data.parcels" size="small" data-key="id" class="parcels-table">
            <Column header="Flurstück">
              <template #body="{ data: p }">
                <span class="cell-name">{{ parcelLabel(p) }}</span>
                <span class="cell-sub">{{ parcelUsageLabel(p.usage) }}</span>
              </template>
            </Column>
            <Column header="Fläche" class="col-num">
              <template #body="{ data: p }">{{ p.area_m2 === null ? '–' : `${num.format(p.area_m2)} m²` }}</template>
            </Column>
            <Column header="Pächter">
              <template #body="{ data: p }">
                <span class="cell-name">{{ p.lessee ?? '–' }}</span>
                <span v-if="p.lease_from || p.lease_to" class="cell-sub">{{ fmtDate(p.lease_from) }} – {{ p.lease_to ? fmtDate(p.lease_to) : 'offen' }}</span>
              </template>
            </Column>
            <Column header="Pacht / Jahr" class="col-num">
              <template #body="{ data: p }">{{ money(p.annual_rent) }}</template>
            </Column>
            <Column v-if="canWrite" class="col-actions">
              <template #body="{ data: p }">
                <Button icon="pi pi-pencil" text rounded size="small" aria-label="Fläche bearbeiten" @click="openParcelEdit(p)" />
                <Button icon="pi pi-trash" text rounded size="small" severity="danger" aria-label="Fläche löschen" @click="removeParcel(p)" />
              </template>
            </Column>
            <template #footer>
              <div class="totals">
                <span>{{ num.format(data.totals.area_m2) }} m² gesamt</span>
                <span>Pacht / Jahr: <strong>{{ money(data.totals.annual_rent) }}</strong></span>
              </div>
            </template>
          </DataTable>
        </ScrollX>
      </section>

      <section class="section">
        <header class="section-head">
          <h2>Dokumente</h2>
          <Button v-if="canWrite" label="Dokument verknüpfen" icon="pi pi-link" size="small" severity="secondary" outlined @click="openLink()" />
        </header>

        <ErrorBanner v-if="docsError" :message="docsError" closable @retry="loadDocs" @close="docsError = null" />
        <PageSkeleton v-else-if="docsLoading && docs.length === 0" variant="list" :count="3" />
        <EmptyState
          v-else-if="docs.length === 0"
          icon="pi pi-file"
          title="Noch kein Dokument verknüpft"
          message="Pachtverträge an die Fläche, Rechnungen ans Anlagegut, Bescheide an den Betrieb."
        />
        <div v-else class="doc-groups">
          <div v-for="g in docGroups" :key="g.key" class="doc-group">
            <h3 class="doc-group-title">{{ g.label }}</h3>
            <ul class="doc-list">
              <li v-for="d in g.items" :key="d.id" class="doc-row">
                <RouterLink v-if="d.document" :to="`/dokumente/${d.document_id}`" class="doc-main">
                  <span class="cell-name">{{ docTitle(d) }}</span>
                  <span class="cell-sub">{{ [fmtDate(d.document.doc_date), d.document.correspondent_display ?? d.document.sender, d.note].filter((x) => x && x !== '–').join(' · ') }}</span>
                </RouterLink>
                <span v-else class="doc-main">
                  <span class="cell-name">{{ docTitle(d) }}</span>
                  <span v-if="d.note" class="cell-sub">{{ d.note }}</span>
                </span>
                <Button v-if="canWrite" icon="pi pi-times" text rounded size="small" aria-label="Verknüpfung lösen" @click="removeDoc(d)" />
              </li>
            </ul>
          </div>
        </div>
      </section>
    </template>

    <!-- link a document -->
    <Dialog v-model:visible="linkDialog" modal header="Dokument verknüpfen" class="dialog-md">
      <Message v-if="linkError" severity="error" :closable="false">{{ linkError }}</Message>
      <div class="field">
        <label for="l-target">Verknüpfen mit</label>
        <Select id="l-target" v-model="linkTarget" :options="targetOptions" option-label="label" option-value="value" />
      </div>
      <div class="field">
        <label for="l-note">Notiz (optional)</label>
        <InputText id="l-note" v-model="linkNote" placeholder="z. B. Pacht ab 2025" />
      </div>
      <div class="field">
        <label for="l-q">Dokument suchen</label>
        <InputText v-bind="searchInputAttrs" id="l-q" v-model="linkQuery" placeholder="Titel, Absender, Inhalt …" @input="onLinkQuery" />
        <label v-if="data?.business.document_category" class="field-check">
          <input v-model="linkOnlyCategory" type="checkbox" /> nur Kategorie „{{ data.business.document_category }}“
        </label>
      </div>
      <PageSkeleton v-if="linkSearching && linkResults.length === 0" variant="list" :count="3" />
      <p v-else-if="linkResults.length === 0" class="lines-intro">Keine Dokumente gefunden.</p>
      <ul v-else class="doc-list doc-list--pick">
        <li v-for="d in linkResults" :key="d.id" class="doc-row">
          <span class="doc-main">
            <span class="cell-name">{{ d.title ?? d.original_filename }}</span>
            <span class="cell-sub">{{ [fmtDate(d.doc_date), d.correspondent_display ?? d.sender, d.category_slug].filter((x) => x && x !== '–').join(' · ') }}</span>
          </span>
          <Button :label="alreadyLinked(d.id) ? 'Verknüpft' : 'Verknüpfen'" size="small" :disabled="alreadyLinked(d.id) || linkSaving" @click="pickDoc(d)" />
        </li>
      </ul>
      <template #footer>
        <Button label="Schließen" severity="secondary" text @click="linkDialog = false" />
      </template>
    </Dialog>

    <!-- business -->
    <Dialog v-model:visible="businessDialog" modal header="Betrieb bearbeiten" class="dialog-md">
      <Message v-if="businessError" severity="error" :closable="false">{{ businessError }}</Message>
      <div class="field"><label for="b-name">Name</label><InputText id="b-name" v-model="businessForm.name" /></div>
      <div class="field-row">
        <div class="field"><label for="b-kind">Art</label><Select id="b-kind" v-model="businessForm.kind" :options="BUSINESS_KIND_OPTIONS" option-label="label" option-value="value" /></div>
        <div class="field"><label for="b-section">Steuerformular</label><Select id="b-section" v-model="businessForm.tax_section" :options="TAX_SECTION_OPTIONS" option-label="label" option-value="value" /></div>
      </div>
      <div class="field-row">
        <div class="field">
          <label for="b-tag">Buchungs-Tag</label>
          <InputText id="b-tag" v-model="businessForm.booking_tag" placeholder="z. B. Landwirtschaft" />
          <small class="field-hint">Buchungen mit diesem Tag gehören zum Betrieb und bilden die EÜR.</small>
        </div>
        <div class="field">
          <label for="b-category">Dokumentkategorie</label>
          <InputText id="b-category" v-model="businessForm.document_category" placeholder="z. B. landwirtschaft" />
          <small class="field-hint">Kategorie-Slug, in den die Belege einsortiert werden.</small>
        </div>
      </div>
      <template v-if="businessForm.kind === 'photovoltaik'">
        <div class="field-row">
          <div class="field">
            <label for="b-kwp">Leistung in kWp</label>
            <InputNumber id="b-kwp" v-model="businessForm.pv_capacity_kwp" :min="0" :max="10000" :min-fraction-digits="0" :max-fraction-digits="3" locale="de-DE" suffix=" kWp" />
            <small class="field-hint">Bis 30 kWp sind die Einnahmen ab 2022 steuerfrei (§ 3 Nr. 72 EStG).</small>
          </div>
          <div class="field">
            <label for="b-commissioned">Inbetriebnahme</label>
            <DatePicker id="b-commissioned" v-model="businessForm.pv_commissioned_on" date-format="dd.mm.yy" show-icon fluid show-clear />
          </div>
        </div>
        <div class="field">
          <label for="b-pv-tax">Steuerlicher Status</label>
          <Select id="b-pv-tax" v-model="businessForm.pv_tax_override" :options="PV_TAX_OPTIONS" option-label="label" option-value="value" />
          <small class="field-hint">Nur festlegen, wenn die einfache Regel nicht passt (mehrere Anlagen, Mehrfamilienhaus).</small>
        </div>
      </template>
      <div class="field"><label for="b-notes">Notizen</label><Textarea id="b-notes" v-model="businessForm.notes" rows="3" auto-resize /></div>
      <template #footer>
        <Button label="Abbrechen" severity="secondary" text @click="businessDialog = false" />
        <Button label="Speichern" icon="pi pi-check" :loading="businessSaving" @click="saveBusiness" />
      </template>
    </Dialog>

    <!-- EÜR lines -->
    <Dialog v-model:visible="linesDialog" modal header="Zeilen der Anlage EÜR" class="dialog-lg">
      <Message v-if="linesError" severity="error" :closable="false">{{ linesError }}</Message>
      <p class="lines-intro">Eine Buchung landet in der ersten Zeile, die einen ihrer Tags nennt. Was keine Zeile nennt, steht unter „Sonstige“. Die Formularzeile ist frei wählbar und erscheint im PDF.</p>
      <div v-for="(l, i) in lineForms" :key="i" class="line-row">
        <InputText v-model="l.name" placeholder="Bezeichnung" :aria-label="`Zeile ${i + 1}: Bezeichnung`" class="line-name" />
        <Select v-model="l.kind" :options="LINE_KIND_OPTIONS" option-label="label" option-value="value" :aria-label="`Zeile ${i + 1}: Art`" class="line-kind" />
        <InputText v-model="l.tags" placeholder="Tags, durch Komma getrennt" :aria-label="`Zeile ${i + 1}: Tags`" class="line-tags" />
        <InputText v-model="l.form_line" placeholder="Formularzeile" :aria-label="`Zeile ${i + 1}: Formularzeile`" class="line-form" />
        <span class="line-actions">
          <Button icon="pi pi-arrow-up" text rounded size="small" :disabled="i === 0" aria-label="Zeile nach oben" @click="moveLine(i, -1)" />
          <Button icon="pi pi-arrow-down" text rounded size="small" :disabled="i === lineForms.length - 1" aria-label="Zeile nach unten" @click="moveLine(i, 1)" />
          <Button icon="pi pi-trash" text rounded size="small" severity="danger" aria-label="Zeile entfernen" @click="removeLine(i)" />
        </span>
      </div>
      <div class="line-add">
        <Button label="Einnahme-Zeile" icon="pi pi-plus" size="small" severity="secondary" text @click="addLine('income')" />
        <Button label="Ausgabe-Zeile" icon="pi pi-plus" size="small" severity="secondary" text @click="addLine('expense')" />
      </div>
      <template #footer>
        <Button label="Abbrechen" severity="secondary" text @click="linesDialog = false" />
        <Button label="Speichern" icon="pi pi-check" :loading="linesSaving" @click="saveLines" />
      </template>
    </Dialog>

    <!-- asset -->
    <Dialog v-model:visible="assetDialog" modal :header="assetId ? 'Anlagegut bearbeiten' : 'Neues Anlagegut'" class="dialog-md">
      <Message v-if="assetError" severity="error" :closable="false">{{ assetError }}</Message>
      <div class="field"><label for="a-name">Bezeichnung</label><InputText id="a-name" v-model="assetForm.name" autofocus placeholder="z. B. Stallgebäude" /></div>
      <div class="field-row">
        <div class="field"><label for="a-kind">Art</label><Select id="a-kind" v-model="assetForm.kind" :options="ASSET_KIND_OPTIONS" option-label="label" option-value="value" @update:model-value="onAssetKindChange" /></div>
        <div class="field">
          <label for="a-rate">AfA-Satz in %</label>
          <InputNumber id="a-rate" v-model="assetForm.afa_rate_pct" :min="0" :max="100" :min-fraction-digits="0" :max-fraction-digits="3" :disabled="assetForm.kind === 'flaeche'" suffix=" %" />
        </div>
      </div>
      <div class="field-row">
        <div class="field"><label for="a-date">Anschaffungsdatum</label><DatePicker id="a-date" v-model="assetForm.acquisition_date" date-format="dd.mm.yy" show-icon fluid /></div>
        <div class="field">
          <label for="a-cost">Anschaffungskosten</label>
          <InputNumber id="a-cost" v-model="assetForm.acquisition_cost" mode="currency" currency="EUR" locale="de-DE" :min="0" />
          <small class="field-hint">Bemessungsgrundlage der AfA. Ohne Vorsteuerabzug brutto eingeben, mit Vorsteuerabzug netto.</small>
        </div>
      </div>
      <div class="field">
        <label for="a-start">AfA-Beginn (nur wenn abweichend, z. B. Fertigstellung)</label>
        <DatePicker id="a-start" v-model="assetForm.afa_start_date" date-format="dd.mm.yy" show-icon fluid show-clear />
      </div>
      <div class="field-row">
        <div class="field"><label for="a-disposal">Veräußert am</label><DatePicker id="a-disposal" v-model="assetForm.disposal_date" date-format="dd.mm.yy" show-icon fluid show-clear /></div>
        <div class="field"><label for="a-proceeds">Erlös</label><InputNumber id="a-proceeds" v-model="assetForm.disposal_proceeds" mode="currency" currency="EUR" locale="de-DE" :min="0" :disabled="!assetForm.disposal_date" /></div>
      </div>
      <div class="field"><label for="a-notes">Notizen</label><Textarea id="a-notes" v-model="assetForm.notes" rows="2" auto-resize /></div>
      <template #footer>
        <Button label="Abbrechen" severity="secondary" text @click="assetDialog = false" />
        <Button label="Speichern" icon="pi pi-check" :loading="assetSaving" @click="saveAsset" />
      </template>
    </Dialog>

    <!-- schedule -->
    <Dialog v-model:visible="scheduleDialog" modal :header="scheduleAsset ? `AfA-Plan: ${scheduleAsset.name}` : 'AfA-Plan'" class="dialog-md">
      <p v-if="scheduleAsset" class="schedule-intro">
        {{ money(scheduleAsset.acquisition_cost) }} ab {{ fmtDate(scheduleAsset.afa_start_date ?? scheduleAsset.acquisition_date) }},
        linear {{ pct(scheduleAsset.afa_rate_pct) }} jährlich, im ersten und letzten Jahr monatsgenau, bis auf 1 € Erinnerungswert.
      </p>
      <PageSkeleton v-if="scheduleLoading" variant="list" :count="4" />
      <DataTable v-else :value="scheduleRows" size="small" data-key="year" scrollable scroll-height="50vh">
        <Column field="year" header="Jahr" />
        <Column header="Monate" class="col-num"><template #body="{ data: r }">{{ r.months }}</template></Column>
        <Column header="AfA" class="col-num"><template #body="{ data: r }">{{ money(r.afa) }}</template></Column>
        <Column header="kumuliert" class="col-num"><template #body="{ data: r }">{{ money(r.accumulated) }}</template></Column>
        <Column header="Buchwert" class="col-num">
          <template #body="{ data: r }">{{ money(r.book_value) }}<span v-if="r.disposal_result !== null" class="cell-sub">Veräußerung {{ money(r.disposal_result) }}</span></template>
        </Column>
      </DataTable>
      <template #footer>
        <Button label="Schließen" severity="secondary" text @click="scheduleDialog = false" />
      </template>
    </Dialog>

    <!-- parcel -->
    <Dialog v-model:visible="parcelDialog" modal :header="parcelId ? 'Fläche bearbeiten' : 'Neue Fläche'" class="dialog-md">
      <Message v-if="parcelError" severity="error" :closable="false">{{ parcelError }}</Message>
      <div class="field-row field-row--3">
        <div class="field"><label for="p-gemarkung">Gemarkung</label><InputText id="p-gemarkung" v-model="parcelForm.gemarkung" autofocus /></div>
        <div class="field"><label for="p-flur">Flur</label><InputText id="p-flur" v-model="parcelForm.flur" /></div>
        <div class="field"><label for="p-flurstueck">Flurstück</label><InputText id="p-flurstueck" v-model="parcelForm.flurstueck" placeholder="z. B. 12/3" /></div>
      </div>
      <div class="field-row">
        <div class="field"><label for="p-area">Fläche in m²</label><InputNumber id="p-area" v-model="parcelForm.area_m2" :min="0" locale="de-DE" suffix=" m²" /></div>
        <div class="field"><label for="p-usage">Nutzung</label><Select id="p-usage" v-model="parcelForm.usage" :options="PARCEL_USAGE_OPTIONS" option-label="label" option-value="value" /></div>
      </div>
      <div class="field"><label for="p-lessee">Pächter</label><InputText id="p-lessee" v-model="parcelForm.lessee" /></div>
      <div class="field-row field-row--3">
        <div class="field"><label for="p-from">Pacht von</label><DatePicker id="p-from" v-model="parcelForm.lease_from" date-format="dd.mm.yy" show-icon fluid show-clear /></div>
        <div class="field"><label for="p-to">Pacht bis</label><DatePicker id="p-to" v-model="parcelForm.lease_to" date-format="dd.mm.yy" show-icon fluid show-clear /></div>
        <div class="field"><label for="p-rent">Pacht / Jahr</label><InputNumber id="p-rent" v-model="parcelForm.annual_rent" mode="currency" currency="EUR" locale="de-DE" :min="0" /></div>
      </div>
      <div v-if="landAssets.length > 1" class="field">
        <label for="p-asset">Anlagegut (Grund und Boden mit den Anschaffungskosten)</label>
        <Select id="p-asset" v-model="parcelForm.asset_id" :options="landAssets" option-label="name" option-value="id" />
      </div>
      <div class="field"><label for="p-notes">Notizen</label><Textarea id="p-notes" v-model="parcelForm.notes" rows="2" auto-resize /></div>
      <template #footer>
        <Button label="Abbrechen" severity="secondary" text @click="parcelDialog = false" />
        <Button label="Speichern" icon="pi pi-check" :loading="parcelSaving" @click="saveParcel" />
      </template>
    </Dialog>
  </PageLayout>
</template>

<style scoped>
/* Page frame and title: PageLayout (issue #1272). */
.year-select {
  min-width: 6rem;
}

.notes {
  margin: 0 0 var(--space-4);
  color: var(--p-text-muted-color);
  white-space: pre-line;
}

.section {
  margin-bottom: var(--space-6);
}

.section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  margin-bottom: var(--space-3);
}

.section-head h2 {
  margin: 0;
  font-size: var(--text-lg);
  font-weight: 600;
}

.cell-name {
  display: block;
}

.cell-sub {
  display: block;
  color: var(--p-text-muted-color);
  font-size: var(--text-sm);
}

:deep(.col-num),
:deep(.col-num .p-datatable-column-header-content) {
  text-align: right;
  justify-content: flex-end;
  white-space: nowrap;
}

:deep(.col-actions) {
  white-space: nowrap;
  text-align: right;
}

.totals {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2) var(--space-5);
  justify-content: flex-end;
  font-size: var(--text-sm);
}

.doc-groups {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.doc-group-title {
  margin: 0 0 var(--space-2);
  font-size: var(--text-sm);
  font-weight: 600;
  color: var(--p-text-muted-color);
}

.doc-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.doc-list--pick {
  max-height: 40vh;
  overflow-y: auto;
  padding: var(--focus-ring-reach);
  margin: calc(-1 * var(--focus-ring-reach));
}

.doc-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border-radius: 0.5rem;
  background: var(--p-content-background);
  border: 1px solid var(--p-content-border-color);
}

.doc-main {
  flex: 1;
  min-width: 0;
  color: inherit;
  text-decoration: none;
}

a.doc-main:hover .cell-name {
  text-decoration: underline;
}

a.doc-main:focus-visible {
  outline: var(--focus-ring);
  outline-offset: var(--focus-ring-offset);
}

.field-check {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--text-sm);
  color: var(--p-text-muted-color);
}

.section-link {
  font-size: var(--text-sm);
}

.pv-card {
  padding: var(--space-3);
  border-radius: 0.5rem;
  background: var(--p-content-background);
  border: 1px solid var(--p-content-border-color);
}

.pv-card--exempt {
  border-color: var(--p-tag-success-color);
}

.pv-facts {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr));
  gap: var(--space-3);
  margin: 0 0 var(--space-3);
}

.pv-facts dt {
  color: var(--p-text-muted-color);
  font-size: var(--text-xs);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.pv-facts dd {
  margin: 0;
  font-weight: 600;
}

.pv-status {
  margin: 0;
  display: flex;
  gap: var(--space-2);
  align-items: baseline;
  flex-wrap: wrap;
}

.pv-card--exempt .pv-status .pi {
  color: var(--p-tag-success-color);
}

.section-actions {
  display: flex;
  gap: var(--space-2);
  align-items: center;
}

.euer-intro {
  margin: 0 0 var(--space-3);
  color: var(--p-text-muted-color);
  font-size: var(--text-sm);
}

.euer-docs-link {
  margin-left: var(--space-2);
}

.euer-table {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--text-sm);
}

.euer-table td,
.euer-table th {
  padding: var(--space-1) var(--space-2);
  border-bottom: 1px solid var(--p-content-border-color);
  text-align: left;
  vertical-align: top;
}

.euer-head th {
  padding-top: var(--space-3);
  font-weight: 600;
  background: var(--p-content-hover-background);
}

.euer-form {
  width: 6rem;
  color: var(--p-text-muted-color);
  white-space: nowrap;
}

.euer-toggle {
  background: none;
  border: 0;
  padding: 0;
  font: inherit;
  color: inherit;
  cursor: pointer;
  text-align: left;
}

.euer-toggle:focus-visible {
  outline: var(--focus-ring);
  outline-offset: var(--focus-ring-offset);
}

.euer-empty,
.euer-booking td {
  color: var(--p-text-muted-color);
}

.euer-booking td:nth-child(2) {
  padding-left: var(--space-5);
}

.euer-line--other td:nth-child(2) {
  font-style: italic;
}

.euer-flag {
  color: var(--p-tag-warn-color);
  font-size: var(--text-xs);
}

.euer-sum td {
  font-weight: 600;
}

.euer-result td {
  font-weight: 700;
  font-size: var(--text-base);
  border-top: 2px solid var(--p-text-color);
  border-bottom: 0;
}

.cell-sub-inline {
  color: var(--p-text-muted-color);
  font-size: var(--text-xs);
}

.euer-hints {
  margin: var(--space-3) 0 0;
  padding-left: var(--space-4);
  color: var(--p-text-muted-color);
  font-size: var(--text-sm);
}

.field-hint {
  color: var(--p-text-muted-color);
  font-size: var(--text-xs);
}

.lines-intro {
  margin: 0 0 var(--space-3);
  color: var(--p-text-muted-color);
  font-size: var(--text-sm);
}

.line-row {
  display: grid;
  grid-template-columns: minmax(8rem, 2fr) 8rem minmax(8rem, 3fr) 7rem auto;
  gap: var(--space-2);
  align-items: center;
  margin-bottom: var(--space-2);
}

.line-actions {
  white-space: nowrap;
}

.line-add {
  display: flex;
  gap: var(--space-2);
}

@media (max-width: 767px) {
  .line-row {
    grid-template-columns: 1fr 1fr;
  }
  .line-tags,
  .line-actions {
    grid-column: 1 / -1;
  }
}

.schedule-intro {
  margin: 0 0 var(--space-3);
  color: var(--p-text-muted-color);
  font-size: var(--text-sm);
}

.field {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  margin-bottom: var(--space-3);
  min-width: 0;
}

.field-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--space-3);
}

.field-row--3 {
  grid-template-columns: 1fr 1fr 1fr;
}

@media (max-width: 639px) {
  .field-row,
  .field-row--3 {
    grid-template-columns: 1fr;
  }
}
</style>
