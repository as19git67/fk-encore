<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import Button from 'primevue/button'
import { useConfirm } from 'primevue/useconfirm'
import ScrollX from '../layout/ScrollX.vue'
import SettlementDocumentDialog from './SettlementDocumentDialog.vue'
import {
  applySettlementDocument,
  getPortfolioReview,
  type PortfolioReviewConflict,
  type PortfolioReviewDocument,
  type PortfolioReviewResponse,
} from '../../api/finance'
import {
  depotKindLabel,
  formatIsoDate,
  formatQuantity,
  formatSignedCurrency,
} from '../../utils/financeFormat'

/**
 * What needs a look on the portfolio (issue #1336, stage 4): settlements
 * whose net disagrees with the transaction they describe, settlements no
 * depot holds the security of, and share changes between snapshots that no
 * transaction explains. Renders nothing while there is nothing to look at.
 *
 * Loads on its own (it runs a dry pass over the documents, which is slower
 * than the portfolio) and reloads when `accounts` or `reloadKey` changes.
 * Emits `changed` after a conflict was resolved, so the page reloads its
 * figures.
 */
const props = defineProps<{
  accounts: number[]
  /** Include closed depots when no `accounts` are selected. */
  includeClosed: boolean
  currency: string
  /** Bump to reload, e.g. after documents were read in. */
  reloadKey: number
}>()

const emit = defineEmits<{ (e: 'changed'): void }>()

const confirm = useConfirm()
const review = ref<PortfolioReviewResponse | null>(null)
const error = ref<string | null>(null)
const applying = ref<Set<number>>(new Set())

async function load() {
  error.value = null
  try {
    review.value = await getPortfolioReview({ accounts: props.accounts, closed: props.includeClosed })
  } catch (e: any) {
    error.value = e?.message ?? 'Prüfliste konnte nicht geladen werden'
  }
}

watch(
  () => [props.accounts.join(','), props.includeClosed, props.reloadKey],
  () => void load(),
  { immediate: true },
)

const hasContent = computed(() => {
  const r = review.value
  if (!r) return false
  return r.conflicts.length + r.unmatched_documents.length + r.holding_gaps.length > 0 || r.unverifiable_changes > 0
})

const count = computed(() => {
  const r = review.value
  return r ? r.conflicts.length + r.unmatched_documents.length + r.holding_gaps.length : 0
})

/** The document shown in the preview dialog; closing it leaves the page where it was. */
const openDocument = ref<number | null>(null)

function onApplyFromDialog(documentId: number) {
  const c = review.value?.conflicts.find((x) => x.document_id === documentId)
  openDocument.value = null
  if (c) askApply(c)
}

function askApply(c: PortfolioReviewConflict) {
  confirm.require({
    header: 'Werte aus dem Beleg übernehmen',
    message:
      `Die Transaktion vom ${formatIsoDate(c.executed_at)} (${c.name ?? c.position_key}) bekommt Stück, Kurs, ` +
      `Gebühren, Steuern und Betrag aus dem Beleg: ${formatSignedCurrency(c.statement_net, props.currency)} ` +
      `statt ${formatSignedCurrency(c.transaction_net, props.currency)}. Das Datum der Buchung bleibt.`,
    icon: 'pi pi-exclamation-triangle',
    rejectProps: { label: 'Abbrechen', severity: 'secondary', outlined: true },
    acceptProps: { label: 'Übernehmen' },
    accept: () => { void apply(c) },
  })
}

async function apply(c: PortfolioReviewConflict) {
  applying.value.add(c.document_id)
  try {
    await applySettlementDocument(c.document_id)
    await load()
    emit('changed')
  } catch (e: any) {
    error.value = e?.message ?? 'Beleg konnte nicht übernommen werden'
  } finally {
    applying.value.delete(c.document_id)
  }
}

/** Why a statement found no depot, from what it identified itself by. */
function unmatchedReason(d: PortfolioReviewDocument): string {
  const ids = [d.isin ? `ISIN ${d.isin}` : null, d.wkn ? `WKN ${d.wkn}` : null].filter(Boolean).join(', ')
  const parts = [ids ? `${ids} in keinem Depot` : 'kein Wertpapier erkannt']
  parts.push(d.depot_number ? `Depotnummer ${d.depot_number} unbekannt oder mehrdeutig` : 'keine Depotnummer gefunden')
  return parts.join(' · ')
}

