<script setup lang="ts">
/**
 * Label › Scanner-Etiketten: A4 sheets of small numbered stickers
 * ("#0001", "#0002", …) for paper documents before they are scanned.
 *
 * Not printed on the label printer but on an ordinary one, so the page only
 * makes the PDF: the server hands out the next numbers, keeps the list of
 * sheets and renders a sheet again on every download (label/scanner.ts).
 * The offset moves the whole grid for a printer that prints off-centre; the
 * test page shows the outlines of the labels on plain paper to find it.
 */
import { computed, onMounted, ref } from 'vue'
import Button from 'primevue/button'
import InputNumber from 'primevue/inputnumber'
import Message from 'primevue/message'
import { useConfirm } from 'primevue/useconfirm'
import PageLayout from '../components/layout/PageLayout.vue'
import ErrorBanner from '../components/layout/ErrorBanner.vue'
import EmptyState from '../components/layout/EmptyState.vue'
import PageSkeleton from '../components/layout/PageSkeleton.vue'
import ScrollX from '../components/layout/ScrollX.vue'
import { useAuthStore } from '../stores/auth'
import { downloadResult } from '../api/assistant'
import {
  createScannerSheet,
  deleteScannerSheet,
  getScannerOverview,
  saveScannerSettings,
  scannerSheetPdfPath,
  SCANNER_TEST_PDF_PATH,
  type ScannerOverview,
  type ScannerSheet,
} from '../api/label'

const auth = useAuthStore()
const confirm = useConfirm()
const canPrint = computed(() => auth.hasPermission('label.print'))

const overview = ref<ScannerOverview | null>(null)
const loaded = ref(false)
const error = ref<string | null>(null)
const info = ref<string | null>(null)

const pages = ref(1)
const nextNumber = ref(1)
const offsetX = ref(0)
const offsetY = ref(0)
const creating = ref(false)
const savingNumber = ref(false)
const savingOffset = ref(false)
const downloading = ref<number | 'test' | null>(null)

const labelsPerPage = computed(() => overview.value?.sheet.labelsPerPage ?? 189)
const maxPages = computed(() => overview.value?.sheet.maxPages ?? 10)
const numberChanged = computed(() => overview.value !== null && nextNumber.value !== overview.value.nextNumber)
const offsetChanged = computed(
  () =>
    overview.value !== null &&
    (offsetX.value !== overview.value.offsetXMm || offsetY.value !== overview.value.offsetYMm),
)

function labelText(n: number): string {
  return `#${String(n).padStart(4, '0')}`
}

/** What the next sheet will carry, from the saved number (not an unsaved edit). */
const nextRange = computed(() => {
  const first = overview.value?.nextNumber ?? 1
  return `${labelText(first)} – ${labelText(first + pages.value * labelsPerPage.value - 1)}`
})

function message(e: unknown, fallback: string): string {
  return e instanceof Error && e.message ? e.message : fallback
}

function when(iso: string): string {
  return new Date(iso).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' })
}

function apply(o: ScannerOverview) {
  overview.value = o
  nextNumber.value = o.nextNumber
  offsetX.value = o.offsetXMm
  offsetY.value = o.offsetYMm
}

async function load() {
  try {
    apply(await getScannerOverview())
  } catch (e) {
    error.value = message(e, 'Die Scanner-Etiketten konnten nicht geladen werden')
  } finally {
    loaded.value = true
  }
}

onMounted(load)

async function download(sheet: ScannerSheet) {
  downloading.value = sheet.id
  try {
    await downloadResult(scannerSheetPdfPath(sheet.id), 'Scanner-Etiketten.pdf')
  } catch (e) {
    error.value = message(e, 'Das PDF konnte nicht geladen werden')
  } finally {
    downloading.value = null
  }
}

async function downloadTestPage() {
  downloading.value = 'test'
  try {
    await downloadResult(SCANNER_TEST_PDF_PATH, 'Scanner-Etiketten Probeseite.pdf')
  } catch (e) {
    error.value = message(e, 'Die Probeseite konnte nicht geladen werden')
  } finally {
    downloading.value = null
  }
}

async function create() {
  creating.value = true
  error.value = null
  info.value = null
  try {
    const { sheet } = await createScannerSheet(pages.value)
    info.value = `Etiketten ${sheet.range} erzeugt.`
    apply(await getScannerOverview())
    await download(sheet)
  } catch (e) {
    error.value = message(e, 'Die Etiketten konnten nicht erzeugt werden')
  } finally {
    creating.value = false
  }
}

