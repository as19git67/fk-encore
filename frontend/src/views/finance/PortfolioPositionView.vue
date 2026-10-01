<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import Button from 'primevue/button'
import Chart from 'primevue/chart'
import SelectButton from 'primevue/selectbutton'
import PageLayout from '../../components/layout/PageLayout.vue'
import ScrollX from '../../components/layout/ScrollX.vue'
import EmptyState from '../../components/layout/EmptyState.vue'
import PageSkeleton from '../../components/layout/PageSkeleton.vue'
import ErrorBanner from '../../components/layout/ErrorBanner.vue'
import DepotTxSources from '../../components/finance/DepotTxSources.vue'
import { useModuleBack } from '../../composables/useModuleBack'
import { useMediaQuery } from '../../composables/useBreakpoint'
import { compactDateLabels, fullDateLabel } from '../../utils/financeChartDates'
import {
  getPortfolioPosition,
  type PortfolioPositionResponse,
  type PortfolioTransaction,
} from '../../api/finance'
import {
  depotKindLabel,
  formatCurrency,
  formatIsoDate,
  formatPercent,
  formatQuantity,
  formatSignedCurrency,
  formatSignedPercent,
  gainSign,
} from '../../utils/financeFormat'

/**
 * One security in detail (issue #1336, stage 3): the figures of the
 * position across depots, its value or price over time with the buys,
 * sells and dividends marked on the curve, each sale with the cost it was
 * matched against, income and costs per year, and every transaction.
 *
 * The key is COALESCE(isin, wkn, name), as on the portfolio page; an
 * `accounts` query narrows the depots exactly as it does there.
 */

const route = useRoute()
const { goBack } = useModuleBack('/finanzen', 'finance-portfolio')

const positionKey = computed(() => String(route.params.key ?? ''))
const accountIds = computed<number[]>(() => {
  const raw = route.query.accounts
  return (typeof raw === 'string' ? raw : '')
    .split(',')
    .map((s) => Number(s))
    .filter((n) => Number.isInteger(n) && n > 0)
})

const data = ref<PortfolioPositionResponse | null>(null)
const loading = ref(false)
const error = ref<string | null>(null)

async function load() {
  if (!positionKey.value) return
  loading.value = true
  error.value = null
  try {
    data.value = await getPortfolioPosition(positionKey.value, { accounts: accountIds.value })
  } catch (e: any) {
    data.value = null
    error.value = e?.message ?? 'Position konnte nicht geladen werden'
  } finally {
    loading.value = false
  }
}

onMounted(load)
watch([positionKey, () => accountIds.value.join(',')], () => void load())

const position = computed(() => data.value?.position ?? null)
const currency = computed(() => position.value?.currency ?? data.value?.currency ?? 'EUR')
const title = computed(() => position.value?.name ?? positionKey.value ?? 'Position')

const hint = computed(() => {
  const p = position.value
  if (!p) return undefined
  const parts: string[] = []
  if (p.isin) parts.push(`ISIN ${p.isin}`)
  if (p.wkn) parts.push(`WKN ${p.wkn}`)
  parts.push(p.open ? 'offen' : 'geschlossen')
  if (p.price_as_of) parts.push(`Kurs vom ${formatIsoDate(p.price_as_of)}`)
  return parts.join(' · ')
})

function signClass(val: string | null): string {
  return `gain-${gainSign(val)}`
}

// ── Chart ────────────────────────────────────────────────────────────
// Value or price as a line, with every buy, sell and dividend as a dot
// on the day it happened. The marker sits at the curve's level that day
// (or the nearest earlier snapshot), so it reads as "this happened here".

const metricOptions = [
  { label: 'Wert', value: 'value' },
  { label: 'Kurs', value: 'price' },
]
const metric = ref<'value' | 'price'>('value')

const isDark = useMediaQuery('(prefers-color-scheme: dark)')

const history = computed(() => data.value?.history ?? [])
const hasChart = computed(() => history.value.length >= 2)

