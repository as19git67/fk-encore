<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import Button from 'primevue/button'
import Dialog from 'primevue/dialog'
import Message from 'primevue/message'
import ProgressSpinner from 'primevue/progressspinner'
import PdfViewer from '../PdfViewer.vue'
import { fetchDocumentBytes } from '../../api/documents'
import {
  inspectSettlementDocument,
  type SettlementInspection,
  type SettlementInspectionFields,
} from '../../api/finance'
import {
  depotKindLabel,
  formatCurrency,
  formatIsoDate,
  formatQuantity,
  formatSignedCurrency,
} from '../../utils/financeFormat'

/**
 * A settlement document over the portfolio (issue #1336): the PDF on one
 * side, on the other what the parser read from it — every field it looks
 * for, the value it found or that it found none, and the printed label it
 * read the value after — plus which depot it belongs to, how that depot
 * was found, and what reading it in would do.
 *
 * A dialog rather than a link to the document page, so closing it returns
 * to exactly where the user was in the portfolio. `documentId` null keeps
 * it closed.
 */
const props = withDefaults(
  defineProps<{
    documentId: number | null
    /** Offer "apply the statement's values" on a conflict; the host handles `apply`. */
    canApply?: boolean
  }>(),
  { canApply: false },
)

const emit = defineEmits<{
  (e: 'close'): void
  /** The user wants the statement's values applied to the conflicting transaction. */
  (e: 'apply', documentId: number): void
  /**
   * Opening the statement asked the model for the first time. Its answer
   * is stored, so a list that judged the statement without it is stale.
   */
  (e: 'read', documentId: number): void
}>()

const router = useRouter()

const inspection = ref<SettlementInspection | null>(null)
const pdfData = ref<Uint8Array | null>(null)
const loading = ref(false)
const error = ref<string | null>(null)
const pdfError = ref<string | null>(null)
let inFlightFor: number | null = null

const visible = computed({
  get: () => props.documentId !== null,
  set: (v: boolean) => { if (!v) emit('close') },
})

watch(() => props.documentId, (id) => void load(id), { immediate: true })

async function load(id: number | null) {
  inFlightFor = id
  inspection.value = null
  pdfData.value = null
  error.value = null
  pdfError.value = null
  if (id === null) return
  loading.value = true
  try {
    const r = await inspectSettlementDocument(id)
    if (inFlightFor === id) inspection.value = r
    if (r.llm_status === 'used') emit('read', id)
  } catch (e: any) {
    if (inFlightFor === id) error.value = e?.message ?? 'Erkennung konnte nicht geladen werden'
  } finally {
    if (inFlightFor === id) loading.value = false
  }
  try {
    const bytes = await fetchDocumentBytes(id)
    if (inFlightFor === id) pdfData.value = bytes
  } catch (e: any) {
    if (inFlightFor === id) pdfError.value = e?.message ?? 'Vorschau konnte nicht geladen werden'
  }
}

const header = computed(() => inspection.value?.title ?? (props.documentId !== null ? `Dokument ${props.documentId}` : ''))

type FieldKey = keyof SettlementInspectionFields

const FIELD_ROWS: Array<{ key: FieldKey; label: string }> = [
  { key: 'kind', label: 'Art' },
  { key: 'isin', label: 'ISIN' },
  { key: 'wkn', label: 'WKN' },
  { key: 'name', label: 'Wertpapier' },
  { key: 'depot_number', label: 'Depotnummer' },
  { key: 'executed_at', label: 'Ausführungstag' },
  { key: 'quantity', label: 'Stück' },
  { key: 'price', label: 'Kurs' },
  { key: 'gross', label: 'Kurswert / Brutto' },
  { key: 'fees', label: 'Gebühren' },
  { key: 'tax', label: 'Steuern' },
  { key: 'net', label: 'Betrag (netto)' },
  { key: 'currency', label: 'Währung' },
]

