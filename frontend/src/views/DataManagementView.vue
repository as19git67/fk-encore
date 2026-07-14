<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import Button from 'primevue/button'
import Checkbox from 'primevue/checkbox'
import ProgressBar from 'primevue/progressbar'
import Message from 'primevue/message'
import RadioButton from 'primevue/radiobutton'
import Dialog from 'primevue/dialog'
import InputText from 'primevue/inputtext'
import CorrespondentOverridesPanel from '../components/CorrespondentOverridesPanel.vue'
import {
  getScanQueueStatus, rescanPhotos, retryFailedScans, cancelPendingScans,
  redetectMissingPois,
  redetectEmptyPois,
  getScanQueueFailures,
  findPhotoGroups,
  recomputeAiPicks,
  getAiPickCalibration,
  calibrateAiPickWeights,
  backfillPhotoDimensions,
  type AiPickWeightsCalibrationResult,
  getPhotosToRefreshMetadata, refreshPhotoMetadata,
  getPhotosNeedingGpsRescan, rescanPhotoGps,
  recomputeAutoCrops,
  recomputeTransformSuggestions,
  purgePhotos,
  type ScanQueueStatus,
  type PurgeResult,
} from '../api/photos'
import QueueErrorsDialog from '../components/QueueErrorsDialog.vue'
import {
  getFinanceTagQueueStatus, retryFailedFinanceTagJobs,
  cancelPendingFinanceTagJobs, reenqueueAllFinanceTagJobs,
  type TagQueueServiceStatus,
} from '../api/finance'
import {
  getDocumentQueueStatus, reclassifyAllDocuments, relocateAllDocuments,
  cancelDocumentQueue, retryDocumentQueue,
  type DocQueueStatus,
  type ReclassifyAllMode,
  type RelocateAllDocumentsResponse,
} from '../api/documents'
import {
  listOsmRegions, suggestOsmRegion, createOsmRegion,
  approveOsmRegion, deleteOsmRegion, reverseGeocodeViaOsm,
  bulkSuggestOsmRegions, refreshOsmRegion,
  type OsmRegionImport, type RegionSuggestion,
  type BulkSuggestResult, type BulkRegionSuggestion, type RedundantRegion,
} from '../api/osmAdmin'
import { getBuildInfo } from '../api/system'
import { useAuthStore } from '../stores/auth'
import { useRealtimeEvent } from '../composables/useRealtime'

const auth = useAuthStore()
const canPurgePhotos = computed(() => auth.hasPermission('photos.purge'))
const canManageOsm = computed(() => auth.hasPermission('osm.admin'))

// ── Scan Queue ────────────────────────────────────────────────────────────────

const queueStatus = ref<ScanQueueStatus>({ services: [] })
const queueError = ref('')
const rescanLoading = ref(false)
const retryLoading = ref(false)
const cancelLoading = ref(false)
const cancelledPending = ref(false)  // true after cancel until queue settles
const poiRedetectLoading = ref(false)
const poiRedetectResult = ref<number | null>(null)  // queued count after a run
const poiRedetectEmptyLoading = ref(false)
const poiRedetectEmptyResult = ref<number | null>(null)  // queued count after a run

const serviceLabels: Record<string, string> = {
  embedding: 'Ähnlichkeitsanalyse',
  face_detection: 'Gesichtserkennung',
  face_assignment: 'Gesichtszuordnung',
  landmark: 'Sehenswürdigkeiten (Legacy)',
  poi_detection: 'POI-Erkennung',
  quality: 'Qualität',
  geocoding: 'Geocoding',
  thumbnail: 'Vorschaubilder',
}

// ── Failed-jobs detail dialog ─────────────────────────────────────────────────
// Clicking a service's "Fehler" count opens a grouped breakdown of the
// failed jobs (error message · count · last failure · sample photo ids).
const failuresDialogVisible = ref(false)
const failuresService = ref<string | null>(null)

const failuresTitle = computed(() =>
  failuresService.value
    ? `Fehler — ${serviceLabels[failuresService.value] ?? failuresService.value}`
    : 'Fehler',
)
const failuresLoader = computed(() => {
  const svc = failuresService.value
  return svc ? () => getScanQueueFailures(svc).then((r) => r.groups) : null
})

function openFailures(service: string) {
  failuresService.value = service
  failuresDialogVisible.value = true
}

const totalPending = computed(() =>
  queueStatus.value.services.reduce((s, svc) => s + svc.pending, 0)
)
const totalProcessing = computed(() =>
  queueStatus.value.services.reduce((s, svc) => s + svc.processing, 0)
)
const totalFailed = computed(() =>
  queueStatus.value.services.reduce((s, svc) => s + svc.failed, 0)
)
const isActive = computed(() => totalPending.value > 0 || totalProcessing.value > 0)

async function fetchQueueStatus() {
  try {
    queueStatus.value = await getScanQueueStatus()
    if (cancelledPending.value && !isActive.value) {
      cancelledPending.value = false
    }
  } catch {
    // ignore transient errors — next push event will refresh
  }
}

// Push updates: backend emits `scan-queue/state.changed` (debounced to
// at most one event every 500ms) for every queue mutation. We just
// refetch — the REST endpoint remains the source of truth. The
// WebSocket bus auto-reconnects with exponential backoff and replays
// the outbox on resume, so no separate polling fallback is needed.
useRealtimeEvent('scan-queue', 'state.changed', () => {
  fetchQueueStatus()
})

async function handleRescan(force: boolean) {
  queueError.value = ''
  rescanLoading.value = true
  try {
    await rescanPhotos(force)
  } catch (err: any) {
    queueError.value = err.message || 'Fehler beim Starten des Scans'
  } finally {
    rescanLoading.value = false
  }
}

async function handleRetry() {
  queueError.value = ''
  retryLoading.value = true
  try {
    await retryFailedScans()
  } catch (err: any) {
    queueError.value = err.message || 'Fehler beim Wiederholen'
  } finally {
    retryLoading.value = false
  }
}

async function handlePoiRedetect() {
  queueError.value = ''
  poiRedetectResult.value = null
  poiRedetectLoading.value = true
  try {
    const { queued } = await redetectMissingPois()
    poiRedetectResult.value = queued
  } catch (err: any) {
    queueError.value = err.message || 'Fehler beim Nachholen der POI-Erkennung'
  } finally {
    poiRedetectLoading.value = false
  }
}

async function handlePoiRedetectEmpty() {
  queueError.value = ''
  poiRedetectEmptyResult.value = null
  poiRedetectEmptyLoading.value = true
  try {
    const { queued } = await redetectEmptyPois()
    poiRedetectEmptyResult.value = queued
  } catch (err: any) {
    queueError.value = err.message || 'Fehler beim erneuten Prüfen der POI-Erkennung'
  } finally {
    poiRedetectEmptyLoading.value = false
  }
}

async function handleCancel() {
  cancelLoading.value = true
  try {
    await cancelPendingScans()
    cancelledPending.value = true
  } catch (err: any) {
    queueError.value = err.message || 'Fehler beim Abbrechen'
  } finally {
    cancelLoading.value = false
  }
}

// ── Foto-Gruppen ──────────────────────────────────────────────────────────────

const groupingResult = ref<{ groups_created: number; total_photos_grouped: number } | null>(null)
const groupingLoading = ref(false)
const groupingError = ref('')

async function handleFindGroups() {
  groupingResult.value = null
  groupingError.value = ''
  groupingLoading.value = true
  try {
    groupingResult.value = await findPhotoGroups()
  } catch (err: any) {
    groupingError.value = err.message || 'Fehler beim Gruppieren'
  } finally {
    groupingLoading.value = false
  }
}

// ── KI-Auto-Pick (Track I) ────────────────────────────────────────────────────

const aiPickRecomputeResult = ref<{ groups_scored: number; groups_skipped: number } | null>(null)
const aiPickLoading = ref(false)
const aiPickError = ref('')

async function handleRecomputeAiPicks() {
  aiPickRecomputeResult.value = null
  aiPickError.value = ''
  aiPickLoading.value = true
  try {
    aiPickRecomputeResult.value = await recomputeAiPicks()
  } catch (err: any) {
    aiPickError.value = err.message || 'Fehler beim Neuberechnen der KI-Picks'
  } finally {
    aiPickLoading.value = false
  }
}

const dimensionsResult = ref<{ scanned: number; updated: number; failed: number } | null>(null)
const dimensionsLoading = ref(false)

async function handleBackfillDimensions() {
  dimensionsResult.value = null
  aiPickError.value = ''
  dimensionsLoading.value = true
  try {
    dimensionsResult.value = await backfillPhotoDimensions()
  } catch (err: any) {
    aiPickError.value = err.message || 'Fehler beim Befüllen der Bildmaße'
  } finally {
    dimensionsLoading.value = false
  }
}

const calibrationLoading = ref(false)

// Browser navigating to the endpoint URL fails because Encore's auth
// handler only accepts Authorization: Bearer (see user/auth-handler.ts).
// This button fetches via apiFetch (which adds the Bearer token) and
// triggers a blob download from the JSON in memory.
async function handleDownloadCalibration() {
  calibrationLoading.value = true
  aiPickError.value = ''
  try {
    const data = await getAiPickCalibration()
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `ai-pick-calibration-${new Date().toISOString().slice(0, 10)}.json`
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
  } catch (err: any) {
    aiPickError.value = err.message || 'Fehler beim Herunterladen des Kalibrierungs-Exports'
  } finally {
    calibrationLoading.value = false
  }
}

const calibrateWeightsLoading = ref(false)
const calibrateWeightsResult = ref<AiPickWeightsCalibrationResult | null>(null)

async function handleCalibrateWeights() {
  calibrateWeightsLoading.value = true
  calibrateWeightsResult.value = null
  aiPickError.value = ''
  try {
    calibrateWeightsResult.value = await calibrateAiPickWeights()
  } catch (err: any) {
    aiPickError.value = err.message || 'Fehler beim Kalibrieren der Gewichte'
  } finally {
    calibrateWeightsLoading.value = false
  }
}