function seriesValue(point: { value: string | null; price: string | null }): number | null {
  const raw = metric.value === 'value' ? point.value : point.price
  if (raw === null) return null
  const n = Number(raw)
  return Number.isFinite(n) ? n : null
}

/**
 * Index of the last history point on or before the day. A transaction
 * older than the first snapshot (the depot was synced later than it was
 * traded) sits on the first point rather than vanishing from the chart.
 */
function indexOnOrBefore(day: string): number {
  const points = history.value
  let idx = 0
  for (let i = 0; i < points.length; i++) {
    if ((points[i]?.as_of ?? '') <= day) idx = i
    else break
  }
  return idx
}

interface MarkerSpec {
  kind: 'buy' | 'sell' | 'dividend'
  label: string
  color: string
}

const MARKERS: MarkerSpec[] = [
  { kind: 'buy', label: 'Kauf', color: '#2563eb' },
  { kind: 'sell', label: 'Verkauf', color: '#d97706' },
  { kind: 'dividend', label: 'Dividende', color: '#16a34a' },
]

const chartData = computed(() => {
  if (!hasChart.value) return null
  const points = history.value
  const line = points.map(seriesValue)
  const lineColor = isDark.value ? '#fbbf24' : '#2563eb'

  const markerSets = MARKERS.map((spec) => {
    const dots: Array<number | null> = points.map(() => null)
    const notes: Array<string[]> = points.map(() => [])
    for (const tx of data.value?.transactions ?? []) {
      if (tx.kind !== spec.kind) continue
      const idx = indexOnOrBefore(tx.executed_at)
      dots[idx] = line[idx] ?? null
      notes[idx]?.push(markerNote(tx))
    }
    return {
      label: spec.label,
      data: dots,
      type: 'scatter' as const,
      showLine: false,
      pointRadius: 5,
      pointHoverRadius: 7,
      pointBackgroundColor: spec.color,
      pointBorderColor: isDark.value ? '#0f172a' : '#ffffff',
      pointBorderWidth: 1.5,
      notes,
    }
  })

  return {
    labels: compactDateLabels(points.map((p) => p.as_of)),
    datasets: [
      {
        label: metric.value === 'value' ? 'Wert' : 'Kurs',
        data: line,
        borderColor: lineColor,
        backgroundColor: 'transparent',
        fill: false,
        tension: 0.25,
        pointRadius: 0,
        pointHitRadius: 8,
        spanGaps: false,
        order: 2,
      },
      ...markerSets.map((set) => ({ ...set, order: 1 })),
    ],
  }
})

function markerNote(tx: PortfolioTransaction): string {
  const parts = [`${formatIsoDate(tx.executed_at)} ${depotKindLabel(tx.kind)}`]
  if (tx.amount !== null) parts.push(`${formatQuantity(tx.amount)} Stk`)
  if (tx.net_amount !== null) parts.push(formatSignedCurrency(tx.net_amount, tx.currency))
  else if (tx.gross_amount !== null) parts.push(formatCurrency(tx.gross_amount, tx.currency))
  return parts.join(' · ')
}

const chartOptions = computed(() => {
  const tick = isDark.value ? '#94a3b8' : '#64748b'
  const grid = isDark.value ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)'
  const fmt = new Intl.NumberFormat('de-DE', { style: 'currency', currency: currency.value })
  const isoDates = history.value.map((p) => p.as_of)
  return {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'nearest' as const, intersect: false },
    plugins: {
      legend: { display: true, labels: { color: tick, usePointStyle: true, boxWidth: 8 } },
      tooltip: {
        callbacks: {
          title: (ctx: Array<{ dataIndex: number }>) =>
            fullDateLabel(isoDates[ctx[0]?.dataIndex ?? 0] ?? ''),
          label: (ctx: { parsed: { y: number }; dataset: { label?: string; notes?: string[][] }; dataIndex: number }) => {
            const notes = ctx.dataset.notes?.[ctx.dataIndex]
            if (notes && notes.length > 0) return notes
            return `${ctx.dataset.label ?? ''}: ${fmt.format(ctx.parsed.y)}`
          },
        },
      },
    },
    scales: {
      x: {
        ticks: { color: tick, maxRotation: 0, autoSkip: true, autoSkipPadding: 12 },
        grid: { color: grid },
      },
      y: {
        ticks: {
          color: tick,
          callback: (val: number | string) => fmt.format(typeof val === 'number' ? val : Number(val)),
        },
        grid: { color: grid },
      },
    },
  }
})