function signClass(val: string | null): string {
  if (val === null) return ''
  const n = Number(val)
  return n > 0 ? 'gain-pos' : n < 0 ? 'gain-neg' : ''
}
</script>

<template>
  <section v-if="hasContent || error" class="pr-section" aria-labelledby="pr-heading">
    <h2 id="pr-heading">
      Zu prüfen
      <span v-if="count > 0" class="pr-count">{{ count }}</span>
    </h2>
    <p v-if="error" class="pr-error">{{ error }}</p>

    <template v-if="review">
      <!-- Conflicts -->
      <div v-if="review.conflicts.length > 0" class="pr-group">
        <h3>Beleg und Buchung weichen ab</h3>
        <p class="pr-hint">
          Der Betrag auf der Abrechnung passt nicht zur Transaktion. Nichts wurde überschrieben — übernimm die Werte des Belegs, wenn er stimmt.
        </p>
        <ScrollX>
          <table class="pr-table">
            <thead>
              <tr>
                <th>Datum</th>
                <th>Art</th>
                <th>Wertpapier</th>
                <th>Depot</th>
                <th class="pr-num">Beleg</th>
                <th class="pr-num">Transaktion</th>
                <th aria-label="Aktionen" />
              </tr>
            </thead>
            <tbody>
              <tr v-for="c in review.conflicts" :key="c.document_id">
                <td class="pr-date">{{ formatIsoDate(c.executed_at) }}</td>
                <td>{{ depotKindLabel(c.kind) }}</td>
                <td>
                  <RouterLink :to="{ name: 'finance-portfolio-position', params: { key: c.position_key } }" class="pr-link">
                    {{ c.name ?? c.position_key }}
                  </RouterLink>
                </td>
                <td>{{ c.account_label }}</td>
                <td class="pr-num" :class="signClass(c.statement_net)">{{ formatSignedCurrency(c.statement_net, currency) }}</td>
                <td class="pr-num" :class="signClass(c.transaction_net)">{{ formatSignedCurrency(c.transaction_net, currency) }}</td>
                <td class="pr-actions">
                  <button type="button" class="pr-doc" @click="openDocument = c.document_id">
                    <i class="pi pi-file" aria-hidden="true" /> Beleg ansehen
                  </button>
                  <Button
                    label="Übernehmen"
                    size="small"
                    severity="secondary"
                    :loading="applying.has(c.document_id)"
                    @click="askApply(c)"
                  />
                </td>
              </tr>
            </tbody>
          </table>
        </ScrollX>
      </div>

      <!-- Holding gaps -->
      <div v-if="review.holding_gaps.length > 0" class="pr-group">
        <h3>Bestand ohne passende Transaktion</h3>
        <p class="pr-hint">
          Zwischen zwei Depotständen hat sich die Stückzahl geändert, ohne dass eine Transaktion das erklärt — etwa ein Depotübertrag, ein Split oder eine fehlende Abrechnung.
        </p>
        <ScrollX>
          <table class="pr-table">
            <thead>
              <tr>
                <th>Zeitraum</th>
                <th>Wertpapier</th>
                <th>Depot</th>
                <th class="pr-num">Bestand</th>
                <th class="pr-num">Erklärt</th>
                <th class="pr-num">Offen</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="g in review.holding_gaps" :key="`${g.account_id}|${g.position_key}|${g.to}`">
                <td class="pr-date">{{ formatIsoDate(g.from) }} – {{ formatIsoDate(g.to) }}</td>
                <td>
                  <RouterLink :to="{ name: 'finance-portfolio-position', params: { key: g.position_key } }" class="pr-link">
                    {{ g.name ?? g.position_key }}
                  </RouterLink>
                </td>
                <td>{{ g.account_label }}</td>
                <td class="pr-num">{{ formatQuantity(g.amount_before) }} → {{ formatQuantity(g.amount_after) }}</td>
                <td class="pr-num">{{ formatQuantity(g.explained) }}</td>
                <td class="pr-num pr-strong">{{ Number(g.unexplained) > 0 ? '+' : '' }}{{ formatQuantity(g.unexplained) }} Stk</td>
              </tr>
            </tbody>
          </table>
        </ScrollX>
      </div>

      <!-- Unmatched documents -->
      <div v-if="review.unmatched_documents.length > 0" class="pr-group">
        <h3>Abrechnungen ohne Depot</h3>
        <p class="pr-hint">
          Kein Depot hält das Wertpapier dieser Belege, keine Depotnummer passt eindeutig, und es gibt keine Transaktionen dazu — vielleicht gehört der Beleg zu einem Depot, das noch nicht angebunden ist.
        </p>
        <ul class="pr-docs">
          <li v-for="d in review.unmatched_documents" :key="d.document_id">
            <button type="button" class="pr-doc" @click="openDocument = d.document_id">
              <i class="pi pi-file" aria-hidden="true" />
              {{ d.document_title ?? `Dokument ${d.document_id}` }}
            </button>
            <span v-if="d.doc_date" class="pr-date">{{ formatIsoDate(d.doc_date) }}</span>
            <span class="pr-reason">{{ unmatchedReason(d) }}</span>
          </li>
        </ul>
      </div>

      <p v-if="review.unverifiable_changes > 0" class="pr-hint">
        {{ review.unverifiable_changes }} Bestandsänderung{{ review.unverifiable_changes === 1 ? '' : 'en' }}
        lass{{ review.unverifiable_changes === 1 ? 't' : 'en' }} sich nicht prüfen, weil einer Transaktion die Stückzahl fehlt —
        „Belege einlesen" ergänzt sie, sobald die Abrechnung vorliegt.
      </p>
    </template>

    <SettlementDocumentDialog
      :document-id="openDocument"
      can-apply
      @close="openDocument = null"
      @apply="onApplyFromDialog"
    />
  </section>