/**
 * Each kind of paper prints its own fields: what a field means there (its
 * label) and which fields it never prints (hidden, not "nicht gefunden").
 */
const PAPER_FIELDS: Record<string, { labels: Partial<Record<FieldKey, string>>; hidden: FieldKey[] }> = {
  trade: { labels: {}, hidden: [] },
  dividend: { labels: { price: 'Betrag je Stück', gross: 'Brutto' }, hidden: [] },
  tax_statement: { labels: { gross: 'Betrag vor Steuern', net: 'Betrag nach Steuern' }, hidden: ['price', 'fees'] },
  accumulation: { labels: { tax: 'Abgeführte Steuer', net: 'Abfluss' }, hidden: ['price', 'gross', 'fees'] },
}

/** The checks a kind of paper can be put through at all. */
const PAPER_CHECKS: Record<string, string[]> = {
  tax_statement: ['net_equation', 'isin_checksum', 'date_plausible', 'booking_net'],
  accumulation: ['isin_checksum', 'date_plausible'],
}

const paperFields = computed(() => PAPER_FIELDS[inspection.value?.paper_type ?? ''] ?? PAPER_FIELDS.trade!)

const visibleRows = computed(() =>
  FIELD_ROWS.filter((r) => {
    if (paperFields.value.hidden.includes(r.key)) return false
    // A dividend rarely charges fees: the row only when it does.
    if (inspection.value?.paper_type === 'dividend' && r.key === 'fees') return fieldValue(r.key) !== null
    return true
  }),
)

const visibleChecks = computed(() => {
  const allowed = PAPER_CHECKS[inspection.value?.paper_type ?? '']
  const checks = inspection.value?.checks ?? []
  return allowed ? checks.filter((c) => allowed.includes(c.name)) : checks
})

function rowLabel(row: { key: FieldKey; label: string }): string {
  if (inspection.value?.tax_pending && row.key === 'net') return 'Betrag vor Steuern'
  // A negative tax is one the bank gave back (a loss offset): it raises the net.
  if (row.key === 'tax' && Number(inspection.value?.fields.tax ?? 0) < 0) return 'Steuern (erstattet)'
  return paperFields.value.labels[row.key] ?? row.label
}

function format(key: FieldKey, v: string | null): string | null {
  if (v === null) return null
  const cur = inspection.value?.fields.currency ?? null
  switch (key) {
    case 'kind': return depotKindLabel(v)
    case 'executed_at': return formatIsoDate(v)
    case 'quantity': return formatQuantity(v)
    case 'price':
    case 'gross':
    case 'fees':
    case 'tax': return formatCurrency(v, cur)
    case 'net': return formatSignedCurrency(v, cur)
    default: return v
  }
}

function fieldValue(key: FieldKey): string | null {
  return format(key, inspection.value?.fields[key] ?? null)
}

function sourceOf(key: FieldKey) {
  return inspection.value?.sources?.[key] ?? null
}

const SOURCE_TEXT: Record<string, string> = {
  both: 'Regel = KI',
  rules: 'Regel',
  llm: 'KI',
  derived: 'berechnet',
}

const LLM_STATUS_TEXT: Record<string, string> = {
  used: 'Gelesen mit festen Regeln und dem KI-Modell (gerade gefragt).',
  cached: 'Gelesen mit festen Regeln und dem KI-Modell (gespeicherte Antwort).',
  unavailable: 'Gelesen nur mit festen Regeln — das KI-Modell war nicht erreichbar.',
  skipped: 'Gelesen nur mit festen Regeln — der Text sieht nicht nach Wertpapierbeleg aus, das KI-Modell wurde nicht gefragt.',
  off: 'Gelesen nur mit festen Regeln.',
}

const CHECK_TEXT: Record<string, string> = {
  net_equation: 'Kurswert ± Gebühren ± Steuern = Betrag',
  quantity_price: 'Stück × Kurs ≈ Kurswert',
  isin_checksum: 'ISIN-Prüfziffer',
  date_plausible: 'Datum plausibel',
  booking_net: 'Betrag = Buchung auf dem Konto',
}