// ── Tables ───────────────────────────────────────────────────────────
const accountLabelById = computed(() => {
  const m = new Map<number, string>()
  for (const a of data.value?.accounts ?? []) m.set(a.account_id, a.account_label)
  for (const t of data.value?.transactions ?? []) m.set(t.account_id, t.account_label)
  return m
})

function transactionCash(tx: PortfolioTransaction): string {
  if (tx.net_amount !== null) return formatSignedCurrency(tx.net_amount, tx.currency)
  if (tx.gross_amount !== null) return formatCurrency(tx.gross_amount, tx.currency)
  return '–'
}
</script>

<template>
  <PageLayout :title="title" :hint="hint" width="wide" :ready="!loading">
    <template #actions>
      <Button icon="pi pi-arrow-left" text rounded aria-label="Zurück" @click="goBack" />
      <Button
        icon="pi pi-refresh"
        label="Aktualisieren"
        severity="secondary"
        text
        :disabled="loading"
        @click="load"
      />
    </template>

    <template #notice>
      <ErrorBanner v-if="error" :message="error" closable @retry="load" @close="error = null" />
    </template>

    <PageSkeleton v-if="loading && !data" variant="list" :count="6" />

    <EmptyState
      v-else-if="!data || !position"
      icon="pi pi-briefcase"
      title="Position nicht gefunden"
      message="Kein Depot in deinem Zugriff kennt dieses Wertpapier."
    />

    <template v-else>
      <!-- ── Key figures ──────────────────────────────────────────── -->
      <section class="pp-section" aria-labelledby="pp-kpi-heading">
        <h2 id="pp-kpi-heading" class="visually-hidden">Kennzahlen</h2>
        <div class="pp-kpis">
          <div class="pp-kpi">
            <span class="pp-kpi-label">Bestand</span>
            <span class="pp-kpi-value">{{ formatQuantity(position.amount) }} Stk</span>
            <span class="pp-kpi-sub">Kurs {{ formatCurrency(position.price, currency) }}</span>
          </div>
          <div class="pp-kpi">
            <span class="pp-kpi-label">Wert</span>
            <span class="pp-kpi-value">{{ formatCurrency(position.value, currency) }}</span>
            <span v-if="position.weight_pct !== null" class="pp-kpi-sub">{{ formatPercent(position.weight_pct) }} des Portfolios</span>
          </div>
          <div class="pp-kpi">
            <span class="pp-kpi-label">Einstand</span>
            <span class="pp-kpi-value">{{ formatCurrency(position.cost_basis, currency) }}</span>
            <span class="pp-kpi-sub">
              <template v-if="position.cost_basis_per_unit !== null">{{ formatCurrency(position.cost_basis_per_unit, currency) }} je Stück</template>
              <template v-if="position.cost_basis_source === 'tx-wac'"> · ∅ aus Käufen</template>
              <template v-if="position.open && position.cost_basis === null">
                <i class="pi pi-exclamation-triangle pp-warn" aria-hidden="true" /> unbekannt
              </template>
            </span>
          </div>
          <div class="pp-kpi">
            <span class="pp-kpi-label">Unrealisiert</span>
            <span class="pp-kpi-value" :class="signClass(position.unrealized_gain)">
              {{ formatSignedCurrency(position.unrealized_gain, currency) }}
            </span>
            <span class="pp-kpi-sub">{{ formatSignedPercent(position.unrealized_gain_pct) }}</span>
          </div>
          <div class="pp-kpi">
            <span class="pp-kpi-label">Realisiert</span>
            <span class="pp-kpi-value" :class="signClass(position.realized_gain)">
              {{ formatSignedCurrency(position.realized_gain, currency) }}
            </span>
            <span class="pp-kpi-sub">
              {{ position.sell_count }} Verkauf{{ position.sell_count === 1 ? '' : 'e' }}
              <i
                v-if="!position.realized_gain_complete"
                class="pi pi-exclamation-triangle pp-warn"
                title="Nicht jeder Kauf oder Verkauf trägt Stückzahl und Kurs — der Wert ist unvollständig"
                aria-label="Unvollständig"
              />
            </span>
          </div>
          <div class="pp-kpi">
            <span class="pp-kpi-label">Erträge</span>
            <span class="pp-kpi-value" :class="signClass(position.income)">
              {{ formatSignedCurrency(position.income, currency) }}
            </span>
            <span class="pp-kpi-sub">
              {{ position.dividend_count }} Ausschüttung{{ position.dividend_count === 1 ? '' : 'en' }}
              <template v-if="position.yield_on_cost_pct !== null"> · {{ formatPercent(position.yield_on_cost_pct, 2) }} auf Einstand</template>
            </span>
          </div>
          <div class="pp-kpi">
            <span class="pp-kpi-label">Gebühren · Steuern</span>
            <span class="pp-kpi-value">{{ formatCurrency(position.fees ?? '0', currency) }}</span>
            <span class="pp-kpi-sub">Steuern {{ formatCurrency(position.taxes ?? '0', currency) }}</span>
          </div>
          <div class="pp-kpi pp-kpi-total">
            <span class="pp-kpi-label">Gesamtrendite</span>
            <span class="pp-kpi-value" :class="signClass(position.total_return)">
              {{ formatSignedCurrency(position.total_return, currency) }}
            </span>
            <span class="pp-kpi-sub">{{ formatSignedPercent(position.total_return_pct) }} · unrealisiert + realisiert + Erträge</span>
          </div>
        </div>
      </section>

      <!-- ── Chart ────────────────────────────────────────────────── -->
      <section class="pp-section" aria-labelledby="pp-chart-heading">
        <div class="pp-section-head">
          <h2 id="pp-chart-heading">Verlauf</h2>
          <SelectButton
            v-if="hasChart"
            v-model="metric"
            :options="metricOptions"
            option-label="label"
            option-value="value"
            :allow-empty="false"
            size="small"
            aria-label="Wert oder Kurs zeigen"
          />
        </div>
        <div v-if="hasChart" class="pp-chart-wrap">
          <Chart type="line" :data="chartData ?? undefined" :options="chartOptions" class="pp-chart" />
        </div>
        <p v-else class="pp-muted">
          Der Verlauf erscheint, sobald mindestens zwei Tages-Snapshots dieses Wertpapiers vorliegen.
        </p>
      </section>

      <!-- ── Depots ───────────────────────────────────────────────── -->
      <section v-if="data.accounts.length > 0" class="pp-section" aria-labelledby="pp-accounts-heading">
        <h2 id="pp-accounts-heading">Depots</h2>
        <ScrollX>
          <table class="pp-table">
            <thead>
              <tr>
                <th>Depot</th>
                <th class="pp-col-num">Stück</th>
                <th class="pp-col-num">Wert</th>
                <th class="pp-col-num">Einstand</th>
                <th>Stand</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="a in data.accounts" :key="a.account_id">
                <td>
                  <RouterLink
                    class="pp-link"
                    :to="{ name: 'finance-account-transactions', params: { id: a.account_id } }"
                  >{{ a.account_label }}</RouterLink>
                </td>
                <td class="pp-col-num">{{ formatQuantity(a.amount) }}</td>
                <td class="pp-col-num">{{ formatCurrency(a.value, currency) }}</td>
                <td class="pp-col-num">
                  {{ formatCurrency(a.cost_basis, currency) }}
                  <span v-if="a.cost_basis_source === 'tx-wac'" class="pp-cost-source" title="Aus Käufen berechnet (gewichteter Durchschnitt)">∅</span>
                </td>
                <td class="pp-date">{{ formatIsoDate(a.as_of) }}</td>
              </tr>
            </tbody>
          </table>
        </ScrollX>
      </section>

      <!-- ── Holding gaps ─────────────────────────────────────────── -->
      <section
        v-if="data.holding_gaps.length > 0 || data.unverifiable_changes > 0"
        class="pp-section"
        aria-labelledby="pp-gaps-heading"
      >
        <h2 id="pp-gaps-heading">Bestandsabgleich</h2>
        <template v-if="data.holding_gaps.length > 0">
          <p class="pp-muted">
            Zwischen diesen Depotständen hat sich die Stückzahl geändert, ohne dass eine Transaktion das erklärt — etwa ein Depotübertrag, ein Split oder eine fehlende Abrechnung.
          </p>
          <ScrollX>
            <table class="pp-table">
              <thead>
                <tr>
                  <th>Zeitraum</th>
                  <th>Depot</th>
                  <th class="pp-col-num">Bestand</th>
                  <th class="pp-col-num">Erklärt</th>
                  <th class="pp-col-num">Offen</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="g in data.holding_gaps" :key="`${g.account_id}|${g.to}`">
                  <td class="pp-date">{{ formatIsoDate(g.from) }} – {{ formatIsoDate(g.to) }}</td>
                  <td>{{ accountLabelById.get(g.account_id) ?? `#${g.account_id}` }}</td>
                  <td class="pp-col-num">{{ formatQuantity(g.amount_before) }} → {{ formatQuantity(g.amount_after) }}</td>
                  <td class="pp-col-num">{{ formatQuantity(g.explained) }}</td>
                  <td class="pp-col-num pp-strong">{{ Number(g.unexplained) > 0 ? '+' : '' }}{{ formatQuantity(g.unexplained) }} Stk</td>
                </tr>
              </tbody>
            </table>
          </ScrollX>
        </template>
        <p v-if="data.unverifiable_changes > 0" class="pp-muted">
          {{ data.unverifiable_changes }} Bestandsänderung{{ data.unverifiable_changes === 1 ? '' : 'en' }}
          lass{{ data.unverifiable_changes === 1 ? 't' : 'en' }} sich nicht prüfen, weil einer Transaktion die Stückzahl fehlt.
        </p>
      </section>

      <!-- ── Sales ────────────────────────────────────────────────── -->
      <section v-if="data.sales.length > 0" class="pp-section" aria-labelledby="pp-sales-heading">
        <h2 id="pp-sales-heading">Verkäufe</h2>
        <p class="pp-muted">
          Jeder Verkauf gegen den gewichteten Durchschnittskurs der Käufe im selben Depot zu diesem Zeitpunkt; Erlös netto nach Gebühren und Steuern.
        </p>
        <ScrollX>
          <table class="pp-table">
            <thead>
              <tr>
                <th>Datum</th>
                <th>Depot</th>
                <th class="pp-col-num">Stück</th>
                <th class="pp-col-num">Einstand je Stück</th>
                <th class="pp-col-num">Einstand</th>
                <th class="pp-col-num">Erlös</th>
                <th class="pp-col-num">G/V</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="s in data.sales" :key="s.transaction_id">
                <td class="pp-date">{{ formatIsoDate(s.executed_at) }}</td>
                <td>{{ accountLabelById.get(s.account_id) ?? `#${s.account_id}` }}</td>
                <td class="pp-col-num">{{ formatQuantity(s.quantity) }}</td>
                <td class="pp-col-num">{{ formatCurrency(s.cost_per_unit, currency) }}</td>
                <td class="pp-col-num">{{ formatCurrency(s.cost, currency) }}</td>
                <td class="pp-col-num">{{ formatCurrency(s.proceeds, currency) }}</td>
                <td class="pp-col-num pp-strong" :class="signClass(s.gain)">{{ formatSignedCurrency(s.gain, currency) }}</td>
              </tr>
            </tbody>
          </table>
        </ScrollX>
      </section>

      <!-- ── Per year ─────────────────────────────────────────────── -->
      <section v-if="data.years.length > 0" class="pp-section" aria-labelledby="pp-years-heading">
        <h2 id="pp-years-heading">Pro Jahr</h2>
        <ScrollX>
          <table class="pp-table">
            <thead>
              <tr>
                <th>Jahr</th>
                <th class="pp-col-num">Realisiert</th>
                <th class="pp-col-num">Verkäufe</th>
                <th class="pp-col-num">Erträge</th>
                <th class="pp-col-num">Ausschüttungen</th>
                <th class="pp-col-num">Gebühren</th>
                <th class="pp-col-num">Steuern</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="y in data.years" :key="y.year">
                <td>{{ y.year }}</td>
                <td class="pp-col-num" :class="signClass(y.realized)">{{ formatSignedCurrency(y.realized, currency) }}</td>
                <td class="pp-col-num">{{ y.sell_count }}</td>
                <td class="pp-col-num" :class="signClass(y.income)">{{ formatSignedCurrency(y.income, currency) }}</td>
                <td class="pp-col-num">{{ y.dividend_count }}</td>
                <td class="pp-col-num">{{ formatCurrency(y.fees, currency) }}</td>
                <td class="pp-col-num">{{ formatCurrency(y.taxes, currency) }}</td>
              </tr>
            </tbody>
          </table>
        </ScrollX>
      </section>

      <!-- ── Transactions ─────────────────────────────────────────── -->
      <section class="pp-section" aria-labelledby="pp-tx-heading">
        <h2 id="pp-tx-heading">Transaktionen</h2>
        <EmptyState
          v-if="data.transactions.length === 0"
          icon="pi pi-list"
          title="Keine Transaktionen"
          message="Zu diesem Wertpapier liegen nur Bestandsmeldungen vor, keine Käufe, Verkäufe oder Dividenden."
        />
        <ScrollX v-else>
          <table class="pp-table">
            <thead>
              <tr>
                <th>Datum</th>
                <th>Art</th>
                <th class="pp-col-num">Stück</th>
                <th class="pp-col-num">Kurs</th>
                <th class="pp-col-num">Brutto</th>
                <th class="pp-col-num">Gebühren</th>
                <th class="pp-col-num">Steuern</th>
                <th class="pp-col-num">Betrag</th>
                <th>Depot</th>
                <th>Quelle</th>
                <th>Notiz</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="tx in data.transactions" :key="tx.id">
                <td class="pp-date">{{ formatIsoDate(tx.executed_at) }}</td>
                <td><span class="pp-kind" :class="`pp-kind-${tx.kind}`">{{ depotKindLabel(tx.kind) }}</span></td>
                <td class="pp-col-num">{{ formatQuantity(tx.amount) }}</td>
                <td class="pp-col-num">{{ formatCurrency(tx.price, tx.currency) }}</td>
                <td class="pp-col-num">{{ formatCurrency(tx.gross_amount, tx.currency) }}</td>
                <td class="pp-col-num">{{ formatCurrency(tx.fees, tx.currency) }}</td>
                <td class="pp-col-num">{{ formatCurrency(tx.tax, tx.currency) }}</td>
                <td class="pp-col-num pp-strong" :class="signClass(tx.net_amount)">{{ transactionCash(tx) }}</td>
                <td>{{ tx.account_label }}</td>
                <td class="pp-source">
                  <DepotTxSources
                    :source="tx.source"
                    :linked-transaction-id="tx.linked_transaction_id"
                    :document-ids="tx.document_ids"
                  />
                </td>
                <td class="pp-note">{{ tx.note ?? '' }}</td>
              </tr>
            </tbody>
          </table>
        </ScrollX>
      </section>
    </template>
  </PageLayout>