async function saveNumber() {
  savingNumber.value = true
  error.value = null
  try {
    const saved = await saveScannerSettings({ nextNumber: nextNumber.value })
    if (overview.value) overview.value = { ...overview.value, ...saved }
    info.value = `Das nächste Blatt beginnt mit ${labelText(saved.nextNumber)}.`
  } catch (e) {
    error.value = message(e, 'Die Nummer konnte nicht gespeichert werden')
  } finally {
    savingNumber.value = false
  }
}

async function saveOffset() {
  savingOffset.value = true
  error.value = null
  try {
    const saved = await saveScannerSettings({ offsetXMm: offsetX.value, offsetYMm: offsetY.value })
    if (overview.value) overview.value = { ...overview.value, ...saved }
    info.value = 'Druckversatz gespeichert. Er gilt für jeden Download, auch für ältere Blätter.'
  } catch (e) {
    error.value = message(e, 'Der Versatz konnte nicht gespeichert werden')
  } finally {
    savingOffset.value = false
  }
}

function remove(sheet: ScannerSheet) {
  confirm.require({
    message: `Das Blatt ${sheet.range} aus der Liste entfernen? Die Nummern werden nicht wieder vergeben.`,
    header: 'Blatt entfernen',
    icon: 'pi pi-exclamation-triangle',
    rejectLabel: 'Abbrechen',
    acceptLabel: 'Entfernen',
    acceptClass: 'p-button-danger',
    accept: async () => {
      try {
        await deleteScannerSheet(sheet.id)
        apply(await getScannerOverview())
      } catch (e) {
        error.value = message(e, 'Das Blatt konnte nicht entfernt werden')
      }
    },
  })
}
</script>