const hasLlm = computed(() => inspection.value?.llm_fallback_used === true)

const recognisedCount = computed(() => visibleRows.value.filter((r) => fieldValue(r.key) !== null).length)

const REJECTION_TEXT: Record<string, string> = {
  no_text: 'Das Dokument hat keinen gelesenen Text (OCR fehlt oder ist leer).',
  insurance: 'Das ist ein Versicherungsschreiben (Police, Standmitteilung, Überschussbeteiligung) — es betrifft kein Depot, auch wenn es Fonds mit ISIN nennt.',
  cost_info: 'Das ist eine Kosteninformation zur Order (MiFID II), keine Abrechnung — die Wertpapierabrechnung kommt als eigener Beleg.',
  account_statement: 'Das ist ein Kontoauszug des Verrechnungskontos ohne eigene Wertpapierabrechnung (Gebühren, Zinsen, Überträge) — er betrifft die Depots nicht.',
  llm_other: 'Das KI-Modell hält den Beleg nicht für eine Wertpapierabrechnung, und die Regeln finden keine eindeutige Überschrift dagegen.',
  no_kind: 'Kein Hinweis auf Kauf, Verkauf oder Dividende gefunden — der Beleg gilt nicht als Abrechnung.',
  no_identifier: 'Weder ISIN noch WKN gefunden — ohne Wertpapierkennung kann nichts zugeordnet werden.',
  no_date: 'Weder Ausführungstag noch Dokumentdatum gefunden.',
  no_amount: 'Kein Betrag gefunden (weder Netto, Kurswert noch Stück × Kurs).',
}

const MATCHED_BY_TEXT: Record<string, string> = {
  holding: 'über den Bestand (das Depot hält das Wertpapier)',
  depot_number: 'über die Depotnummer auf dem Beleg',
  transactions: 'über bestehende Transaktionen desselben Wertpapiers',
  booking: 'über die Girobuchung, der der Beleg zugeordnet ist',
}

const depotLine = computed(() => {
  const d = inspection.value?.depot
  if (!d) return null
  if (d.outcome === 'no_holding') {
    return 'Kein Depot gefunden: weder im Bestand noch über die Depotnummer noch über bestehende Transaktionen.'
  }
  if (d.account_id === null) return null
  const via = d.matched_by ? ` — gefunden ${MATCHED_BY_TEXT[d.matched_by]}` : ''
  return `Depot: ${d.account_label ?? `#${d.account_id}`}${via}.`
})

const outcomeLine = computed(() => {
  const d = inspection.value?.depot
  if (!d) return null
  const line = outcomeText(d)
  if (line && d.checked_against_booking) {
    return `Regel und KI lasen verschieden — der gebuchte Betrag auf dem Konto hat entschieden. ${line}`
  }
  return line
})

function outcomeText(d: NonNullable<SettlementInspection['depot']>): string | null {
  const cur = inspection.value?.fields.currency
  if (inspection.value?.tax_statement) {
    switch (d.outcome) {
      case 'enriched': return 'Einlesen würde die Steuer an der passenden Transaktion ergänzen und den Beleg dort verknüpfen.'
      case 'linked': return 'Einlesen würde den Beleg mit der passenden Transaktion verknüpfen; ihre Steuer ist schon eingetragen.'
      case 'no_transaction':
        return 'Keine passende Transaktion gefunden (gleiches Wertpapier, gleiche Art und Stückzahl, ±7 Tage). Eine Steuermitteilung legt keine eigene Transaktion an.'
    }
  }
  switch (d.outcome) {
    case 'created': return 'Einlesen würde eine neue Transaktion anlegen.'
    case 'enriched': return 'Einlesen würde die vorhandene Transaktion um fehlende Werte ergänzen.'
    case 'linked': return 'Einlesen würde den Beleg mit der passenden Transaktion verknüpfen.'
    case 'already_linked': return 'Der Beleg ist bereits mit einer Transaktion verknüpft.'
    case 'unverified': return 'Einlesen bucht nichts, solange Regel und KI sich widersprechen und keine Rechnung aufgeht.'
    case 'conflict':
      return `Der Betrag weicht ab: Beleg ${formatSignedCurrency(d.statement_net, cur)}, Transaktion ${formatSignedCurrency(d.transaction_net, cur)}. Nichts wurde überschrieben.`
    default: return null
  }
}