</template>

<style scoped>
/* Page frame and title: PageLayout (issue #1272). */
.pp-section {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.pp-section h2 {
  margin: 0;
  font-size: var(--text-xl);
  font-weight: 600;
  color: var(--p-text-color);
}
.pp-section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  flex-wrap: wrap;
}
.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}
.pp-muted {
  margin: 0;
  font-size: var(--text-sm);
  color: var(--p-text-muted-color);
}

.pp-kpis {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr));
  gap: var(--space-2);
}
.pp-kpi {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
  padding: var(--space-2) var(--space-3);
  background: var(--p-content-background);
  border: 1px solid var(--p-content-border-color);
  border-radius: 0.5rem;
  min-width: 0;
}
.pp-kpi-total {
  border-color: var(--p-primary-color);
}
.pp-kpi-label {
  font-size: var(--text-sm);
  text-transform: uppercase;
  letter-spacing: 0.02em;
  color: var(--p-text-muted-color);
}
.pp-kpi-value {
  font-size: var(--text-xl);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  overflow-wrap: anywhere;
}
.pp-kpi-sub {
  font-size: var(--text-sm);
  color: var(--p-text-muted-color);
}
.pp-warn {
  color: var(--p-yellow-500);
}

.pp-chart-wrap {
  height: 18rem;
  padding: var(--space-2);
  background: var(--p-content-background);
  border: 1px solid var(--p-content-border-color);
  border-radius: 0.5rem;
}
.pp-chart {
  height: 100%;
}