<template>
  <PageLayout
    title="Scanner-Etiketten"
    :hint="`Fortlaufende Nummern ab #0001 für Papierdokumente vor dem Scannen, als PDF für einen normalen Drucker. Bogen: ${overview?.sheet.name ?? 'Avery Zweckform L4731REV'}, ${labelsPerPage} Etiketten je Seite. In Originalgröße (100 %) drucken, nicht „an Seite anpassen“.`"
    :ready="loaded"
  >
    <template #notice>
      <Message v-if="info" severity="success" closable @close="info = null">{{ info }}</Message>
      <ErrorBanner v-if="error" :message="error" :retryable="false" closable @close="error = null" />
    </template>

    <div class="scanner">
      <PageSkeleton v-if="!loaded" variant="list" :count="3" />
      <template v-else-if="overview">
        <section class="card" aria-labelledby="scanner-next">
          <header class="card-head">
            <h2 id="scanner-next" class="card-title">Neues Blatt</h2>
            <span class="muted">Nächstes Blatt: {{ nextRange }}</span>
          </header>
          <div class="fields">
            <div class="field">
              <label for="scanner-pages">Seiten</label>
              <InputNumber
                v-model="pages"
                input-id="scanner-pages"
                :min="1"
                :max="maxPages"
                show-buttons
                :disabled="!canPrint"
              />
            </div>
            <Button
              v-if="canPrint"
              icon="pi pi-file-pdf"
              label="PDF erzeugen"
              :loading="creating"
              @click="create"
            />
          </div>
          <p v-if="!canPrint" class="muted">Etiketten erzeugen braucht das Recht „Label drucken“.</p>
        </section>

        <section class="card" aria-labelledby="scanner-sheets">
          <header class="card-head">
            <h2 id="scanner-sheets" class="card-title">Erzeugte Blätter</h2>
          </header>
          <EmptyState
            v-if="!overview.sheets.length"
            icon="pi pi-hashtag"
            title="Noch kein Blatt"
            message="Ein erzeugtes Blatt steht hier und lässt sich jederzeit wieder herunterladen."
          />
          <ScrollX v-else>
            <table class="table">
              <thead>
                <tr>
                  <th scope="col">Nummern</th>
                  <th scope="col" class="num">Seiten</th>
                  <th scope="col">Erzeugt</th>
                  <th scope="col"><span class="sr-only">Aktionen</span></th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="sheet in overview.sheets" :key="sheet.id">
                  <td class="range">{{ sheet.range }}</td>
                  <td class="num">{{ sheet.pages }}</td>
                  <td>{{ when(sheet.createdAt) }}</td>
                  <td class="actions">
                    <Button
                      icon="pi pi-download"
                      text
                      rounded
                      :aria-label="`${sheet.range} herunterladen`"
                      v-tooltip.top="'Herunterladen'"
                      :loading="downloading === sheet.id"
                      @click="download(sheet)"
                    />
                    <Button
                      v-if="canPrint"
                      icon="pi pi-trash"
                      text
                      rounded
                      severity="danger"
                      :aria-label="`${sheet.range} aus der Liste entfernen`"
                      v-tooltip.top="'Aus der Liste entfernen'"
                      @click="remove(sheet)"
                    />
                  </td>
                </tr>
              </tbody>
            </table>
          </ScrollX>
        </section>

        <section class="card" aria-labelledby="scanner-settings">
          <header class="card-head">
            <h2 id="scanner-settings" class="card-title">Einstellungen</h2>
          </header>
          <div class="fields">
            <div class="field">
              <label for="scanner-next-number">Nächste Nummer</label>
              <InputNumber
                v-model="nextNumber"
                input-id="scanner-next-number"
                :min="1"
                :max="999999"
                :use-grouping="false"
                :disabled="!canPrint"
              />
            </div>
            <Button
              v-if="canPrint"
              label="Übernehmen"
              severity="secondary"
              :disabled="!numberChanged || !nextNumber"
              :loading="savingNumber"
              @click="saveNumber"
            />
          </div>
          <p class="muted">
            Zählt nach jedem Blatt selbst weiter. Von Hand nur setzen, um dort weiterzumachen, wo bisherige Etiketten
            aufgehört haben.
          </p>

          <h3 class="sub-title">Druckversatz</h3>
          <div class="fields">
            <div class="field">
              <label for="scanner-offset-x">Nach rechts (mm)</label>
              <InputNumber
                v-model="offsetX"
                input-id="scanner-offset-x"
                :min="-10"
                :max="10"
                :step="0.5"
                :min-fraction-digits="0"
                :max-fraction-digits="1"
                locale="de-DE"
                show-buttons
                :disabled="!canPrint"
              />
            </div>
            <div class="field">
              <label for="scanner-offset-y">Nach unten (mm)</label>
              <InputNumber
                v-model="offsetY"
                input-id="scanner-offset-y"
                :min="-10"
                :max="10"
                :step="0.5"
                :min-fraction-digits="0"
                :max-fraction-digits="1"
                locale="de-DE"
                show-buttons
                :disabled="!canPrint"
              />
            </div>
            <Button
              v-if="canPrint"
              label="Übernehmen"
              severity="secondary"
              :disabled="!offsetChanged"
              :loading="savingOffset"
              @click="saveOffset"
            />
          </div>
          <p class="muted">
            Die Probeseite zeigt die Umrisse der Etiketten auf normalem Papier und verbraucht keine Nummern. Gegen das
            Licht auf einen Bogen gelegt zeigt sie, ob der Drucker verschoben druckt.
          </p>
          <div>
            <Button
              icon="pi pi-download"
              label="Probeseite"
              severity="secondary"
              outlined
              :loading="downloading === 'test'"
              @click="downloadTestPage"
            />
          </div>
        </section>
      </template>
    </div>
  </PageLayout>
</template>

<style scoped>
.scanner {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}
.card {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: var(--space-4);
  border: 1px solid var(--p-content-border-color);
  border-radius: 0.5rem;
  background: var(--p-content-background);
  min-width: 0;
}
.card-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: var(--space-2);
}
.card-title {
  margin: 0;
  font-size: var(--text-lg);
}
.sub-title {
  margin: var(--space-2) 0 0;
  font-size: var(--text-md);
}
.muted {
  margin: 0;
  color: var(--p-text-muted-color);
  font-size: var(--text-sm);
}
.fields {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: var(--space-3);
}
.field {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  min-width: 0;
}
.field label {
  font-size: var(--text-sm);
  color: var(--p-text-muted-color);
}
.field :deep(.p-inputnumber-input) {
  width: 8rem;
}
.table {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--text-sm);
}
.table th,
.table td {
  padding: var(--space-2);
  border-bottom: 1px solid var(--p-content-border-color);
  text-align: left;
  vertical-align: middle;
}
.table th {
  color: var(--p-text-muted-color);
  font-weight: 600;
}
.table .num {
  text-align: right;
}
.range {
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.actions {
  text-align: right;
  white-space: nowrap;
}
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
</style>