function openInDocuments() {
  if (props.documentId === null) return
  const id = props.documentId
  emit('close')
  void router.push({ name: 'dokumente-detail', params: { id } })
}
</script>

<template>
  <Dialog
    v-model:visible="visible"
    class="dialog-lg"
    modal
    block-scroll
    :header="header"
    :draggable="false"
  >
    <div class="sd-body">
      <div class="sd-pdf">
        <PdfViewer :data="pdfData" :error-message="pdfError" />
      </div>

      <section class="sd-recognition" aria-label="Erkennung">
        <div v-if="loading && !inspection" class="sd-loading">
          <ProgressSpinner style="width: 32px; height: 32px" />
        </div>
        <Message v-else-if="error" severity="error" :closable="false">{{ error }}</Message>

        <template v-else-if="inspection">
          <p class="sd-method">
            <i class="pi pi-info-circle" aria-hidden="true" />
            {{ LLM_STATUS_TEXT[inspection.llm_status] ?? 'Gelesen mit festen Regeln.' }}
          </p>

          <p v-if="inspection.is_settlement && inspection.tax_statement" class="sd-status sd-ok">
            Als Steuermitteilung ({{ depotKindLabel(inspection.fields.kind ?? '') }}) erkannt · ergänzt nur die Steuer einer vorhandenen Transaktion
          </p>
          <p v-else-if="inspection.is_settlement && inspection.accumulation" class="sd-status sd-ok">
            Als Thesaurierung bzw. Vorabpauschale erkannt · ausgeschüttet wurde nichts, gebucht wird nur die abgeführte Steuer
          </p>
          <p v-else-if="inspection.is_settlement && inspection.tax_pending" class="sd-status sd-ok">
            Als {{ depotKindLabel(inspection.fields.kind ?? '') }}-Gutschrift vor Steuern erkannt · die Steuermitteilung ergänzt Steuern und Betrag nach Steuern
          </p>
          <p v-else-if="inspection.is_settlement" class="sd-status sd-ok">
            Als {{ depotKindLabel(inspection.fields.kind ?? '') }}-Abrechnung erkannt · {{ recognisedCount }} von {{ visibleRows.length }} Feldern gefunden
          </p>
          <p v-else class="sd-status sd-warn">
            {{ REJECTION_TEXT[inspection.rejection ?? ''] ?? 'Nicht als Abrechnung erkannt.' }}
          </p>

          <p v-if="inspection.verdict === 'unverified'" class="sd-status sd-warn">
            Regel und KI lesen unterschiedliche Werte, und keine Variante geht rechnerisch auf — es wurde nichts gebucht.
          </p>

          <table class="sd-fields">
            <thead>
              <tr>
                <th>Feld</th>
                <th>Verwendet</th>
                <th>Quelle</th>
                <th v-if="hasLlm">Regel / KI</th>
                <th v-else>gelesen nach</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="row in visibleRows"
                :key="row.key"
                :class="{ 'sd-missing': fieldValue(row.key) === null, 'sd-disagree': sourceOf(row.key)?.disagree }"
              >
                <td>{{ rowLabel(row) }}</td>
                <td class="sd-value">{{ fieldValue(row.key) ?? 'nicht gefunden' }}</td>
                <td>
                  <span
                    v-if="sourceOf(row.key)?.source"
                    class="sd-source"
                    :class="`sd-source-${sourceOf(row.key)!.source}`"
                  >{{ SOURCE_TEXT[sourceOf(row.key)!.source!] }}</span>
                </td>
                <td v-if="hasLlm" class="sd-label">
                  <template v-if="sourceOf(row.key)?.disagree">
                    {{ format(row.key, sourceOf(row.key)!.rules) }} / {{ format(row.key, sourceOf(row.key)!.llm) }}
                    <span v-if="inspection.labels[row.key]" class="sd-label-after">Regel las nach „{{ inspection.labels[row.key] }}“</span>
                  </template>
                  <template v-else>{{ inspection.labels[row.key] ?? '' }}</template>
                </td>
                <td v-else class="sd-label">{{ inspection.labels[row.key] ?? '' }}</td>
              </tr>
            </tbody>
          </table>

          <ul v-if="visibleChecks.length" class="sd-checks" aria-label="Rechenprüfungen">
            <li v-for="c in visibleChecks" :key="c.name" :class="`sd-check-${c.result}`">
              <i
                :class="c.result === 'ok' ? 'pi pi-check-circle' : c.result === 'failed' ? 'pi pi-times-circle' : 'pi pi-minus-circle'"
                aria-hidden="true"
              />
              {{ CHECK_TEXT[c.name] ?? c.name }}:
              {{ c.result === 'ok' ? 'stimmt' : c.result === 'failed' ? 'stimmt nicht' : 'nicht prüfbar' }}
              <span v-if="c.detail && c.result !== 'skipped'" class="sd-check-detail">({{ c.detail }})</span>
            </li>
          </ul>
          <p v-if="inspection.depot?.date_source === 'document_date'" class="sd-note">
            Kein Ausführungstag auf dem Beleg — verwendet wird das Dokumentdatum {{ formatIsoDate(inspection.doc_date) }}.
          </p>

          <div v-if="depotLine || outcomeLine" class="sd-depot">
            <p v-if="depotLine">{{ depotLine }}</p>
            <p v-if="outcomeLine" :class="{ 'sd-warn': inspection.depot?.outcome === 'conflict' }">{{ outcomeLine }}</p>
          </div>

          <div v-if="inspection.links.length > 0" class="sd-links">
            <h3>Verknüpft mit</h3>
            <ul>
              <li v-for="l in inspection.links" :key="l.depot_transaction_id">
                <RouterLink
                  :to="{ name: 'finance-portfolio-position', params: { key: l.position_key } }"
                  class="sd-link"
                  @click="emit('close')"
                >
                  {{ depotKindLabel(l.kind) }} vom {{ formatIsoDate(l.executed_at) }}
                </RouterLink>
                · {{ l.account_label }} · {{ formatSignedCurrency(l.net_amount, inspection.fields.currency) }}
              </li>
            </ul>
          </div>
        </template>
      </section>
    </div>

    <template #footer>
      <div class="sd-footer">
      <Button
        label="Im Dokumentmodul öffnen"
        icon="pi pi-arrow-up-right"
        severity="secondary"
        text
        :disabled="documentId === null"
        @click="openInDocuments"
      />
      <span class="sd-spacer" />
      <Button
        v-if="canApply && inspection?.depot?.outcome === 'conflict'"
        label="Werte aus Beleg übernehmen"
        severity="secondary"
        @click="emit('apply', inspection!.document_id)"
      />
      <Button label="Schließen" @click="emit('close')" />
      </div>
    </template>
  </Dialog>
