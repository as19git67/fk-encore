<script setup lang="ts">
/**
 * The rows one tool returned, shown beside the assistant's answer (#1528).
 *
 * The model saw exactly these rows; the server attached them so the answer
 * can stay short. Each kind gets the row a list page of its module would
 * show, each row opens its object, and `route` opens the list page with the
 * same filters ("In der Liste öffnen").
 */
import { computed } from 'vue'
import type { ResultBlock } from '../../api/assistant'
import { getThumbUrl } from '../../api/gallery'
import Tag from 'primevue/tag'
import DocumentThumbnail from '../DocumentThumbnail.vue'
import { formatCurrency, formatIsoDate } from '../../utils/financeFormat'

const props = withDefaults(defineProps<{
  block: ResultBlock
  /** Rows shown before "… weitere"; photos show more since they are small. */
  limit?: number
}>(), { limit: 8 })

type Row = Record<string, unknown>

const TITLES: Record<string, string> = {
  accounts: 'Konten',
  transactions: 'Buchungen',
  analysis: 'Auswertung',
  debits: 'Erwartete Lastschriften',
  categories: 'Kategorien',
  documents: 'Dokumente',
  document: 'Dokument',
  photos: 'Fotos',
  recaps: 'Rückblicke',
  albums: 'Alben',
  meters: 'Zähler',
  readings: 'Zählerstände',
  consumption: 'Verbrauch',
  trip_plans: 'Reisepläne',
  positions: 'Wertpapiere',
  depot_transactions: 'Depotumsätze',
  quotes: 'Kurse',
  news: 'Nachrichten',
  comments: 'Kommentare',
  activity: 'Neuigkeiten',
  businesses: 'Betriebe',
  business_assets: 'Anlagegüter und Flächen',
  table: 'Ergebnis',
}

const KIND_LABELS: Record<string, string> = {
  buy: 'Kauf', sell: 'Verkauf', dividend: 'Dividende', in: 'Einlieferung', out: 'Auslieferung',
  split: 'Split', corp_action: 'Kapitalmaßnahme', tax: 'Steuer',
}

const ACTIVITY_LABELS: Record<string, string> = {
  photo_commented: 'Kommentar', photo_favorited: 'Favorit', photo_added: 'Fotos hinzugefügt', album_shared: 'Album geteilt', album_left: 'Album verlassen',
}

function activityLabel(v: unknown): string {
  const k = str(v)
  return ACTIVITY_LABELS[k] ?? k
}

function kindLabel(v: unknown): string {
  const k = str(v)
  return KIND_LABELS[k] ?? k
}

function withUnit(v: unknown, currency: unknown): string {
  const s = str(v)
  if (!s) return ''
  const c = str(currency)
  return c && c !== 'EUR' ? `${formatCurrency(s)} ${c}` : formatCurrency(s)
}

function sentimentClass(v: unknown): string {
  const n = Number(v)
  if (!Number.isFinite(n) || v === null) return 'amount'
  return n < -0.2 ? 'amount amount--out' : n > 0.2 ? 'amount amount--in' : 'amount'
}

const title = computed(() => TITLES[props.block.kind] ?? 'Ergebnis')
const cap = computed(() => (props.block.kind === 'photos' ? Math.max(props.limit, 12) : props.limit))
const shown = computed<Row[]>(() => props.block.rows.slice(0, cap.value))
const total = computed(() => props.block.total ?? props.block.rows.length)
const more = computed(() => Math.max(0, total.value - shown.value.length))

function str(v: unknown): string {
  return v === null || v === undefined ? '' : String(v)
}

function num(v: unknown): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

function date(v: unknown): string {
  const s = str(v)
  return s ? formatIsoDate(s.slice(0, 10)) : ''
}

const EUR = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' })
function money(v: unknown): string {
  const n = Number(v)
  return v === null || v === undefined || v === '' || !Number.isFinite(n) ? '' : EUR.format(n)
}

function amountClass(v: unknown): string {
  const n = num(v)
  return n < 0 ? 'amount amount--out' : n > 0 ? 'amount amount--in' : 'amount'
}