function pct(v: number | undefined | null): string {
  if (v == null) return '–'
  return `${Math.round(v * 100)} %`
}

// ── Metadaten ─────────────────────────────────────────────────────────────────

const refreshingMetadata = ref(false)
const refreshProgress = ref(0)
const refreshTotal = ref(0)
const refreshCurrent = ref(0)
const metaError = ref('')

async function handleRefreshMetadata() {
  if (refreshingMetadata.value) return
  refreshingMetadata.value = true
  refreshProgress.value = 0
  refreshCurrent.value = 0
  refreshTotal.value = 0
  metaError.value = ''
  try {
    const res = await getPhotosToRefreshMetadata()
    if (res.ids.length === 0) { refreshingMetadata.value = false; return }
    refreshTotal.value = res.ids.length
    for (const id of res.ids) {
      try { await refreshPhotoMetadata(id) } catch {}
      refreshCurrent.value++
      refreshProgress.value = Math.round((refreshCurrent.value / refreshTotal.value) * 100)
    }
  } catch (err: any) {
    metaError.value = err.message || 'Fehler beim Aktualisieren der Metadaten'
  } finally {
    refreshingMetadata.value = false
  }
}

// ── GPS Re-Extraktion ─────────────────────────────────────────────────────────

const gpsRescanLoading = ref(false)
const gpsRescanProgress = ref(0)
const gpsRescanCurrent = ref(0)
const gpsRescanTotal = ref(0)
const gpsRescanResult = ref<{ gpsFound: number; geocoded: number; scansQueued: number } | null>(null)
const gpsRescanError = ref('')

async function handleGpsRescan() {
  if (gpsRescanLoading.value) return
  gpsRescanLoading.value = true
  gpsRescanProgress.value = 0
  gpsRescanCurrent.value = 0
  gpsRescanTotal.value = 0
  gpsRescanResult.value = null
  gpsRescanError.value = ''
  try {
    const { ids } = await getPhotosNeedingGpsRescan()
    if (ids.length === 0) {
      gpsRescanResult.value = { gpsFound: 0, geocoded: 0, scansQueued: 0 }
      return
    }
    gpsRescanTotal.value = ids.length
    let gpsFound = 0, geocoded = 0, scansQueued = 0
    for (const id of ids) {
      try {
        const res = await rescanPhotoGps(id)
        if (res.gpsFound) gpsFound++
        if (res.geocoded) geocoded++
        if (res.scansQueued) scansQueued++
      } catch { /* skip individual failures */ }
      gpsRescanCurrent.value++
      gpsRescanProgress.value = Math.round((gpsRescanCurrent.value / gpsRescanTotal.value) * 100)
      // Respect Nominatim rate limit (1 req/s)
      if (gpsRescanCurrent.value < ids.length) await new Promise(r => setTimeout(r, 1100))
    }
    gpsRescanResult.value = { gpsFound, geocoded, scansQueued }
  } catch (err: any) {
    gpsRescanError.value = err.message || 'Fehler beim GPS-Rescan'
  } finally {
    gpsRescanLoading.value = false
  }
}

// ── Auto-Crop ────────────────────────────────────────────────────────────────

const autoCropLoading = ref(false)
const autoCropResult = ref<{ updated: number } | null>(null)
const autoCropError = ref('')

// ── AI-Transform-Suggestions ─────────────────────────────────────────────────
const transformSuggestLoading = ref(false)
const transformSuggestResult = ref<{
  updated: number
  failed: number
  skipped: number
  total: number
} | null>(null)
const transformSuggestError = ref('')
const transformSuggestForce = ref(false)

async function handleRecomputeTransformSuggestions() {
  transformSuggestResult.value = null
  transformSuggestError.value = ''
  transformSuggestLoading.value = true
  try {
    transformSuggestResult.value = await recomputeTransformSuggestions({
      force: transformSuggestForce.value,
    })
  } catch (err: any) {
    transformSuggestError.value =
      err.message || 'Fehler beim Berechnen der KI-Crop-Vorschläge'
  } finally {
    transformSuggestLoading.value = false
  }
}

async function handleRecomputeAutoCrops() {
  autoCropResult.value = null
  autoCropError.value = ''
  autoCropLoading.value = true
  try {
    autoCropResult.value = await recomputeAutoCrops()
  } catch (err: any) {
    autoCropError.value = err.message || 'Fehler beim Berechnen der Auto-Crops'
  } finally {
    autoCropLoading.value = false
  }
}

// ── Danger Zone: Purge Photos ────────────────────────────────────────────────

const purgeDialogVisible = ref(false)
const purgeMode = ref<'db' | 'all'>('db')
const purgeConfirmText = ref('')
const purgeLoading = ref(false)
const purgeError = ref('')
const purgeResult = ref<PurgeResult | null>(null)

const PURGE_CONFIRM_KEYWORD = 'LÖSCHEN'
const canConfirmPurge = computed(
  () => purgeConfirmText.value.trim().toUpperCase() === PURGE_CONFIRM_KEYWORD && !purgeLoading.value
)

function openPurgeDialog() {
  purgeMode.value = 'db'
  purgeConfirmText.value = ''
  purgeError.value = ''
  purgeResult.value = null
  purgeDialogVisible.value = true
}

async function handlePurge() {
  if (!canConfirmPurge.value) return
  purgeLoading.value = true
  purgeError.value = ''
  try {
    const res = await purgePhotos(purgeMode.value === 'all')
    purgeResult.value = res
    purgeConfirmText.value = ''
    // Keep dialog open so the admin can inspect the result.
    await fetchQueueStatus()
  } catch (err: any) {
    purgeError.value = err.message || 'Fehler beim Löschen der Fotodaten'
  } finally {
    purgeLoading.value = false
  }
}

const purgeDbTotals = computed(() => {
  if (!purgeResult.value) return 0
  return Object.values(purgeResult.value.dbCounts).reduce((s, n) => s + n, 0)
})

// ── Finance Tag-Queue ─────────────────────────────────────────────────────────

const financeTagQueueStatus = ref<TagQueueServiceStatus>({ pending: 0, processing: 0, failed: 0, done: 0 })
const financeTagQueueError = ref('')
const financeTagRetryLoading = ref(false)
const financeTagCancelLoading = ref(false)
const financeTagReenqueueLoading = ref(false)
const financeTagCancelledPending = ref(false)

const financeTagIsActive = computed(
  () => financeTagQueueStatus.value.pending > 0 || financeTagQueueStatus.value.processing > 0
)

async function fetchFinanceTagQueueStatus() {
  try {
    const res = await getFinanceTagQueueStatus()
    financeTagQueueStatus.value = res.status
    if (financeTagCancelledPending.value && !financeTagIsActive.value) {
      financeTagCancelledPending.value = false
    }
  } catch {
    // ignore transient errors — next push event will refresh
  }
}

useRealtimeEvent('scan-queue', 'state.changed', () => {
  fetchFinanceTagQueueStatus()
  fetchDocQueueStatus()
})

async function handleFinanceTagRetry() {
  financeTagQueueError.value = ''
  financeTagRetryLoading.value = true
  try {
    await retryFailedFinanceTagJobs()
  } catch (err: any) {
    financeTagQueueError.value = err.message || 'Fehler beim Wiederholen'
  } finally {
    financeTagRetryLoading.value = false
  }
}

async function handleFinanceTagCancel() {
  financeTagCancelLoading.value = true
  try {
    await cancelPendingFinanceTagJobs()
    financeTagCancelledPending.value = true
  } catch (err: any) {
    financeTagQueueError.value = err.message || 'Fehler beim Abbrechen'
  } finally {
    financeTagCancelLoading.value = false
  }
}

async function handleFinanceTagReenqueue() {
  financeTagQueueError.value = ''
  financeTagReenqueueLoading.value = true
  try {
    await reenqueueAllFinanceTagJobs()
  } catch (err: any) {
    financeTagQueueError.value = err.message || 'Fehler beim Einreihen'
  } finally {
    financeTagReenqueueLoading.value = false
  }
}

// ── Document Scan-Queue & Reclassify-All ─────────────────────────────────────

const docQueueStatus = ref<DocQueueStatus>({ services: [] })
const docReclassifyLoading = ref(false)
const docReclassifyError = ref('')
const docReclassifyResult = ref<number | null>(null)
const docRelocateLoading = ref(false)
const docRelocateResult = ref<RelocateAllDocumentsResponse | null>(null)
const docCancelLoading = ref(false)
const docRetryLoading = ref(false)

const docQueueServiceLabels: Record<string, string> = {
  text_extract: 'OCR / Text',
  classify: 'KI-Klassifikation',
  embed: 'Embedding',
  receipt_ocr: 'Beleg-OCR (PaddleOCR)',
}

const docTotalPending = computed(() =>
  docQueueStatus.value.services.reduce((s, svc) => s + svc.pending, 0)
)
const docTotalProcessing = computed(() =>
  docQueueStatus.value.services.reduce((s, svc) => s + svc.processing, 0)
)
const docTotalFailed = computed(() =>
  docQueueStatus.value.services.reduce((s, svc) => s + svc.failed, 0)
)
const docIsActive = computed(
  () => docTotalPending.value > 0 || docTotalProcessing.value > 0
)

async function fetchDocQueueStatus() {
  try {
    docQueueStatus.value = await getDocumentQueueStatus()
  } catch {
    // ignore transient errors — next push event will refresh
  }
}

async function handleDocReclassifyAll(mode: ReclassifyAllMode) {
  docReclassifyError.value = ''
  docReclassifyResult.value = null
  docRelocateResult.value = null
  docReclassifyLoading.value = true
  try {
    const { queued } = await reclassifyAllDocuments(mode)
    docReclassifyResult.value = queued
    await fetchDocQueueStatus()
  } catch (err: any) {
    docReclassifyError.value = err.message || 'Fehler beim Einreihen'
  } finally {
    docReclassifyLoading.value = false
  }
}

async function handleDocRelocateAll() {
  docReclassifyError.value = ''
  docReclassifyResult.value = null
  docRelocateResult.value = null
  docRelocateLoading.value = true
  try {
    docRelocateResult.value = await relocateAllDocuments()
  } catch (err: any) {
    docReclassifyError.value = err.message || 'Fehler beim Aktualisieren der Dateipfade'
  } finally {
    docRelocateLoading.value = false
  }
}