</template>

<style scoped>
.sd-body {
  display: grid;
  grid-template-columns: minmax(0, 3fr) minmax(0, 2fr);
  gap: var(--space-3);
  min-height: 60vh;
}
.sd-pdf {
  /* A flex container with a definite height: that is what lets PdfViewer
     fill it and scroll its page stack itself (the same contract as the
     document detail's .pdf-panel). Without it the viewer grows with the
     pages, the overflow is clipped and nothing scrolls. */
  display: flex;
  min-width: 0;
  height: 70vh;
  border: 1px solid var(--p-content-border-color);
  border-radius: 0.5rem;
  overflow: hidden;
}
.sd-recognition {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  min-width: 0;
  overflow-y: auto;
  max-height: 70vh;
}
.sd-loading {
  display: flex;
  justify-content: center;
  padding: var(--space-4);
}
.sd-method {
  margin: 0;
  font-size: var(--text-sm);
  color: var(--p-text-muted-color);
  display: flex;
  gap: 0.4rem;
  align-items: baseline;
}
.sd-status {
  margin: 0;
  font-weight: 600;
}
.sd-ok {
  color: var(--p-green-600);
}
.sd-warn {
  color: var(--p-yellow-700);
}
.sd-fields {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--text-sm);
}
.sd-fields th {
  text-align: left;
  font-weight: 600;
  padding: 0.25rem 0.4rem;
  border-bottom: 2px solid var(--p-content-border-color);
}
.sd-fields td {
  padding: 0.25rem 0.4rem;
  border-bottom: 1px solid var(--p-content-border-color);
  vertical-align: top;
}
.sd-value {
  font-variant-numeric: tabular-nums;
  overflow-wrap: anywhere;
}
.sd-label {
  color: var(--p-text-muted-color);
  font-style: italic;
}
.sd-label-after {
  display: block;
  font-size: var(--text-xs);
}
.sd-disagree td {
  background: rgba(234, 179, 8, 0.12);
}
.sd-source {
  display: inline-block;
  padding: 0 0.4rem;
  border-radius: 999px;
  font-size: var(--text-xs);
  white-space: nowrap;
  background: var(--p-tag-secondary-background);
  color: var(--p-tag-secondary-color);
}
.sd-source-both {
  background: var(--p-tag-success-background);
  color: var(--p-tag-success-color);
}
.sd-source-llm {
  background: var(--p-tag-info-background);
  color: var(--p-tag-info-color);
}
.sd-source-derived {
  background: var(--p-tag-warn-background);
  color: var(--p-tag-warn-color);
}
.sd-checks {
  list-style: none;
  margin: 0;
  padding: 0;
  font-size: var(--text-sm);
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
}
.sd-checks .pi {
  margin-right: 0.25rem;
}
.sd-check-ok .pi {
  color: var(--p-green-600);
}
.sd-check-failed {
  color: var(--p-red-600);
}
.sd-check-skipped {
  color: var(--p-text-muted-color);
}
.sd-check-detail {
  color: var(--p-text-muted-color);
  font-variant-numeric: tabular-nums;
  overflow-wrap: anywhere;
}
.sd-missing td {
  color: var(--p-text-muted-color);
}
.sd-missing .sd-value {
  font-style: italic;
}
.sd-note {
  margin: 0;
  font-size: var(--text-sm);
  color: var(--p-text-muted-color);
}
.sd-depot p {
  margin: 0 0 0.25rem;
}
.sd-links h3 {
  margin: 0 0 0.25rem;
  font-size: var(--text-base);
  font-weight: 600;
}
.sd-links ul {
  margin: 0;
  padding-left: 1.1rem;
  font-size: var(--text-sm);
}
.sd-link {
  color: var(--p-primary-color);
}
.sd-footer {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
}
.sd-spacer {
  flex: 1 1 auto;
}

@media (max-width: 767px) {
  .sd-body {
    grid-template-columns: minmax(0, 1fr);
  }
  .sd-pdf {
    height: 45vh;
  }
  .sd-recognition {
    max-height: none;
  }
  /* Three buttons do not fit one phone row: the primary pair takes the
     width, the way out to the documents module sits above them. */
  .sd-spacer {
    display: none;
  }
  .sd-footer > :deep(.p-button) {
    flex: 1 1 auto;
  }
}
</style>