/** Event, photo count, and for a shared album who it is shared with. */
function albumSub(r: Row): string {
  const parts = [str(r.event_name)]
  if (r.photo_count !== undefined && r.photo_count !== null) parts.push(`${str(r.photo_count)} Fotos`)
  if (r.shared_with) parts.push(`geteilt mit ${str(r.shared_with)}`)
  else if (r.public_link === true) parts.push('öffentlicher Link')
  else if (r.shared === true) parts.push('freigegeben')
  return parts.filter(Boolean).join(' · ')
}

const BUSINESS_KINDS: Record<string, string> = { landwirtschaft: 'Landwirtschaft', photovoltaik: 'Photovoltaik', gewerbe: 'Gewerbe', vermietung: 'Vermietung' }
function businessKind(v: unknown): string {
  return BUSINESS_KINDS[str(v)] ?? str(v)
}

/** Generic rows: the scalar fields of the first row, at most four. */
const genericColumns = computed(() => {
  const first = props.block.rows[0] ?? {}
  return Object.keys(first)
    .filter((k) => k !== 'route' && ['string', 'number', 'boolean'].includes(typeof first[k]))
    .slice(0, 4)
})

/** The second scalar column names a row better than its id; fall back to the first. */
function titleOf(r: Row): string {
  const key = genericColumns.value[1] ?? genericColumns.value[0]
  return key ? str(r[key]) : ''
}

const analysis = computed(() => {
  const row = props.block.rows[0] ?? {}
  const byTag = Array.isArray(row.by_tag) ? (row.by_tag as Row[]).slice(0, 6) : []
  return { sum: row.sum, count: row.count, byTag }
})
</script>