async function handleDocCancel() {
  docReclassifyError.value = ''
  docCancelLoading.value = true
  try {
    await cancelDocumentQueue()
    await fetchDocQueueStatus()
  } catch (err: any) {
    docReclassifyError.value = err.message || 'Fehler beim Abbrechen'
  } finally {
    docCancelLoading.value = false
  }
}

async function handleDocRetry() {
  docReclassifyError.value = ''
  docRetryLoading.value = true
  try {
    await retryDocumentQueue()
    await fetchDocQueueStatus()
  } catch (err: any) {
    docReclassifyError.value = err.message || 'Fehler beim Wiederholen'
  } finally {
    docRetryLoading.value = false
  }
}

// ── Build-Info ────────────────────────────────────────────────────────────────

const buildNumber = ref('…')

// ── OSM region admin (Epic #383) ──────────────────────────────────────────────

const osmRegions = ref<OsmRegionImport[]>([])
const osmError = ref('')
const osmLoading = ref(false)
const osmRefreshTimer = ref<number | null>(null)

const suggestLat = ref<string>('')
const suggestLon = ref<string>('')

function parsedCoord(v: string): number | null {
  if (!v.trim()) return null
  const n = Number(v.replace(',', '.'))
  return Number.isFinite(n) ? n : null
}
const suggestResult = ref<RegionSuggestion | null>(null)
const suggestLoading = ref(false)

const reverseResult = ref<{ regionSlug: string; result: Record<string, unknown> } | null>(null)
const reverseLoading = ref(false)

const bulkSuggestResult = ref<BulkSuggestResult | null>(null)
const bulkLoading = ref(false)

const redundantSlugSet = computed<Set<string>>(() => {
  if (!bulkSuggestResult.value) return new Set()
  return new Set(bulkSuggestResult.value.redundantRegions.map((r: RedundantRegion) => r.slug))
})

function redundantVerdictLabel(rr: RedundantRegion): string {
  switch (rr.recommendation) {
    case 'delete':
      return rr.kind === 'covered_by_ancestor'
        ? 'löschen — bereits durch übergeordnete Region abgedeckt'
        : 'löschen spart Platz'
    case 'keep':
      return 'behalten — Subregionen brauchen mehr Platz'
    default:
      return 'Größe unbekannt — bitte prüfen'
  }
}

const osmStatusLabels: Record<string, string> = {
  pending_approval: 'Wartet auf Freigabe',
  importing: 'Wird importiert',
  ready_running: 'Bereit (läuft)',
  ready_stopped: 'Bereit (gestoppt)',
  blocked_disk: 'Blockiert (Speicher)',
  failed: 'Fehlgeschlagen',
}

const osmStatusSeverity: Record<string, string> = {
  pending_approval: 'warn',
  importing: 'info',
  ready_running: 'success',
  ready_stopped: 'secondary',
  blocked_disk: 'danger',
  failed: 'danger',
}

async function fetchOsmRegions() {
  if (!canManageOsm.value) return
  try {
    osmRegions.value = (await listOsmRegions()).regions
    osmError.value = ''
  } catch (err) {
    osmError.value = (err as Error).message ?? String(err)
  }
}

async function handleSuggestOsmRegion() {
  const lat = parsedCoord(suggestLat.value)
  const lon = parsedCoord(suggestLon.value)
  if (lat === null || lon === null) {
    osmError.value = 'Bitte gültige Lat/Lon eingeben.'
    return
  }
  suggestLoading.value = true
  try {
    suggestResult.value = (await suggestOsmRegion(lat, lon)).region
    osmError.value = ''
  } catch (err) {
    osmError.value = (err as Error).message ?? String(err)
  } finally {
    suggestLoading.value = false
  }
}

async function handleAddSuggestedRegion() {
  if (!suggestResult.value) return
  osmLoading.value = true
  try {
    await createOsmRegion(suggestResult.value.slug)
    await fetchOsmRegions()
    suggestResult.value = null
  } catch (err) {
    osmError.value = (err as Error).message ?? String(err)
  } finally {
    osmLoading.value = false
  }
}

async function handleApproveOsmRegion(slug: string) {
  osmLoading.value = true
  try {
    await approveOsmRegion(slug)
    await fetchOsmRegions()
  } catch (err) {
    osmError.value = (err as Error).message ?? String(err)
  } finally {
    osmLoading.value = false
  }
}

async function handleRefreshOsmRegion(slug: string) {
  osmLoading.value = true
  try {
    const r = await refreshOsmRegion(slug)
    if (!r.ok) {
      osmError.value = `Refresh ${slug}: ${r.detail ?? 'failed'}`
    }
    await fetchOsmRegions()
  } catch (err) {
    osmError.value = (err as Error).message ?? String(err)
  } finally {
    osmLoading.value = false
  }
}

async function handleDeleteOsmRegion(slug: string) {
  if (!window.confirm(`Region ${slug} entfernen? Droppt die PostGIS-Datenbank im geo-Service (Postgres-Daten gehen verloren, mehrere GB) und entfernt die DB-Zeile. Nicht rückgängig zu machen.`)) return
  osmLoading.value = true
  try {
    await deleteOsmRegion(slug)
    await fetchOsmRegions()
  } catch (err) {
    osmError.value = (err as Error).message ?? String(err)
  } finally {
    osmLoading.value = false
  }
}

async function handleBulkSuggest() {
  bulkLoading.value = true
  try {
    bulkSuggestResult.value = await bulkSuggestOsmRegions()
    osmError.value = ''
  } catch (err) {
    osmError.value = (err as Error).message ?? String(err)
  } finally {
    bulkLoading.value = false
  }
}

async function handleBulkCreate(s: BulkRegionSuggestion) {
  if (s.existing) return
  osmLoading.value = true
  try {
    await createOsmRegion(s.slug)
    // Refresh both the region table and the bulk view so the row
    // flips to "existing" without reloading the page.
    await Promise.all([fetchOsmRegions(), handleBulkSuggest()])
  } catch (err) {
    osmError.value = (err as Error).message ?? String(err)
  } finally {
    osmLoading.value = false
  }
}

async function handleReverseGeocode() {
  const lat = parsedCoord(suggestLat.value)
  const lon = parsedCoord(suggestLon.value)
  if (lat === null || lon === null) {
    osmError.value = 'Bitte gültige Lat/Lon eingeben.'
    return
  }
  reverseLoading.value = true
  try {
    reverseResult.value = await reverseGeocodeViaOsm(lat, lon)
    osmError.value = ''
  } catch (err) {
    osmError.value = (err as Error).message ?? String(err)
    reverseResult.value = null
  } finally {
    reverseLoading.value = false
  }
}