.pp-table {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--text-base);
}
.pp-table th {
  text-align: left;
  font-weight: 600;
  padding: 0.4rem 0.6rem;
  border-bottom: 2px solid var(--p-content-border-color);
  white-space: nowrap;
}
.pp-table td {
  padding: 0.4rem 0.6rem;
  border-bottom: 1px solid var(--p-content-border-color);
  vertical-align: top;
  white-space: nowrap;
}
.pp-col-num {
  text-align: right !important;
  font-variant-numeric: tabular-nums;
}
.pp-strong {
  font-weight: 600;
}
.pp-date {
  font-variant-numeric: tabular-nums;
  color: var(--p-text-muted-color);
}
.pp-note {
  white-space: normal !important;
  color: var(--p-text-muted-color);
  font-size: var(--text-sm);
  min-width: 10rem;
}
.pp-cost-source {
  margin-left: 0.2em;
  font-size: var(--text-xs);
  color: var(--p-text-muted-color);
}
.pp-link {
  color: var(--p-primary-color);
}
.pp-source {
  font-size: var(--text-sm);
  color: var(--p-text-muted-color);
}
.gain-pos {
  color: var(--p-green-600);
}
.gain-neg {
  color: var(--p-red-600);
}
.gain-flat {
  color: var(--p-text-muted-color);
}

.pp-kind {
  display: inline-block;
  padding: 0.1rem 0.45rem;
  border-radius: 999px;
  font-size: var(--text-sm);
  background: var(--p-tag-secondary-background);
  color: var(--p-tag-secondary-color);
}
.pp-kind-buy {
  background: var(--p-tag-info-background);
  color: var(--p-tag-info-color);
}
.pp-kind-sell {
  background: var(--p-tag-warn-background);
  color: var(--p-tag-warn-color);
}
.pp-kind-dividend {
  background: var(--p-tag-success-background);
  color: var(--p-tag-success-color);
}

@media (max-width: 639px) {
  .pp-table {
    font-size: var(--text-sm);
  }
  .pp-table th,
  .pp-table td {
    padding: 0.35rem 0.4rem;
  }
  .pp-chart-wrap {
    height: 14rem;
  }
}
</style>