<template>
  <section class="block" :aria-label="title">
    <header class="block-head">
      <span class="block-heading">
        <span class="block-title">{{ title }}</span>
        <span v-if="block.subtitle" class="block-subtitle">{{ block.subtitle }}</span>
      </span>
      <span v-if="block.kind !== 'analysis'" class="block-count">{{ total }}</span>
    </header>

    <!-- Accounts: as on the Übersicht page, with the latest balance -->
    <ul v-if="block.kind === 'accounts'" class="rows">
      <li v-for="r in shown" :key="str(r.id)">
        <component
          :is="r.route ? 'RouterLink' : 'div'"
          :to="r.route ? str(r.route) : undefined"
          :class="['row', { 'row--static': !r.route }]"
        >
          <span class="row-main">
            <span class="row-title">{{ str(r.label) }}</span>
            <span class="row-sub">{{ [str(r.section), str(r.type)].filter(Boolean).join(' · ') }}</span>
          </span>
          <span v-if="r.balance !== null && r.balance !== undefined" :class="amountClass(r.balance)">{{ formatCurrency(str(r.balance)) }}</span>
          <span v-else class="row-sub">kein Saldo</span>
        </component>
      </li>
    </ul>

    <!-- Bookings -->
    <ul v-else-if="block.kind === 'transactions'" class="rows">
      <li v-for="r in shown" :key="str(r.id)">
        <RouterLink class="row" :to="{ name: 'finance-transaction-detail', params: { id: str(r.id) } }">
          <span class="row-date">{{ date(r.booking_date) }}</span>
          <span class="row-main">
            <span class="row-title">{{ str(r.counterparty) || 'Ohne Gegenpartei' }}</span>
            <span v-if="r.purpose" class="row-sub">{{ str(r.purpose) }}</span>
          </span>
          <span :class="amountClass(r.amount)">{{ formatCurrency(str(r.amount)) }}</span>
        </RouterLink>
      </li>
    </ul>

    <!-- Expected debits -->
    <ul v-else-if="block.kind === 'debits'" class="rows">
      <li v-for="r in shown" :key="`${str(r.mandate_id)}-${str(r.expected_date)}`" class="row row--static">
        <span class="row-date">{{ date(r.expected_date) }}</span>
        <span class="row-main">
          <span class="row-title">{{ str(r.counterparty) || 'Unbekannter Empfänger' }}</span>
          <span class="row-sub">
            <Tag v-if="r.overdue" severity="warn" value="überfällig" class="overdue" />
            {{ str(r.account_label) }}
          </span>
        </span>
        <span :class="amountClass(r.typical_amount)">{{ formatCurrency(str(r.typical_amount)) }}</span>
      </li>
    </ul>

    <!-- Documents -->
    <ul v-else-if="block.kind === 'documents' || block.kind === 'document'" class="rows">
      <li v-for="r in shown" :key="str(r.id)">
        <RouterLink class="row" :to="{ name: 'dokumente-detail', params: { id: str(r.id) } }">
          <span class="row-thumb" aria-hidden="true"><DocumentThumbnail :id="num(r.id)" /></span>
          <span class="row-main">
            <span class="row-title">{{ str(r.title) }}</span>
            <span class="row-sub">{{ [date(r.doc_date), str(r.from)].filter(Boolean).join(' · ') }}</span>
          </span>
        </RouterLink>
      </li>
    </ul>

    <!-- Photos -->
    <ul v-else-if="block.kind === 'photos'" class="photos">
      <li v-for="r in shown" :key="str(r.id)">
        <RouterLink
          class="photo"
          :to="{ name: 'fotos-gallery', query: { photoId: str(r.id) } }"
          :aria-label="`Foto ${date(r.taken_at) || str(r.id)} öffnen`"
        >
          <img v-if="r.filename" :src="getThumbUrl(str(r.filename), 240)" alt="" loading="lazy" />
          <i v-else class="pi pi-image" aria-hidden="true" />
        </RouterLink>
      </li>
    </ul>

    <!-- Spending analysis -->
    <div v-else-if="block.kind === 'analysis'" class="analysis">
      <p class="analysis-total">
        <span :class="amountClass(analysis.sum)">{{ formatCurrency(str(analysis.sum)) }}</span>
        <span class="row-sub">aus {{ str(analysis.count) }} Buchungen</span>
      </p>
      <ul v-if="analysis.byTag.length" class="rows">
        <li v-for="t in analysis.byTag" :key="str(t.tag)" class="row row--static">
          <span class="row-main"><span class="row-title">{{ str(t.tag) }}</span></span>
          <span :class="amountClass(t.sum)">{{ formatCurrency(str(t.sum)) }}</span>
        </li>
      </ul>
    </div>

    <!-- Recaps, albums, meters: name, detail and their own page -->
    <ul v-else-if="block.kind === 'recaps' || block.kind === 'albums' || block.kind === 'meters'" class="rows">
      <li v-for="r in shown" :key="str(r.id)">
        <component
          :is="r.route ? 'RouterLink' : 'div'"
          :to="r.route ? str(r.route) : undefined"
          :class="['row', { 'row--static': !r.route }]"
        >
          <span class="row-main">
            <span class="row-title">{{ str(r.title ?? r.name) }}</span>
            <span v-if="block.kind === 'recaps'" class="row-sub">
              {{ [date(r.period_start), date(r.period_end)].filter(Boolean).join(' – ') }} · {{ str(r.photo_count) }} Fotos
            </span>
            <span v-else-if="block.kind === 'albums'" class="row-sub">
              {{ albumSub(r) }}
            </span>
            <span v-else class="row-sub">
              {{ r.last_value !== null && r.last_value !== undefined ? `${str(r.last_value)} ${str(r.unit)} am ${date(r.last_read)}` : 'Noch kein Stand' }}
            </span>
          </span>
        </component>
      </li>
    </ul>

    <!-- Businesses: name, kind, tax form and counts -->
    <ul v-else-if="block.kind === 'businesses'" class="rows">
      <li v-for="r in shown" :key="str(r.id)">
        <component :is="r.route ? 'RouterLink' : 'div'" :to="r.route ? str(r.route) : undefined" :class="['row', { 'row--static': !r.route }]">
          <span class="row-main">
            <span class="row-title">{{ str(r.name) }}</span>
            <span class="row-sub">{{ businessKind(r.kind) }} · {{ str(r.tax_section).toUpperCase() }} · {{ str(r.asset_count) }} Anlagegüter · {{ str(r.parcel_count) }} Flächen</span>
          </span>
        </component>
      </li>
    </ul>

    <!-- Assets with the year's AfA, parcels with lessee and rent -->
    <ul v-else-if="block.kind === 'business_assets'" class="rows">
      <li v-for="r in shown" :key="`${str(r.kind)}-${str(r.id)}`">
        <component :is="r.route ? 'RouterLink' : 'div'" :to="r.route ? str(r.route) : undefined" :class="['row', { 'row--static': !r.route }]">
          <span class="row-main">
            <span class="row-title">{{ str(r.name) }}</span>
            <span v-if="r.kind === 'parcel'" class="row-sub">
              {{ [str(r.usage), r.area_m2 !== null && r.area_m2 !== undefined ? `${str(r.area_m2)} m²` : '', r.lessee ? `Pächter ${str(r.lessee)}` : ''].filter(Boolean).join(' · ') }}
            </span>
            <span v-else class="row-sub">{{ str(r.kind) }} · AK {{ money(r.acquisition_cost) }} · {{ Number(r.afa_rate_pct) }} %</span>
          </span>
          <span class="row-amount">{{ r.kind === 'parcel' ? (r.annual_rent ? `${money(r.annual_rent)}/Jahr` : '') : `AfA ${money(r.afa)} · BW ${money(r.book_value)}` }}</span>
        </component>
      </li>
    </ul>

    <!-- Securities: name, holding, value and unrealized gain -->
    <ul v-else-if="block.kind === 'positions'" class="rows">
      <li v-for="r in shown" :key="str(r.key)">
        <component :is="r.route ? 'RouterLink' : 'div'" :to="r.route ? str(r.route) : undefined" :class="['row', { 'row--static': !r.route }]">
          <span class="row-main">
            <span class="row-title">{{ str(r.name) }}</span>
            <span class="row-sub">{{ [str(r.depots), str(r.isin), r.amount ? `${str(r.amount)} Stück` : '', r.open === false ? 'verkauft' : ''].filter(Boolean).join(' · ') }}</span>
          </span>
          <span class="row-figures">
            <span class="amount">{{ withUnit(r.value, r.currency) }}</span>
            <span v-if="r.unrealized_gain !== null && r.unrealized_gain !== undefined" :class="[amountClass(r.unrealized_gain), 'row-sub']">
              {{ withUnit(r.unrealized_gain, r.currency) }}{{ r.unrealized_gain_pct ? ` (${str(r.unrealized_gain_pct)} %)` : '' }}
            </span>
          </span>
        </component>
      </li>
    </ul>

    <!-- Depot transactions: date, kind and security, net amount -->
    <ul v-else-if="block.kind === 'depot_transactions'" class="rows">
      <li v-for="r in shown" :key="str(r.id)">
        <component :is="r.route ? 'RouterLink' : 'div'" :to="r.route ? str(r.route) : undefined" :class="['row', { 'row--static': !r.route }]">
          <span class="row-date">{{ date(r.executed_at) }}</span>
          <span class="row-main">
            <span class="row-title">{{ kindLabel(r.kind) }} · {{ str(r.name) }}</span>
            <span class="row-sub">{{ [str(r.account_label), r.amount ? `${str(r.amount)} Stück` : ''].filter(Boolean).join(' · ') }}</span>
          </span>
          <span :class="amountClass(r.net_amount)">{{ withUnit(r.net_amount, r.currency) }}</span>
        </component>
      </li>
    </ul>

    <!-- Quotes: last price and change -->
    <ul v-else-if="block.kind === 'quotes'" class="rows">
      <li v-for="r in shown" :key="str(r.key)">
        <component :is="r.route ? 'RouterLink' : 'div'" :to="r.route ? str(r.route) : undefined" :class="['row', { 'row--static': !r.route }]">
          <span class="row-main">
            <span class="row-title">{{ str(r.name) }}</span>
            <span class="row-sub">{{ r.status === 'ok' ? withUnit(r.value, r.currency) : (r.status === 'unresolved' ? 'keine Kursquelle' : 'noch kein Kurs') }}{{ num(r.news_unread) > 0 ? ` · ${str(r.news_unread)} neue Nachrichten` : '' }}</span>
          </span>
          <span class="row-figures">
            <span class="amount">{{ r.price !== null && r.price !== undefined ? withUnit(r.price, r.currency) : '–' }}</span>
            <span v-if="r.change_percent !== null && r.change_percent !== undefined" :class="[amountClass(r.change_percent), 'row-sub']">{{ num(r.change_percent) > 0 ? '+' : '' }}{{ str(r.change_percent) }} %</span>
          </span>
        </component>
      </li>
    </ul>

    <!-- News: title, source and date; opens the article -->
    <ul v-else-if="block.kind === 'news'" class="rows">
      <li v-for="r in shown" :key="str(r.id)">
        <a class="row" :href="str(r.url)" target="_blank" rel="noopener noreferrer">
          <span class="row-date">{{ date(r.at) }}</span>
          <span class="row-main">
            <span class="row-title">{{ str(r.title) }}</span>
            <span v-if="r.source" class="row-sub">{{ str(r.source) }}</span>
          </span>
          <i v-if="r.sentiment !== null && r.sentiment !== undefined" :class="['pi', num(r.sentiment) > 0.2 ? 'pi-arrow-up-right' : num(r.sentiment) < -0.2 ? 'pi-arrow-down-right' : 'pi-minus', sentimentClass(r.sentiment)]" aria-hidden="true" />
        </a>
      </li>
    </ul>

    <!-- Comments under a photo -->
    <ul v-else-if="block.kind === 'comments'" class="rows">
      <li v-for="r in shown" :key="str(r.id)">
        <component :is="r.route ? 'RouterLink' : 'div'" :to="r.route ? str(r.route) : undefined" :class="['row', { 'row--static': !r.route }]">
          <span class="row-date">{{ date(r.at) }}</span>
          <span class="row-main">
            <span class="row-title">{{ str(r.author) }}</span>
            <span class="row-sub row-sub--wrap">{{ str(r.body) }}</span>
          </span>
        </component>
      </li>
    </ul>

    <!-- Activity in shared albums -->
    <ul v-else-if="block.kind === 'activity'" class="rows">
      <li v-for="r in shown" :key="str(r.id)">
        <component :is="r.route ? 'RouterLink' : 'div'" :to="r.route ? str(r.route) : undefined" :class="['row', { 'row--static': !r.route, 'row--unread': r.unread === true }]">
          <span class="row-date">{{ date(r.at) }}</span>
          <span class="row-main">
            <span class="row-title">{{ str(r.actor) }} · {{ activityLabel(r.kind) }}{{ r.album ? ` · ${str(r.album)}` : '' }}</span>
            <span v-if="r.what" class="row-sub row-sub--wrap">{{ str(r.what) }}</span>
          </span>
        </component>
      </li>
    </ul>

    <!-- Trip plans -->
    <ul v-else-if="block.kind === 'trip_plans'" class="rows">
      <li v-for="r in shown" :key="str(r.id)" class="row row--static">
        <span class="row-date">{{ date(r.start_date) }}</span>
        <span class="row-main">
          <span class="row-title">{{ str(r.title) || 'Reise' }}</span>
          <span class="row-sub">{{ str(r.day_count) }} Tage</span>
        </span>
      </li>
    </ul>

    <!-- Readings and consumption -->
    <ul v-else-if="block.kind === 'readings' || block.kind === 'consumption'" class="rows">
      <li v-for="(r, i) in shown" :key="str(r.id ?? i)" class="row row--static">
        <span class="row-main"><span class="row-title">{{ block.kind === 'readings' ? date(r.taken_at) : str(r.period) }}</span></span>
        <span class="amount">{{ str(block.kind === 'readings' ? r.value : r.consumption) }}</span>
      </li>
    </ul>

    <!-- Anything else: the first scalar columns -->
    <ul v-else class="rows">
      <li v-for="(r, i) in shown" :key="str(r.id ?? i)" class="row row--static">
        <span class="row-main">
          <span class="row-title">{{ titleOf(r) }}</span>
          <span class="row-sub">{{ genericColumns.slice(2).map((c) => str(r[c])).filter(Boolean).join(' · ') }}</span>
        </span>
      </li>
    </ul>

    <footer v-if="more > 0 || block.route" class="block-foot">
      <span v-if="more > 0" class="row-sub">{{ more }} weitere</span>
      <RouterLink v-if="block.route" class="open-list" :to="block.route">
        <i class="pi pi-external-link" aria-hidden="true" />
        In der Liste öffnen
      </RouterLink>
    </footer>
  </section>