function formatRelative(ts: string | null): string {
  if (!ts) return '–'
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return ts
  return d.toLocaleString()
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

onMounted(async () => {
  await fetchQueueStatus()
  await fetchFinanceTagQueueStatus()
  await fetchDocQueueStatus()
  await fetchOsmRegions()
  getBuildInfo().then(info => { buildNumber.value = info.build })
  // Poll the OSM region list every 5s so importing/ready transitions
  // surface without a manual reload. Cheap query (single SELECT).
  if (canManageOsm.value) {
    osmRefreshTimer.value = window.setInterval(fetchOsmRegions, 5_000)
  }
})

onBeforeUnmount(() => {
  if (osmRefreshTimer.value !== null) {
    window.clearInterval(osmRefreshTimer.value)
    osmRefreshTimer.value = null
  }
})
</script>

<template>
  <div class="data-management-view">
    <h1 class="title">Datenverwaltung</h1>

    <!-- Scan Queue -->
    <div class="data-management-group">
      <h3>Scan-Queue</h3>
      <p>
        Hochgeladene Fotos werden im Hintergrund durch Gesichtserkennung, Embedding-Berechnung
        und Sehenswürdigkeiten-Erkennung geschickt.
      </p>

      <Message v-if="queueError" severity="error" class="mb-3" @close="queueError = ''">{{ queueError }}</Message>

      <!-- Status-Tabelle (Desktop) -->
      <div class="queue-table-wrapper">
        <table class="queue-table mb-4">
          <thead>
            <tr>
              <th>Service</th>
              <th>Ausstehend</th>
              <th>Läuft</th>
              <th>Fehler</th>
              <th>Erledigt</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="svc in queueStatus.services" :key="svc.service">
              <td>
                <div>{{ serviceLabels[svc.service] ?? svc.service }}</div>
              </td>
              <td>
                <span v-if="svc.pending > 0" class="badge badge-pending">{{ svc.pending }}</span>
                <span v-else class="text-secondary">—</span>
              </td>
              <td>
                <span v-if="svc.processing > 0" class="badge badge-processing">
                  <i class="pi pi-spin pi-spinner" style="font-size:0.7rem" />
                  {{ svc.processing }}
                </span>
                <span v-else class="text-secondary">—</span>
              </td>
              <td>
                <button
                  v-if="svc.failed > 0"
                  type="button"
                  class="badge badge-failed badge-button"
                  :title="`Fehlerdetails für ${serviceLabels[svc.service] ?? svc.service} anzeigen`"
                  @click="openFailures(svc.service)"
                >{{ svc.failed }}</button>
                <span v-else class="text-secondary">—</span>
              </td>
              <td class="text-secondary">{{ svc.done }}</td>
            </tr>
            <tr v-if="queueStatus.services.length === 0">
              <td colspan="5" class="text-secondary" style="text-align:center">Keine Daten</td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- Status-Karten (Mobil) -->
      <div class="queue-cards mb-4">
        <div v-for="svc in queueStatus.services" :key="svc.service" class="queue-card">
          <div class="queue-card__header">{{ serviceLabels[svc.service] ?? svc.service }}</div>
          <div class="queue-card__stats">
            <div class="queue-card__stat">
              <span class="queue-card__label">Ausstehend</span>
              <span v-if="svc.pending > 0" class="badge badge-pending">{{ svc.pending }}</span>
              <span v-else class="text-secondary">—</span>
            </div>
            <div class="queue-card__stat">
              <span class="queue-card__label">Läuft</span>
              <span v-if="svc.processing > 0" class="badge badge-processing">
                <i class="pi pi-spin pi-spinner" style="font-size:0.7rem" />
                {{ svc.processing }}
              </span>
              <span v-else class="text-secondary">—</span>
            </div>
            <div class="queue-card__stat">
              <span class="queue-card__label">Fehler</span>
              <button
                v-if="svc.failed > 0"
                type="button"
                class="badge badge-failed badge-button"
                :title="`Fehlerdetails für ${serviceLabels[svc.service] ?? svc.service} anzeigen`"
                @click="openFailures(svc.service)"
              >{{ svc.failed }}</button>
              <span v-else class="text-secondary">—</span>
            </div>
            <div class="queue-card__stat">
              <span class="queue-card__label">Erledigt</span>
              <span class="text-secondary">{{ svc.done }}</span>
            </div>
          </div>
        </div>
        <div v-if="queueStatus.services.length === 0" class="text-secondary" style="text-align:center">
          Keine Daten
        </div>
      </div>

      <div v-if="isActive" class="status-progress">
        <span v-if="cancelledPending" class="text-secondary" style="font-size:0.85rem">
          <i class="pi pi-spin pi-spinner mr-1" />
          Wird abgebrochen… {{ totalProcessing }} laufende Jobs werden noch beendet.
        </span>
        <span v-else class="text-secondary" style="font-size:0.85rem">
          <i class="pi pi-spin pi-spinner mr-1" />
          {{ totalProcessing }} werden verarbeitet, {{ totalPending }} warten…
        </span>
        <ProgressBar class="status-progress__bar" mode="indeterminate" />
        <Button
          icon="pi pi-times"
          label="Scan abbrechen"
          severity="danger"
          size="small"
          outlined
          :loading="cancelLoading"
          :disabled="cancelLoading || cancelledPending"
          @click="handleCancel"
          style="align-self: flex-start; margin-top: 0.25rem"
        />
      </div>

      <div v-if="!isActive" class="button-row">
        <Button
          icon="pi pi-search-plus"
          label="Fehlende Scans starten"
          :loading="rescanLoading"
          :disabled="rescanLoading || retryLoading"
          @click="handleRescan(false)"
        />
        <Button
          icon="pi pi-refresh"
          label="Alles neu scannen"
          :loading="rescanLoading"
          :disabled="rescanLoading || retryLoading"
          @click="handleRescan(true)"
        />
        <Button
          v-if="totalFailed > 0"
          icon="pi pi-replay"
          :label="`${totalFailed} Fehler wiederholen`"
          severity="warn"
          :loading="retryLoading"
          :disabled="rescanLoading || retryLoading"
          @click="handleRetry"
        />
        <Button
          icon="pi pi-map-marker"
          label="POI für Altbilder nachholen"
          severity="secondary"
          outlined
          :loading="poiRedetectLoading"
          :disabled="rescanLoading || retryLoading || poiRedetectLoading || poiRedetectEmptyLoading"
          v-tooltip.bottom="'Nur poi_detection für Fotos mit GPS und fertigem Embedding, die noch nie korrekt verarbeitet wurden (Fix #558) – idempotent, ohne kompletten Rescan.'"
          @click="handlePoiRedetect"
        />
        <Button
          icon="pi pi-replay"
          label="POI für trefferlose Fotos erneut prüfen"
          severity="secondary"
          outlined
          :loading="poiRedetectEmptyLoading"
          :disabled="rescanLoading || retryLoading || poiRedetectLoading || poiRedetectEmptyLoading"
          v-tooltip.bottom="'Einmalige Aktion: poi_detection für ALLE Fotos mit GPS und fertigem Embedding, die keinen POI-Treffer haben. Fängt auch Race-Opfer ein, die der Button links überspringt – läuft aber auch über Fotos, die zu Recht keinen POI in der Nähe haben.'"
          @click="handlePoiRedetectEmpty"
        />
      </div>
      <p v-if="poiRedetectResult !== null" class="poi-redetect-result">
        {{ poiRedetectResult > 0
          ? `${poiRedetectResult} Foto(s) für die POI-Erkennung neu eingereiht.`
          : 'Keine passenden Altbilder gefunden – nichts neu einzureihen.' }}
      </p>
      <p v-if="poiRedetectEmptyResult !== null" class="poi-redetect-result">
        {{ poiRedetectEmptyResult > 0
          ? `${poiRedetectEmptyResult} trefferlose(s) Foto(s) für die POI-Erkennung erneut eingereiht.`
          : 'Keine trefferlosen Fotos mit fertigem Embedding gefunden.' }}
      </p>
    </div>

    <!-- Finance KI-Tag-Queue -->
    <div class="data-management-group">
      <h3>Finance KI-Tagging</h3>
      <p>
        Neue Buchungen werden automatisch mit KI-Tag-Vorschlägen versehen. Hier siehst du
        den aktuellen Bearbeitungsstand und kannst fehlgeschlagene Jobs erneut starten.
      </p>

      <Message v-if="financeTagQueueError" severity="error" class="mb-3" @close="financeTagQueueError = ''">
        {{ financeTagQueueError }}
      </Message>

      <div class="queue-table-wrapper">
        <table class="queue-table mb-4">
          <thead>
            <tr>
              <th>Dienst</th>
              <th>Ausstehend</th>
              <th>In Bearbeitung</th>
              <th>Fehlgeschlagen</th>
              <th>Fertig</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>KI-Tag-Vorschläge</td>
              <td>{{ financeTagQueueStatus.pending }}</td>
              <td>{{ financeTagQueueStatus.processing }}</td>
              <td>{{ financeTagQueueStatus.failed }}</td>
              <td>{{ financeTagQueueStatus.done }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div v-if="financeTagCancelledPending" class="mb-3 text-sm text-muted">
        Ausstehende Jobs wurden abgebrochen.
      </div>

      <div class="queue-actions">
        <Button
          label="Alle einreihen"
          icon="pi pi-refresh"
          severity="secondary"
          :loading="financeTagReenqueueLoading"
          :disabled="financeTagReenqueueLoading"
          @click="handleFinanceTagReenqueue"
        />
        <Button
          v-if="financeTagQueueStatus.failed > 0"
          label="Fehlgeschlagene wiederholen"
          icon="pi pi-replay"
          severity="warn"
          :loading="financeTagRetryLoading"
          :disabled="financeTagRetryLoading"
          @click="handleFinanceTagRetry"
        />
        <Button
          v-if="financeTagIsActive"
          label="Abbrechen"
          icon="pi pi-times"
          severity="danger"
          outlined
          :loading="financeTagCancelLoading"
          :disabled="financeTagCancelLoading"
          @click="handleFinanceTagCancel"
        />
      </div>
    </div>

    <!-- Dokument-Verarbeitung -->
    <div class="data-management-group">
      <h3>Dokument-Verarbeitung</h3>
      <p>
        Neue und neu klassifizierte Dokumente durchlaufen drei Schritte:
        OCR / Text-Extraktion, KI-Klassifikation und Embedding.
      </p>

      <Message v-if="docReclassifyError" severity="error" class="mb-3" @close="docReclassifyError = ''">
        {{ docReclassifyError }}
      </Message>

      <div v-if="docReclassifyResult !== null" class="mb-3">
        <Message severity="info" :closable="false">
          {{ docReclassifyResult }} Dokument(e) in die Warteschlange eingereiht.
        </Message>
      </div>

      <div v-if="docRelocateResult !== null" class="mb-3">
        <Message :severity="docRelocateResult.failed > 0 ? 'warn' : 'info'" :closable="false">
          {{ docRelocateResult.processed }} Dokument(e) geprüft,
          {{ docRelocateResult.moved }} Dateipfad(e) aktualisiert
          <template v-if="docRelocateResult.failed > 0">
            , {{ docRelocateResult.failed }} fehlgeschlagen
          </template>.
        </Message>
      </div>

      <div class="queue-table-wrapper">
        <table class="queue-table">
          <thead>
            <tr>
              <th>Service</th>
              <th>Ausstehend</th>
              <th>In Arbeit</th>
              <th>Fehler</th>
              <th>Fertig</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="svc in docQueueStatus.services" :key="svc.service">
              <td>{{ docQueueServiceLabels[svc.service] ?? svc.service }}</td>
              <td>{{ svc.pending }}</td>
              <td>{{ svc.processing }}</td>
              <td :class="{ 'text-danger': svc.failed > 0 }">{{ svc.failed }}</td>
              <td class="text-secondary">{{ svc.done }}</td>
            </tr>
            <tr v-if="docQueueStatus.services.length === 0">
              <td colspan="5" class="text-secondary" style="text-align:center">Keine Daten</td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- Status-Karten (Mobil) -->
      <div class="queue-cards mb-3">
        <div v-for="svc in docQueueStatus.services" :key="svc.service" class="queue-card">
          <div class="queue-card__header">{{ docQueueServiceLabels[svc.service] ?? svc.service }}</div>
          <div class="queue-card__stats">
            <div class="queue-card__stat">
              <span class="queue-card__label">Ausstehend</span>
              <span v-if="svc.pending > 0" class="badge badge-pending">{{ svc.pending }}</span>
              <span v-else class="text-secondary">—</span>
            </div>
            <div class="queue-card__stat">
              <span class="queue-card__label">In Arbeit</span>
              <span v-if="svc.processing > 0" class="badge badge-processing">
                <i class="pi pi-spin pi-spinner" style="font-size:0.7rem" />
                {{ svc.processing }}
              </span>
              <span v-else class="text-secondary">—</span>
            </div>
            <div class="queue-card__stat">
              <span class="queue-card__label">Fehler</span>
              <span v-if="svc.failed > 0" class="badge badge-failed">{{ svc.failed }}</span>
              <span v-else class="text-secondary">—</span>
            </div>
            <div class="queue-card__stat">
              <span class="queue-card__label">Fertig</span>
              <span class="text-secondary">{{ svc.done }}</span>
            </div>
          </div>
        </div>
        <div v-if="docQueueStatus.services.length === 0" class="text-secondary" style="text-align:center">
          Keine Daten
        </div>
      </div>

      <ProgressBar
        v-if="docIsActive"
        mode="indeterminate"
        class="mb-3"
        style="height: 4px"
      />

      <div class="queue-actions">
        <Button
          label="Nur KI-Klassifikation"
          icon="pi pi-sparkles"
          severity="secondary"
          :loading="docReclassifyLoading"
          :disabled="docReclassifyLoading || docIsActive"
          @click="handleDocReclassifyAll('classify_only')"
        />
        <Button
          label="OCR + Klassifikation"
          icon="pi pi-refresh"
          severity="secondary"
          :loading="docReclassifyLoading"
          :disabled="docReclassifyLoading || docIsActive"
          @click="handleDocReclassifyAll('full')"
        />
        <Button
          label="Fehlende fortsetzen"
          icon="pi pi-play"
          severity="secondary"
          :loading="docReclassifyLoading"
          :disabled="docReclassifyLoading || docIsActive"
          @click="handleDocReclassifyAll('resume')"
        />
        <Button
          label="Dateinamen aktualisieren"
          icon="pi pi-folder"
          severity="secondary"
          :loading="docRelocateLoading"
          :disabled="docRelocateLoading || docReclassifyLoading || docIsActive"
          @click="handleDocRelocateAll"
        />
        <Button
          v-if="docTotalFailed > 0"
          label="Fehlgeschlagene wiederholen"
          icon="pi pi-replay"
          severity="warn"
          :loading="docRetryLoading"
          :disabled="docRetryLoading"
          @click="handleDocRetry"
        />
        <Button
          v-if="docIsActive"
          label="Abbrechen"
          icon="pi pi-times"
          severity="danger"
          outlined
          :loading="docCancelLoading"
          :disabled="docCancelLoading"
          @click="handleDocCancel"
        />
      </div>
    </div>

    <!-- Korrespondenten-Overrides -->
    <div class="data-management-group">
      <CorrespondentOverridesPanel />
    </div>

    <!-- Foto-Gruppen -->
    <div class="data-management-group">
      <h3>Ähnliche Fotos gruppieren</h3>
      <p>
        Ähnliche Fotos werden anhand der Embeddings automatisch zu Gruppen zusammengefasst.
      </p>

      <Message v-if="groupingError" severity="error" class="data-management-group__item" @close="groupingError = ''">{{ groupingError }}</Message>

      <div v-if="groupingResult" class="data-management-group__item">
        <Message severity="info" :closable="false">
          {{ groupingResult.groups_created }} neue Gruppen erstellt
          ({{ groupingResult.total_photos_grouped }} Fotos gruppiert).
        </Message>
      </div>

      <Button class="data-management-group__item"
        icon="pi pi-images"
        outlined
        label="Gruppen neu berechnen"
        :loading="groupingLoading"
        :disabled="groupingLoading || isActive || rescanLoading || retryLoading"
        @click="handleFindGroups"
      />

      <!-- KI-Auto-Pick (Track I) -->
      <Message v-if="aiPickError" severity="error" class="data-management-group__item" @close="aiPickError = ''">{{ aiPickError }}</Message>
      <Message v-if="aiPickRecomputeResult" severity="info" :closable="false" class="data-management-group__item">
        {{ aiPickRecomputeResult.groups_scored }} Gruppen neu bewertet
        (übersprungen: {{ aiPickRecomputeResult.groups_skipped }}).
      </Message>
      <Button class="data-management-group__item"
        icon="pi pi-sparkles"
        outlined
        label="KI-Picks neu berechnen"
        :loading="aiPickLoading"
        :disabled="aiPickLoading || groupingLoading || isActive || rescanLoading || retryLoading"
        @click="handleRecomputeAiPicks"
      />

      <Message v-if="dimensionsResult" severity="info" :closable="false" class="data-management-group__item">
        Bildmaße aktualisiert: {{ dimensionsResult.updated }} / {{ dimensionsResult.scanned }}
        (fehlgeschlagen: {{ dimensionsResult.failed }}).
      </Message>
      <Button class="data-management-group__item"
        icon="pi pi-arrows-alt"
        outlined
        label="Bildmaße nachtragen"
        v-tooltip.top="'Liest Breite und Höhe aus den Original-Dateien nach, damit die Orientierungsregel und der KI-Crop-Vorschlag korrekt arbeiten können.'"
        :loading="dimensionsLoading"
        :disabled="dimensionsLoading || aiPickLoading || groupingLoading || isActive || rescanLoading || retryLoading"
        @click="handleBackfillDimensions"
      />

      <Button class="data-management-group__item"
        icon="pi pi-download"
        outlined
        label="Kalibrierungs-Export herunterladen"
        :loading="calibrationLoading"
        :disabled="calibrationLoading"
        @click="handleDownloadCalibration"
      />

      <!-- Stufe D: per-User Gewichts-Kalibrierung. Lernt aus den
           bereits reviewten Gruppen welche Signale dem User wichtig
           sind, persistiert das Ergebnis in ai_pick_user_weights und
           der nächste "KI-Picks neu berechnen"-Lauf nutzt automatisch
           die fittierten Gewichte. -->
      <Message v-if="calibrateWeightsResult" severity="info" :closable="false" class="data-management-group__item">
        <div><strong>Kalibrierung abgeschlossen.</strong></div>
        <div>
          Personen-Burst:
          {{ calibrateWeightsResult.metadata.pair_count_face }} Vergleichspaare,
          Trefferquote
          <strong>{{ pct(calibrateWeightsResult.metadata.top1_accuracy_face) }}</strong>
          (vorher {{ pct(calibrateWeightsResult.metadata.top1_accuracy_face_baseline) }})
        </div>
        <div>
          Nicht-Personen-Burst:
          {{ calibrateWeightsResult.metadata.pair_count_non_face }} Vergleichspaare,
          Trefferquote
          <strong>{{ pct(calibrateWeightsResult.metadata.top1_accuracy_non_face) }}</strong>
          (vorher {{ pct(calibrateWeightsResult.metadata.top1_accuracy_non_face_baseline) }})
        </div>
      </Message>
      <Button class="data-management-group__item"
        icon="pi pi-graduation-cap"
        outlined
        label="KI auf meine Vorlieben kalibrieren"
        v-tooltip.bottom="'Lernt aus den bereits reviewten Gruppen welche Signale dir wichtig sind. Danach einmal &quot;KI-Picks neu berechnen&quot; klicken.'"
        :loading="calibrateWeightsLoading"
        :disabled="calibrateWeightsLoading || aiPickLoading || groupingLoading || isActive || rescanLoading || retryLoading"
        @click="handleCalibrateWeights"
      />
    </div>

    <!-- GPS Re-Extraktion -->
    <div class="data-management-group">
      <h3>GPS-Koordinaten neu einlesen</h3>
      <p>
        Liest GPS-Daten aus Fotos neu ein, bei denen die Extraktion beim Upload fehlgeschlagen ist,
        und wiederholt das Reverse-Geocoding für Fotos ohne Ortsbezeichnung.
        Wenn GPS-Koordinaten neu gefunden werden, werden alle anderen Scans (Embeddings,
        Gesichtserkennung, Qualität) ebenfalls neu gestartet.
      </p>

      <Message v-if="gpsRescanError" severity="error" class="data-management-group__item" @close="gpsRescanError = ''">{{ gpsRescanError }}</Message>

      <div v-if="gpsRescanResult" class="data-management-group__item">
        <Message severity="info" :closable="false">
          {{ gpsRescanResult.gpsFound }} Fotos mit neuen GPS-Koordinaten ·
          {{ gpsRescanResult.geocoded }} Fotos geocodiert ·
          {{ gpsRescanResult.scansQueued }} Fotos neu in die Scan-Queue eingereiht
        </Message>
      </div>

      <div v-if="gpsRescanLoading" class="data-management-group__item">
        <span class="text-secondary">GPS wird verarbeitet… {{ gpsRescanCurrent }} / {{ gpsRescanTotal }}</span>
        <ProgressBar :value="gpsRescanProgress" :showValue="false" style="margin-top:0.5rem" />
      </div>

      <Button class="data-management-group__item"
        icon="pi pi-map-marker"
        outlined
        label="GPS neu einlesen"
        :disabled="gpsRescanLoading || isActive || rescanLoading || retryLoading"
        :loading="gpsRescanLoading"
        @click="handleGpsRescan"
      />
    </div>

    <!-- Auto-Crop -->
    <div class="data-management-group">
      <h3>Auto-Crop neu berechnen</h3>
      <p>
        Berechnet den Fokuspunkt für Thumbnail-Ausschnitte anhand erkannter Gesichter
        und Sehenswürdigkeiten. Hochkant-Bilder werden so verschoben, dass der wichtigste
        Bereich sichtbar ist.
      </p>

      <Message v-if="autoCropError" severity="error" class="data-management-group__item" @close="autoCropError = ''">{{ autoCropError }}</Message>

      <div v-if="autoCropResult" class="data-management-group__item">
        <Message severity="info" :closable="false">
          {{ autoCropResult.updated }} Fotos aktualisiert.
        </Message>
      </div>

      <Button class="data-management-group__item"
        icon="pi pi-arrows-alt"
        outlined
        label="Auto-Crop neu berechnen"
        :loading="autoCropLoading"
        :disabled="autoCropLoading || isActive || rescanLoading || retryLoading"
        @click="handleRecomputeAutoCrops"
      />
    </div>

    <!-- AI-Transformations-Vorschläge -->
    <div class="data-management-group">
      <h3>KI-Crop-Vorschläge neu berechnen</h3>
      <p>
        Erzeugt für jedes Foto Crop-Vorschläge in allen Seitenverhältnissen (1:1, 4:5,
        16:9, …) plus eine Belichtungs-Empfehlung. Diese Daten füllen den
        <em>„KI-Vorschlag“-Block</em> im Foto-Editor (Sliders-Icon). Die Vorschläge
        sind <strong>userübergreifend</strong> — einmal angestoßen profitieren alle
        Nutzer. Für neu hochgeladene Fotos passiert das automatisch beim Indexieren;
        diese Aktion ist nur nötig, um bestehende Fotos nachzuziehen oder nach einem
        Modell-Update.
      </p>
      <p>
        Standardmäßig werden nur Fotos berechnet, die <em>noch keine</em> Vorschlags-Zeile
        haben — Re-Runs nach einem abgebrochenen Lauf sind so günstig. Aktiviere
        „Auch bestehende neu berechnen“ nach einem Modell-Update.
      </p>

      <Message v-if="transformSuggestError" severity="error" class="data-management-group__item" @close="transformSuggestError = ''">
        {{ transformSuggestError }}
      </Message>

      <div v-if="transformSuggestResult" class="data-management-group__item">
        <Message severity="info" :closable="false">
          {{ transformSuggestResult.updated }} neu berechnet,
          {{ transformSuggestResult.skipped }} übersprungen<span v-if="transformSuggestResult.failed > 0">,
            {{ transformSuggestResult.failed }} fehlgeschlagen (fehlende Maße oder
            unlesbares Bild)</span> — gesamt {{ transformSuggestResult.total }} Fotos.
        </Message>
      </div>

      <div class="data-management-group__item force-toggle">
        <Checkbox
          v-model="transformSuggestForce"
          inputId="transform-suggest-force"
          binary
          :disabled="transformSuggestLoading"
        />
        <label for="transform-suggest-force">Auch bestehende neu berechnen</label>
      </div>

      <Button class="data-management-group__item"
        icon="pi pi-sparkles"
        outlined
        label="KI-Crop-Vorschläge neu berechnen"
        :loading="transformSuggestLoading"
        :disabled="transformSuggestLoading || isActive || rescanLoading || retryLoading"
        @click="handleRecomputeTransformSuggestions"
      />
    </div>

    <!-- Metadaten -->
    <div class="data-management-group">
      <h3>Metadaten aktualisieren</h3>
      <p>
        Aufnahmedatum und andere EXIF-Metadaten werden für Fotos ohne gespeichertes Datum neu eingelesen.
      </p>

      <Message v-if="metaError" severity="error" class="data-management-group__item" @close="metaError = ''">{{ metaError }}</Message>

      <div v-if="refreshingMetadata" class="data-management-group__item">
        <span class="text-secondary">Metadaten werden aktualisiert… {{ refreshCurrent }} / {{ refreshTotal }}</span>
        <ProgressBar :value="refreshProgress" :showValue="false" style="margin-top:0.5rem" />
      </div>

      <Button class="data-management-group__item"
        icon="pi pi-refresh"
        outlined
        label="Metadaten aktualisieren"
        :disabled="refreshingMetadata || isActive || rescanLoading || retryLoading"
        :loading="refreshingMetadata"
        @click="handleRefreshMetadata"
      />
    </div>

    <!-- OSM-Regionen (POI-Detection, Epic #383) -->
    <div v-if="canManageOsm" class="data-management-group">
      <h3>OSM-Regionen</h3>
      <p>
        Selbst gehosteter geo-Service mit einer PostGIS-Datenbank pro Geofabrik-Region.
        Wird für Reverse-Geocoding und die POI-Erkennung in Fotos verwendet. Status
        aktualisiert sich automatisch alle 5 Sekunden.
      </p>

      <Message
        v-if="osmError"
        severity="error"
        class="mb-3"
        @close="osmError = ''"
      >{{ osmError }}</Message>

      <!-- Region-Vorschlag aus GPS-Koordinaten -->
      <div class="osm-form">
        <label>
          <span>Breitengrad (lat)</span>
          <InputText v-model="suggestLat" placeholder="48.137" />
        </label>
        <label>
          <span>Längengrad (lon)</span>
          <InputText v-model="suggestLon" placeholder="11.575" />
        </label>
        <Button
          label="Region vorschlagen"
          icon="pi pi-search"
          :loading="suggestLoading"
          :disabled="!suggestLat.trim() || !suggestLon.trim()"
          @click="handleSuggestOsmRegion"
        />
        <Button
          label="Reverse-Geocode testen"
          icon="pi pi-globe"
          severity="secondary"
          :loading="reverseLoading"
          :disabled="!suggestLat.trim() || !suggestLon.trim()"
          @click="handleReverseGeocode"
        />
      </div>

      <div v-if="suggestResult" class="osm-suggest-result">
        <strong>Vorschlag:</strong> {{ suggestResult.slug }}
        ({{ suggestResult.name }})
        <span v-if="suggestResult.existing">— bereits angelegt, Status:
          {{ osmStatusLabels[suggestResult.existingStatus ?? ''] ?? suggestResult.existingStatus }}</span>
        <Button
          v-if="!suggestResult.existing"
          class="ml-2"
          label="Anlegen"
          icon="pi pi-plus"
          size="small"
          :loading="osmLoading"
          @click="handleAddSuggestedRegion"
        />
      </div>

      <div v-if="reverseResult" class="osm-reverse-result">
        <strong>Reverse-Geocode-Antwort</strong> (über
        Region <code>{{ reverseResult.regionSlug }}</code>):
        <pre>{{ JSON.stringify(reverseResult.result, null, 2) }}</pre>
      </div>

      <!-- Bulk-Suggest für Bestandsfotos -->
      <div class="osm-bulk">
        <Button
          label="Regionen aus Foto-Bibliothek vorschlagen"
          icon="pi pi-images"
          :loading="bulkLoading"
          severity="secondary"
          @click="handleBulkSuggest"
        />
        <div v-if="bulkSuggestResult" class="osm-bulk-result">
          <p>
            <strong>{{ bulkSuggestResult.geotaggedPhotoCount }}</strong> Fotos mit GPS
            ausgewertet,
            <span v-if="bulkSuggestResult.unmappedPhotoCount > 0">
              {{ bulkSuggestResult.unmappedPhotoCount }} nicht zuordenbar (z. B. auf See),
            </span>
            <span v-if="bulkSuggestResult.coveredPhotoCount > 0">
              {{ bulkSuggestResult.coveredPhotoCount.toLocaleString('de-DE') }}
              bereits durch importierte Regionen abgedeckt,
            </span>
            {{ bulkSuggestResult.suggestions.length }} Regionen vorgeschlagen.
          </p>
          <table class="osm-bulk-table">
            <thead>
              <tr>
                <th>Region</th>
                <th>Fotos</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="s in bulkSuggestResult.suggestions" :key="s.slug">
                <td>
                  <code>{{ s.slug }}</code>
                  <span class="osm-bulk-name">{{ s.name }}</span>
                </td>
                <td>{{ s.photoCount.toLocaleString('de-DE') }}</td>
                <td>
                  <span v-if="s.existing"
                    class="osm-status"
                    :class="`osm-status--${s.existingStatus}`"
                  >{{ osmStatusLabels[s.existingStatus ?? ''] ?? s.existingStatus }}</span>
                  <span v-else class="text-secondary">–</span>
                </td>
                <td>
                  <Button
                    v-if="!s.existing"
                    label="Anlegen"
                    icon="pi pi-plus"
                    size="small"
                    :loading="osmLoading"
                    @click="handleBulkCreate(s)"
                  />
                </td>
              </tr>
            </tbody>
          </table>

          <!-- Lösch-Kandidaten -->
          <div v-if="bulkSuggestResult.redundantRegions.length > 0" class="osm-redundant">
            <h4 class="osm-redundant__title">
              <i class="pi pi-exclamation-triangle" />
              Lösch-Kandidaten ({{ bulkSuggestResult.redundantRegions.length }})
            </h4>
            <p class="osm-redundant__desc">
              Diese importierten Regionen werden bereits vollständig durch andere getrackte
              Regionen abgedeckt — entweder durch kleinere Subregionen oder durch eine größere
              übergeordnete Region. Ob ein Entfernen Speicherplatz spart, hängt von den
              PBF-Größen ab; die Empfehlung berücksichtigt das.
            </p>
            <ul class="osm-redundant__list">
              <li v-for="rr in bulkSuggestResult.redundantRegions" :key="rr.slug">
                <div class="osm-redundant__head">
                  <code>{{ rr.slug }}</code>
                  <span class="osm-status osm-status--ready_running">
                    {{ osmStatusLabels[rr.status] ?? rr.status }}
                  </span>
                  <span
                    class="osm-redundant__verdict"
                    :class="`osm-redundant__verdict--${rr.recommendation}`"
                  >{{ redundantVerdictLabel(rr) }}</span>
                </div>
                <span class="osm-redundant__children">
                  <template v-if="rr.kind === 'covered_by_ancestor'">
                    bereits enthalten in: {{ rr.coveringRegions.join(', ') }}
                  </template>
                  <template v-else>
                    abgedeckt durch: {{ rr.coveringRegions.join(', ') }}
                  </template>
                </span>
                <span
                  v-if="rr.selfSizeMb !== null || rr.alternativeSizeMb !== null"
                  class="osm-redundant__sizes"
                >
                  <template v-if="rr.kind === 'covered_by_ancestor'">
                    diese Region: {{ rr.selfSizeMb !== null ? `${rr.selfSizeMb} MB` : '?' }}
                    · übergeordnet:
                    {{ rr.alternativeSizeMb !== null ? `${rr.alternativeSizeMb} MB` : '?' }}
                  </template>
                  <template v-else>
                    große Region: {{ rr.selfSizeMb !== null ? `${rr.selfSizeMb} MB` : '?' }}
                    · Subregionen zusammen:
                    {{ rr.alternativeSizeMb !== null ? `${rr.alternativeSizeMb} MB` : '?' }}
                  </template>
                </span>
              </li>
            </ul>
          </div>
        </div>
      </div>

      <!-- Region-Tabelle (Desktop) -->
      <div v-if="osmRegions.length === 0" class="osm-empty">
        Noch keine Regionen angelegt. Mit dem Formular oben einen Vorschlag
        holen und dann „Anlegen" klicken.
      </div>
      <div v-else class="queue-table-wrapper">
        <table class="queue-table mb-4">
          <thead>
            <tr>
              <th>Region</th>
              <th>Status</th>
              <th>PBF</th>
              <th>Importiert am</th>
              <th>Zuletzt benutzt</th>
              <th>Letzter Fehler</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in osmRegions" :key="r.slug" :class="{ 'osm-row--redundant': redundantSlugSet.has(r.slug) }">
              <td>
                <code>{{ r.slug }}</code>
                <span v-if="redundantSlugSet.has(r.slug)" class="osm-redundant-badge" title="Wird vollständig durch Subregionen abgedeckt — Lösch-Kandidat">
                  <i class="pi pi-exclamation-triangle" /> redundant
                </span>
              </td>
              <td>
                <span
                  class="osm-status"
                  :class="`osm-status--${r.status}`"
                  :title="osmStatusSeverity[r.status] ?? ''"
                >{{ osmStatusLabels[r.status] ?? r.status }}</span>
              </td>
              <td>{{ r.pbfSizeMb !== null ? `${r.pbfSizeMb} MB` : '–' }}</td>
              <td>{{ formatRelative(r.importedAt) }}</td>
              <td>{{ formatRelative(r.lastUsedAt) }}</td>
              <td class="osm-error-cell">{{ r.lastError ?? '' }}</td>
              <td class="osm-actions">
                <Button
                  v-if="r.status === 'pending_approval'"
                  icon="pi pi-check"
                  label="Freigeben"
                  size="small"
                  :loading="osmLoading"
                  @click="handleApproveOsmRegion(r.slug)"
                />
                <Button
                  v-if="r.status === 'ready_running'"
                  icon="pi pi-refresh"
                  label="Aktualisieren"
                  size="small"
                  text
                  :loading="osmLoading"
                  @click="handleRefreshOsmRegion(r.slug)"
                />
                <Button
                  icon="pi pi-trash"
                  label="Entfernen"
                  size="small"
                  severity="danger"
                  text
                  :loading="osmLoading"
                  @click="handleDeleteOsmRegion(r.slug)"
                />
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- Region-Karten (Mobil) — visible only when osmRegions.length > 0;
           the desktop empty-state above also applies on mobile. -->
      <div v-if="osmRegions.length > 0" class="queue-cards mb-4">
        <div v-for="r in osmRegions" :key="r.slug" class="queue-card osm-card" :class="{ 'osm-card--redundant': redundantSlugSet.has(r.slug) }">
          <div class="queue-card__header">
            <code>{{ r.slug }}</code>
            <span v-if="redundantSlugSet.has(r.slug)" class="osm-redundant-badge" title="Wird vollständig durch Subregionen abgedeckt — Lösch-Kandidat">
              <i class="pi pi-exclamation-triangle" /> redundant
            </span>
          </div>
          <div class="osm-card__row">
            <span
              class="osm-status"
              :class="`osm-status--${r.status}`"
            >{{ osmStatusLabels[r.status] ?? r.status }}</span>
            <span class="osm-card__pbf">
              {{ r.pbfSizeMb !== null ? `${r.pbfSizeMb} MB` : '' }}
            </span>
          </div>
          <div v-if="r.lastError" class="osm-card__error">{{ r.lastError }}</div>
          <div class="osm-card__meta">
            <span v-if="r.importedAt">Importiert: {{ formatRelative(r.importedAt) }}</span>
            <span v-if="r.lastUsedAt">Zuletzt: {{ formatRelative(r.lastUsedAt) }}</span>
          </div>
          <div class="osm-card__actions">
            <Button
              v-if="r.status === 'pending_approval'"
              icon="pi pi-check"
              label="Freigeben"
              size="small"
              :loading="osmLoading"
              @click="handleApproveOsmRegion(r.slug)"
            />
            <Button
              v-if="r.status === 'ready_running'"
              icon="pi pi-refresh"
              label="Aktualisieren"
              size="small"
              text
              :loading="osmLoading"
              @click="handleRefreshOsmRegion(r.slug)"
            />
            <Button
              icon="pi pi-trash"
              label="Entfernen"
              size="small"
              severity="danger"
              text
              :loading="osmLoading"
              @click="handleDeleteOsmRegion(r.slug)"
            />
          </div>
        </div>
      </div>
    </div>

    <!-- Danger Zone: Purge Photos -->
    <div v-if="canPurgePhotos" class="data-management-group danger-zone">
      <h3 class="danger-zone__title">Danger Zone</h3>
      <p>
        Entfernt unwiderruflich alle Fotos, Alben, Gesichter, Personen,
        Embeddings und Scan-Queue-Einträge aus der Datenbank. Benutzerkonten,
        Rollen und Berechtigungen bleiben erhalten.
      </p>
      <Button class="data-management-group__item"
        icon="pi pi-trash"
        label="Alle Fotodaten löschen…"
        severity="danger"
        @click="openPurgeDialog"
      />
    </div>

    <!-- Build-Info -->
    <div class="data-management-group">
      <h3>Version</h3>
      <span class="build-number">Build {{ buildNumber }}</span>
    </div>

    <!-- Purge Confirmation Dialog -->
    <Dialog
      v-model:visible="purgeDialogVisible"
      modal
      :closable="!purgeLoading"
      :closeOnEscape="!purgeLoading"
      header="Alle Fotodaten löschen"
      :style="{ width: 'min(520px, 92vw)' }"
    >
      <div v-if="!purgeResult" class="purge-dialog">
        <Message severity="error" :closable="false" class="purge-dialog__warn">
          Diese Aktion ist <strong>nicht umkehrbar</strong>.
          Es werden <strong>alle</strong> Fotos, Alben, Gesichter, Personen,
          Embeddings und Scan-Queue-Einträge entfernt.
        </Message>

        <div class="purge-dialog__options">
          <label class="purge-dialog__option">
            <RadioButton v-model="purgeMode" inputId="purge-mode-db" name="purgeMode" value="db" />
            <span>
              <strong>Nur Datenbank</strong>
              <span class="purge-dialog__hint">
                Löscht alle Datenbank-Einträge. Die Original­dateien und Thumbnails bleiben auf der Festplatte erhalten (verwaist).
              </span>
            </span>
          </label>
          <label class="purge-dialog__option">
            <RadioButton v-model="purgeMode" inputId="purge-mode-all" name="purgeMode" value="all" />
            <span>
              <strong>Datenbank + Dateien</strong>
              <span class="purge-dialog__hint">
                Löscht zusätzlich alle hochgeladenen Fotos und alle zwischengespeicherten Thumbnails von der Festplatte.
              </span>
            </span>
          </label>
        </div>

        <div class="purge-dialog__confirm">
          <label for="purge-confirm-input">
            Bitte zur Bestätigung <strong>{{ PURGE_CONFIRM_KEYWORD }}</strong> eintippen:
          </label>
          <InputText
            id="purge-confirm-input"
            v-model="purgeConfirmText"
            :disabled="purgeLoading"
            autocomplete="off"
          />
        </div>

        <Message v-if="purgeError" severity="error" @close="purgeError = ''">{{ purgeError }}</Message>
      </div>

      <div v-else class="purge-result">
        <Message severity="success" :closable="false">
          Fotodaten wurden gelöscht. Entfernte Datenbank-Einträge: <strong>{{ purgeDbTotals }}</strong>.
        </Message>
        <table class="purge-result__table">
          <thead>
            <tr><th>Tabelle</th><th>Gelöschte Zeilen</th></tr>
          </thead>
          <tbody>
            <tr v-for="(count, table) in purgeResult.dbCounts" :key="table">
              <td>{{ table }}</td>
              <td>{{ count }}</td>
            </tr>
          </tbody>
        </table>
        <div v-if="purgeResult.files.deleted" class="purge-result__files">
          <strong>Dateien:</strong>
          {{ purgeResult.files.uploadsRemoved }} Uploads,
          {{ purgeResult.files.thumbnailsRemoved }} Thumbnail-Shards entfernt
          <span v-if="purgeResult.files.failures > 0">
            — {{ purgeResult.files.failures }} Fehler
          </span>
        </div>
        <div v-else class="purge-result__files">
          <strong>Dateien:</strong> wurden behalten (nur DB-Einträge entfernt).
        </div>
        <div class="purge-result__embeddings">
          <strong>Embedding-Service:</strong>
          <template v-if="purgeResult.embeddingService.ok">
            {{ purgeResult.embeddingService.deleted }} Embeddings gelöscht.
          </template>
          <template v-else>
            <span class="purge-result__warn">
              Fehler: {{ purgeResult.embeddingService.error || 'Service nicht erreichbar' }}
            </span>
          </template>
        </div>
      </div>

      <template #footer>
        <template v-if="!purgeResult">
          <Button
            label="Abbrechen"
            severity="secondary"
            outlined
            :disabled="purgeLoading"
            @click="purgeDialogVisible = false"
          />
          <Button
            :label="purgeMode === 'all' ? 'Alles endgültig löschen' : 'Datenbank leeren'"
            icon="pi pi-trash"
            severity="danger"
            :loading="purgeLoading"
            :disabled="!canConfirmPurge"
            @click="handlePurge"
          />
        </template>
        <template v-else>
          <Button label="Schließen" @click="purgeDialogVisible = false" />
        </template>
      </template>
    </Dialog>

    <!-- Failed-jobs detail dialog (opened from a "Fehler" count) -->
    <QueueErrorsDialog
      v-model:visible="failuresDialogVisible"
      :title="failuresTitle"
      :loader="failuresLoader"
    />
  </div>
</template>

<style scoped>
.data-management-view {
  gap: 1rem;
  display: flex;
  flex-direction: column;
  padding-inline: 0.25em;
}

.poi-redetect-result {
  margin: 0.5rem 0 0;
  font-size: 0.875rem;
  color: var(--p-text-muted-color);
}

@media (min-width: 800px) {
  .data-management-view {
    margin-inline: 0.5em;
  }
}

.data-management-view .title {
  font-size: 1.5em;
  font-weight: 600;
  margin-block: 0.25em;
}

.data-management-group {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 0.5em;
}

.build-number {
  font-size: 0.85rem;
  color: var(--p-text-muted-color, #888);
  font-family: monospace;
}

.data-management-group h3, .data-management-group p {
  margin-block: 0;
}

.data-management-group .data-management-group__item {
}

/*
 * Force every button inside a data-management-group to size to its
 * label rather than inherit a stretch from PrimeVue's internal flex
 * defaults. A previous long label ("…(für Orientierungsregel)") had
 * pulled its button to full width on certain viewports.
 */
.data-management-group :deep(.p-button) {
  align-self: flex-start;
  width: auto;
}

.data-management-group .force-toggle {
  display: flex;
  gap: 0.5rem;
  align-items: center;
  font-size: 0.95em;
}

.status-progress {
  display: flex;
  flex-direction: column;
  margin-block: 0.25em;
  align-self: stretch;
}

.status-progress .text-secondary {
  display: flex;
  align-items: center;
  gap: 0.5em;
}

.status-progress .status-progress__bar {
  display: flex;
  margin-block: 0.5em;
  height: 4px;
}

.button-row {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
  align-self: flex-start;
}

@media (max-width: 600px) {
  .button-row {
    flex-direction: column;
    align-self: stretch;
  }
}

@media (max-width: 600px) {
  .button-row + .button-row,
  .data-management-group :deep(.p-button:only-child) {
    width: 100%;
  }
}

/* Desktop: show table, hide cards */
.queue-table-wrapper { display: block; align-self: stretch; }
.queue-cards { display: none; }

@media (max-width: 600px) {
  .queue-table-wrapper { display: none; }
  .queue-cards { display: flex; flex-direction: column; gap: 0.5rem; align-self: stretch; }
}

.queue-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.9rem;
}
.queue-table th,
.queue-table td {
  padding: 0.4rem 0.75rem;
  text-align: left;
  border-bottom: 1px solid var(--p-content-border-color);
}
.queue-table th {
  color: var(--p-text-muted-color);
  font-weight: 600;
  font-size: 0.8rem;
  text-transform: uppercase;
}

/* Mobile card layout */
.queue-card {
  border: 1px solid var(--p-content-border-color);
  border-radius: 0.5rem;
  padding: 0.6rem 0.75rem;
}
.queue-card__header {
  font-weight: 600;
  font-size: 0.9rem;
  margin-bottom: 0.4rem;
}
.queue-card__stats {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.3rem 1rem;
}
.queue-card__stat {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 0.85rem;
}
.queue-card__label {
  color: var(--p-text-muted-color);
  font-size: 0.8rem;
}

.badge {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  padding: 0.15rem 0.5rem;
  border-radius: 1rem;
  font-size: 0.8rem;
  font-weight: 600;
}
.badge-pending  { background: var(--blue-100);   color: var(--blue-700); }
.badge-processing { background: var(--yellow-100); color: var(--yellow-700); }
.badge-failed   { background: var(--red-100);    color: var(--red-700); }

/* A badge rendered as a <button> — clickable "Fehler" count that
   opens the failed-jobs detail dialog. */
.badge-button {
  border: none;
  cursor: pointer;
  font-family: inherit;
  transition: filter 0.12s ease;
}
.badge-button:hover {
  filter: brightness(0.92);
}
.badge-button:focus-visible {
  outline: 2px solid var(--p-primary-color);
  outline-offset: 1px;
}

/* Danger Zone */
.osm-form {
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
  align-items: flex-end;
  margin-bottom: 1rem;
}

.osm-form label {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  font-size: 0.9rem;
}

.osm-form label span {
  color: var(--p-text-muted-color);
}

.osm-suggest-result {
  padding: 0.75rem;
  margin-bottom: 1rem;
  background: var(--p-content-hover-background);
  border-radius: 6px;
}

.osm-reverse-result {
  padding: 0.75rem;
  margin-bottom: 1rem;
  background: var(--p-content-hover-background);
  border-radius: 6px;
}

.osm-reverse-result pre {
  margin-top: 0.5rem;
  max-height: 200px;
  overflow: auto;
  font-size: 0.85rem;
}

.osm-bulk {
  margin: 1rem 0;
}
.osm-bulk-result {
  margin-top: 0.75rem;
  padding: 0.75rem;
  background: var(--p-content-hover-background);
  border-radius: 6px;
}
.osm-bulk-table {
  width: 100%;
  border-collapse: collapse;
  margin-top: 0.5rem;
  font-size: 0.9rem;
}
.osm-bulk-table th,
.osm-bulk-table td {
  text-align: left;
  padding: 0.4rem 0.75rem;
  border-bottom: 1px solid var(--p-content-border-color);
  vertical-align: middle;
}
.osm-bulk-name {
  display: block;
  font-size: 0.8rem;
  color: var(--p-text-muted-color);
}

.osm-redundant {
  margin-top: 1rem;
  padding: 0.75rem;
  border-radius: 6px;
  border: 1px solid var(--p-tag-warn-background, rgba(255,160,0,0.3));
  background: color-mix(in srgb, var(--p-tag-warn-background, rgba(255,160,0,0.15)) 40%, transparent);
}
.osm-redundant__title {
  margin: 0 0 0.4rem;
  font-size: 0.95rem;
  font-weight: 600;
  color: var(--p-tag-warn-color);
  display: flex;
  align-items: center;
  gap: 0.4rem;
}
.osm-redundant__desc {
  margin: 0 0 0.6rem;
  font-size: 0.85rem;
  color: var(--p-text-muted-color);
}
.osm-redundant__list {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}
.osm-redundant__list li {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  font-size: 0.9rem;
}
.osm-redundant__head {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.4rem;
}
.osm-redundant__verdict {
  font-size: 0.78rem;
  font-weight: 600;
  padding: 0.05rem 0.45rem;
  border-radius: 4px;
}
.osm-redundant__verdict--delete {
  background: var(--p-tag-success-background, rgba(0,128,0,0.12));
  color: var(--p-tag-success-color);
}
.osm-redundant__verdict--keep {
  background: var(--p-tag-warn-background, rgba(255,160,0,0.18));
  color: var(--p-tag-warn-color);
}
.osm-redundant__verdict--unknown {
  background: var(--p-content-hover-background);
  color: var(--p-text-muted-color);
}
.osm-redundant__sizes {
  font-size: 0.78rem;
  color: var(--p-text-muted-color);
}
.osm-redundant__children {
  font-size: 0.8rem;
  color: var(--p-text-muted-color);
}

.osm-redundant-badge {
  display: inline-flex;
  align-items: center;
  gap: 0.2rem;
  margin-left: 0.5rem;
  padding: 0.1rem 0.45rem;
  border-radius: 4px;
  font-size: 0.75rem;
  font-weight: 600;
  background: var(--p-tag-warn-background, rgba(255,160,0,0.2));
  color: var(--p-tag-warn-color);
  vertical-align: middle;
  cursor: help;
}

.osm-row--redundant td:first-child {
  opacity: 0.8;
}
.osm-card--redundant {
  border-color: var(--p-tag-warn-background, rgba(255,160,0,0.4));
}

.osm-empty {
  padding: 0.75rem;
  color: var(--p-text-muted-color);
  font-style: italic;
}

.osm-error-cell {
  max-width: 24ch;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--p-text-muted-color);
  font-size: 0.85rem;
}

.osm-actions {
  display: flex;
  gap: 0.4rem;
}

.osm-status {
  display: inline-block;
  padding: 0.1rem 0.5rem;
  border-radius: 4px;
  font-size: 0.85rem;
  background: var(--p-content-hover-background);
}

.osm-status--ready_running { background: var(--p-tag-success-background, rgba(0,128,0,0.12)); color: var(--p-tag-success-color); }
.osm-status--importing     { background: var(--p-tag-info-background, rgba(0,120,200,0.12)); color: var(--p-tag-info-color); }
.osm-status--pending_approval { background: var(--p-tag-warn-background, rgba(255,160,0,0.15)); color: var(--p-tag-warn-color); }
.osm-status--failed,
.osm-status--blocked_disk  { background: var(--p-tag-danger-background, rgba(220,60,60,0.15)); color: var(--p-tag-danger-color); }

.osm-card__row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin: 0.35rem 0;
}
.osm-card__pbf {
  color: var(--p-text-muted-color);
  font-size: 0.85rem;
}
.osm-card__error {
  margin: 0.35rem 0;
  font-size: 0.8rem;
  color: var(--p-text-muted-color);
  word-break: break-word;
}
.osm-card__meta {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
  font-size: 0.8rem;
  color: var(--p-text-muted-color);
  margin: 0.35rem 0;
}
.osm-card__actions {
  display: flex;
  gap: 0.5rem;
  margin-top: 0.5rem;
}

.danger-zone {
  margin-top: 1rem;
  border: 1px solid var(--p-red-400, #e34c4c);
  border-radius: 0.5rem;
  padding: 0.75rem 1rem;
  background: color-mix(in srgb, var(--p-red-50, #fff5f5) 60%, transparent);
}
.danger-zone__title {
  color: var(--p-red-600, #c62828);
}

/* Purge dialog */
.purge-dialog {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}
.purge-dialog__warn {
  margin: 0;
}
.purge-dialog__options {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}
.purge-dialog__option {
  display: flex;
  align-items: flex-start;
  gap: 0.6rem;
  cursor: pointer;
}
.purge-dialog__option span {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
}
.purge-dialog__hint {
  font-size: 0.85rem;
  color: var(--p-text-muted-color);
}
.purge-dialog__confirm {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}
.purge-dialog__confirm label {
  font-size: 0.9rem;
}

/* Purge result */
.purge-result {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}
.purge-result__table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.85rem;
}
.purge-result__table th,
.purge-result__table td {
  padding: 0.25rem 0.5rem;
  border-bottom: 1px solid var(--p-content-border-color);
  text-align: left;
}
.purge-result__table th {
  color: var(--p-text-muted-color);
  font-weight: 600;
  font-size: 0.75rem;
  text-transform: uppercase;
}
.purge-result__files,
.purge-result__embeddings {
  font-size: 0.9rem;
}
.purge-result__warn {
  color: var(--p-red-600, #c62828);
}
</style>
