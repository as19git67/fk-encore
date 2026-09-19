<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import Button from 'primevue/button'
import InputText from 'primevue/inputtext'
import Message from 'primevue/message'
import OsmRegionStorageDialog from './OsmRegionStorageDialog.vue'
import {
  listOsmRegions, suggestOsmRegion, createOsmRegion,
  approveOsmRegion, deleteOsmRegion, reverseGeocodeViaOsm,
  bulkSuggestOsmRegions, refreshOsmRegion, getOsmRegionStorage,
  getOutdatedOsmRegions, reimportOutdatedOsmRegions,
  type OutdatedRegionsResult, type ReimportOutdatedResult,
  type OsmRegionImport, type RegionSuggestion,
  type BulkSuggestResult, type BulkRegionSuggestion, type RedundantRegion,
  type RegionStorage,
} from '../../api/osmAdmin'
import { usePolling } from '../../composables/usePolling'

const osmRegions = ref<OsmRegionImport[]>([])
const osmError = ref('')
const osmLoading = ref(false)

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

// Regions an older osm2pgsql style built. osm2pgsql applies a style on
// --create only, so such a region cannot gain a table any other way
// than by being imported again (docs/ios-urlaubsplanung.md §4.7).
const outdated = ref<OutdatedRegionsResult | null>(null)
const outdatedLoading = ref(false)
const reimportResult = ref<ReimportOutdatedResult | null>(null)
const reimportLoading = ref(false)

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

const storageDialogVisible = ref(false)
const storageLoading = ref(false)
const storageError = ref('')
const storageResult = ref<RegionStorage | null>(null)

async function handleShowStorage(slug: string) {
  storageDialogVisible.value = true
  storageLoading.value = true
  storageError.value = ''
  storageResult.value = null
  try {
    storageResult.value = await getOsmRegionStorage(slug)
  } catch (err) {
    storageError.value = (err as Error).message ?? String(err)
  } finally {
    storageLoading.value = false
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

async function handleCheckOutdated() {
  outdatedLoading.value = true
  reimportResult.value = null
  try {
    outdated.value = await getOutdatedOsmRegions()
    osmError.value = ''
  } catch (err) {
    osmError.value = (err as Error).message ?? String(err)
  } finally {
    outdatedLoading.value = false
  }
}

async function handleReimportOutdated() {
  const list = outdated.value?.outdated ?? []
  if (list.length === 0) return
  // Named one by one rather than counted: this drops databases, and
  // "vier Regionen" is not something anybody can check before saying
  // yes to it.
  const names = list.map((r) => `· ${r.slug} (fehlt: ${r.missing.join(', ')})`).join('\n')
  if (!window.confirm(
    `${list.length} Region(en) neu importieren?\n\n${names}\n\n`
    + 'Die PostGIS-Datenbank wird jeweils gelöscht und der Import neu gestartet. '
    + 'Das dauert pro Region 10–30 Minuten, und solange ist sie nicht verfügbar. '
    + 'Die PBF-Datei bleibt im Cache — es wird nichts neu heruntergeladen, der '
    + 'Import hat damit aber auch denselben Datenstand wie zuvor.',
  )) return

  reimportLoading.value = true
  try {
    reimportResult.value = await reimportOutdatedOsmRegions()
    await Promise.all([fetchOsmRegions(), handleCheckOutdated()])
    osmError.value = ''
  } catch (err) {
    osmError.value = (err as Error).message ?? String(err)
  } finally {
    reimportLoading.value = false
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

onMounted(fetchOsmRegions)
// Poll the OSM region list every 5s so importing/ready transitions surface
// without a manual reload. Cheap query (single SELECT), and it now stops as
// soon as this page is left.
usePolling(fetchOsmRegions, 5_000)
</script>

<template>
  <div class="data-management-group">
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

    <!-- Regionen, die ein älterer osm2pgsql-Style gebaut hat -->
    <div class="osm-outdated">
      <Button
        label="Ältere Importe suchen"
        icon="pi pi-history"
        severity="secondary"
        :loading="outdatedLoading"
        @click="handleCheckOutdated"
      />

      <template v-if="outdated">
        <p v-if="outdated.outdated.length === 0" class="osm-outdated__none">
          Alle {{ outdated.checked }} fertigen Region(en) sind auf dem Stand des
          aktuellen Imports.
        </p>
        <template v-else>
          <p>
            <strong>{{ outdated.outdated.length }}</strong> von
            {{ outdated.checked }} fertigen Region(en) wurden mit einem älteren
            Style importiert. Nur ein Neuimport bringt die fehlenden Tabellen —
            osm2pgsql legt sie ausschließlich beim Neuanlegen an, und die
            Replikation hängt nur Änderungen an das an, was schon da ist.
          </p>
          <ul class="osm-outdated__list">
            <li v-for="r in outdated.outdated" :key="r.slug">
              <code>{{ r.slug }}</code> — fehlt:
              <code>{{ r.missing.join(', ') }}</code>
            </li>
          </ul>
          <Button
            label="Diese Regionen neu importieren"
            icon="pi pi-refresh"
            severity="danger"
            :loading="reimportLoading"
            @click="handleReimportOutdated"
          />
        </template>

        <p v-if="outdated.unknown.length > 0" class="osm-outdated__unknown">
          Nicht prüfbar:
          <span v-for="u in outdated.unknown" :key="u.slug">
            <code>{{ u.slug }}</code> ({{ u.reason }})
          </span>
        </p>
      </template>

      <div v-if="reimportResult" class="osm-outdated__result">
        <p>
          <strong>{{ reimportResult.started.filter((r) => r.started).length }}</strong>
          Region(en) werden neu importiert, {{ reimportResult.skipped }} waren
          bereits aktuell.
        </p>
        <ul>
          <li v-for="r in reimportResult.started.filter((x) => !x.started)" :key="r.slug">
            <code>{{ r.slug }}</code> — nicht gestartet: {{ r.reason }}
          </li>
        </ul>
      </div>
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
                v-if="r.status === 'ready_running' || r.status === 'ready_stopped'"
                icon="pi pi-database"
                label="DB-Größe"
                size="small"
                text
                @click="handleShowStorage(r.slug)"
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
            v-if="r.status === 'ready_running' || r.status === 'ready_stopped'"
            icon="pi pi-database"
            label="DB-Größe"
            size="small"
            text
            @click="handleShowStorage(r.slug)"
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

    <OsmRegionStorageDialog
      v-model:visible="storageDialogVisible"
      :loading="storageLoading"
      :error="storageError"
      :result="storageResult"
    />
  </div>
</template>

<style scoped src="./adminPanels.css"></style>
<style scoped>
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
.osm-outdated {
  display: flex;
  flex-direction: column;
  gap: var(--space-2, 0.5rem);
  margin-top: var(--space-4, 1rem);
}

.osm-outdated__none {
  color: var(--p-text-muted-color);
}

.osm-outdated__list {
  margin: 0;
  padding-left: 1.25rem;
}

.osm-outdated__unknown {
  color: var(--p-text-muted-color);
  font-size: 0.9em;
}

.osm-outdated__result {
  border-top: 1px solid var(--p-content-border-color);
  padding-top: var(--space-2, 0.5rem);
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
</style>