</template>

<style scoped>
.block {
  border: 1px solid var(--p-content-border-color);
  border-radius: 0.5rem;
  background: var(--p-content-background);
  min-width: 0;
  overflow: hidden;
}

.block-head,
.block-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
}

.block-head {
  border-bottom: 1px solid var(--p-content-border-color);
}

.block-foot {
  border-top: 1px solid var(--p-content-border-color);
}

.block-heading {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.block-title {
  font-weight: 600;
  font-size: var(--text-sm);
}

.block-subtitle {
  color: var(--p-text-muted-color);
  font-size: var(--text-xs);
  font-variant-numeric: tabular-nums;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.block-count {
  color: var(--p-text-muted-color);
  font-size: var(--text-sm);
  font-variant-numeric: tabular-nums;
}

.rows {
  list-style: none;
  margin: 0;
  padding: 0;
}

.row-sub--wrap {
  white-space: normal;
  overflow-wrap: anywhere;
}

.row--unread .row-title {
  font-weight: 600;
}

.row-figures {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  flex-shrink: 0;
}

.row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-2) var(--space-3);
  color: inherit;
  text-decoration: none;
  min-width: 0;
  /* Inside a rounded, clipping card: the ring is drawn inside the row. */
  outline-offset: var(--focus-ring-offset-inset);
}