</template>

<style scoped>
.pr-section {
  display: flex;
  flex-direction: column;
  /* Flex children size to their content by default; the tables inside
     must scroll in their ScrollX instead of widening the page. */
  min-width: 0;
  gap: var(--space-2);
  padding: var(--space-3);
  border: 1px solid var(--p-content-border-color);
  border-left: 4px solid var(--p-yellow-500);
  border-radius: 0.5rem;
  background: var(--p-content-background);
}
.pr-section h2 {
  margin: 0;
  font-size: var(--text-xl);
  font-weight: 600;
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.pr-count {
  font-size: var(--text-sm);
  font-weight: 600;
  padding: 0.05rem 0.5rem;
  border-radius: 999px;
  background: var(--p-tag-warn-background);
  color: var(--p-tag-warn-color);
}
.pr-group {
  display: flex;
  flex-direction: column;
  min-width: 0;
  gap: var(--space-1);
}
.pr-group h3 {
  margin: 0;
  font-size: var(--text-lg);
  font-weight: 600;
}
.pr-hint {
  margin: 0;
  font-size: var(--text-sm);
  color: var(--p-text-muted-color);
}
.pr-error {
  margin: 0;
  color: var(--p-red-600);
}
.pr-table {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--text-base);
}
.pr-table th {
  text-align: left;
  font-weight: 600;
  padding: 0.35rem 0.5rem;
  border-bottom: 2px solid var(--p-content-border-color);
  white-space: nowrap;
}
.pr-table td {
  padding: 0.35rem 0.5rem;
  border-bottom: 1px solid var(--p-content-border-color);
  vertical-align: middle;
  white-space: nowrap;
}
.pr-num {
  text-align: right !important;
  font-variant-numeric: tabular-nums;
}
.pr-strong {
  font-weight: 600;
}
.pr-date {
  color: var(--p-text-muted-color);
  font-variant-numeric: tabular-nums;
}
.pr-actions {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  justify-content: flex-end;
}
.pr-link {
  color: var(--p-primary-color);
}
.pr-doc {
  background: none;
  border: none;
  padding: 0;
  font: inherit;
  color: var(--p-primary-color);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  text-align: left;
}
.pr-doc:hover {
  text-decoration: underline;
}
.pr-doc:focus-visible {
  outline: var(--focus-ring);
  outline-offset: var(--focus-ring-offset);
}
.pr-docs {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}
.pr-docs li {
  display: flex;
  gap: 0.15rem var(--space-2);
  align-items: baseline;
  flex-wrap: wrap;
}
.pr-reason {
  flex-basis: 100%;
  font-size: var(--text-sm);
  color: var(--p-text-muted-color);
  overflow-wrap: anywhere;
}
.gain-pos {
  color: var(--p-green-600);
}
.gain-neg {
  color: var(--p-red-600);
}
@media (max-width: 639px) {
  .pr-table {
    font-size: var(--text-sm);
  }
}
</style>