a.row:hover {
  background: var(--p-content-hover-background);
}

a.row:focus-visible,
.photo:focus-visible,
.open-list:focus-visible {
  outline: var(--focus-ring);
}

.rows li + li {
  border-top: 1px solid var(--p-content-border-color);
}

.row-date {
  flex: none;
  width: 6rem;
  color: var(--p-text-muted-color);
  font-size: var(--text-sm);
  font-variant-numeric: tabular-nums;
}

.row-thumb {
  flex: none;
  width: 2.5rem;
  height: 3.25rem;
  overflow: hidden;
  border-radius: 0.25rem;
  background: var(--p-content-hover-background);
}

.row-main {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
}

.row-title,
.row-sub {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.row-sub {
  color: var(--p-text-muted-color);
  font-size: var(--text-sm);
}

.amount {
  flex: none;
  font-variant-numeric: tabular-nums;
  font-weight: 600;
  white-space: nowrap;
}

/* As in the transaction list: money out in red, money in plain. */
.amount--out {
  color: var(--p-red-600);
}

.amount--in {
  color: var(--p-text-color);
}

.overdue {
  margin-right: var(--space-1);
  padding: 0 var(--space-1);
  font-size: var(--text-xs);
}

.photos {
  list-style: none;
  margin: 0;
  padding: var(--space-2);
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(5rem, 1fr));
  gap: var(--space-1);
}

.photo {
  display: flex;
  align-items: center;
  justify-content: center;
  aspect-ratio: 1;
  overflow: hidden;
  border-radius: 0.25rem;
  background: var(--p-content-hover-background);
  color: var(--p-text-muted-color);
  outline-offset: var(--focus-ring-offset-inset);
}

.photo img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.analysis-total {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  margin: 0;
  padding: var(--space-2) var(--space-3);
  font-size: var(--text-lg);
}

.open-list {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  margin-left: auto;
  color: var(--p-primary-color);
  font-size: var(--text-sm);
  text-decoration: none;
  border-radius: 0.25rem;
  outline-offset: var(--focus-ring-offset);
}

.open-list:hover {
  text-decoration: underline;
}
</style>
