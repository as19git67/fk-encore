<script setup lang="ts">
/**
 * Sums of a transaction Sammelmappe: the total and, if wanted, subtotals per
 * tag or per month, quarter or year. A rule folder the assistant created
 * brings its grouping along (`rule.totals`); the choice here is the viewer's
 * and is not saved. Every number comes from the server.
 */
import { computed, ref, watch } from 'vue'
import Select from 'primevue/select'
import Message from 'primevue/message'
import { getAnyCollection } from '../../api/collections'
import {
  collectionTransactionTotals,
  type TotalsGroupBy,
  type TransactionTotals,
} from '../../api/finance'
import { formatCurrency } from '../../utils/financeFormat'

const props = defineProps<{
  collectionId: number
  /** Bumped by the list after a change to the folder, to load again. */
  refreshKey?: number
}>()

const OPTIONS: { value: TotalsGroupBy; label: string }[] = [
  { value: 'none', label: 'Keine' },
  { value: 'tag', label: 'je Tag' },
  { value: 'month', label: 'je Monat' },
  { value: 'quarter', label: 'je Quartal' },
  { value: 'year', label: 'je Jahr' },
]

const groupBy = ref<TotalsGroupBy>('none')
const groupTags = ref<string[]>([])
const totals = ref<TransactionTotals | null>(null)
const error = ref('')
const loading = ref(false)
let seq = 0

async function loadSpec() {
  try {
    const c = await getAnyCollection(props.collectionId)
    const rule = c.rule
    if (rule?.type === 'transaction' && rule.totals) {
      groupBy.value = rule.totals.group_by
      groupTags.value = rule.totals.tags ?? []
      return
    }
  } catch {
    // The sums stand without the folder's own grouping.
  }
  groupBy.value = 'none'
  groupTags.value = []
}

async function loadTotals() {
  const mine = ++seq
  loading.value = true
  error.value = ''
  try {
    const res = await collectionTransactionTotals({
      collectionId: props.collectionId,
      groupBy: groupBy.value,
      groupTags: groupBy.value === 'tag' ? groupTags.value : undefined,
    })
    if (mine === seq) totals.value = res
  } catch (err: unknown) {
    if (mine === seq) error.value = err instanceof Error ? err.message : 'Summen konnten nicht geladen werden.'
  } finally {
    if (mine === seq) loading.value = false
  }
}

watch(
  () => props.collectionId,
  async () => {
    await loadSpec()
    await loadTotals()
  },
  { immediate: true },
)
watch(() => props.refreshKey, () => void loadTotals())

function pick(value: TotalsGroupBy | null) {
  if (!value || value === groupBy.value) return
  groupBy.value = value
  void loadTotals()
}

function money(cents: number, currency: string): string {
  return formatCurrency(String(cents / 100), currency)
}

function amountClass(cents: number): string {
  return cents < 0 ? 'ctp-neg' : ''
}

const period = computed(() => {
  const t = totals.value
  if (!t?.first_date || !t.last_date) return ''
  const de = (iso: string) => iso.split('-').reverse().join('.')
  return t.first_date === t.last_date ? de(t.first_date) : `${de(t.first_date)} – ${de(t.last_date)}`
})
</script>

<template>
  <section class="ctp" aria-label="Summen der Sammelmappe" data-testid="collection-totals">
    <div class="ctp-head">
      <h2 class="ctp-title">Summen</h2>
      <label class="ctp-pick">
        <span>Zwischensummen</span>
        <Select
          :model-value="groupBy"
          :options="OPTIONS"
          option-label="label"
          option-value="value"
          size="small"
          aria-label="Zwischensummen nach"
          data-testid="collection-totals-group-by"
          @update:model-value="pick"
        />
      </label>
    </div>
    <Message v-if="error" severity="error" :closable="false">{{ error }}</Message>
    <template v-else-if="totals">
      <ul v-if="totals.group_by !== 'none' && totals.groups.length" class="ctp-rows">
        <li v-for="g in totals.groups" :key="g.key" class="ctp-row">
          <span class="ctp-label">{{ g.label }}</span>
          <span class="ctp-count">{{ g.count }}</span>
          <span class="ctp-sum" :class="amountClass(g.sum)">{{ money(g.sum, totals.currency) }}</span>
        </li>
      </ul>
      <p v-if="totals.overlapping" class="ctp-hint">
        Manche Buchungen tragen mehrere Tags und zählen in jeder ihrer Gruppen, die Zwischensummen ergeben
        zusammen also mehr als die Gesamtsumme.
      </p>
      <div class="ctp-row ctp-total" :class="{ 'ctp-busy': loading }">
        <span class="ctp-label">Gesamtsumme<span v-if="period" class="ctp-period">{{ period }}</span></span>
        <span class="ctp-count">{{ totals.count }}</span>
        <span class="ctp-sum" :class="amountClass(totals.total)">{{ money(totals.total, totals.currency) }}</span>
      </div>
      <p v-for="o in totals.other_currencies" :key="o.currency" class="ctp-hint">
        Nicht in der Summe: {{ o.count }} Buchungen in {{ o.currency }} über {{ money(o.total, o.currency) }}.
      </p>
    </template>
  </section>
</template>

<style scoped>
.ctp {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-3);
  margin-bottom: var(--space-4);
  border: 1px solid var(--p-content-border-color);
  border-radius: var(--p-content-border-radius, 6px);
  background: var(--p-content-background);
}
.ctp-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
}
.ctp-title {
  margin: 0;
  font-size: var(--text-base);
  font-weight: 600;
}
.ctp-pick {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--text-sm);
  color: var(--p-text-muted-color);
}
.ctp-rows {
  list-style: none;
  margin: 0;
  padding: 0;
}
.ctp-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  gap: var(--space-3);
  align-items: baseline;
  padding: var(--space-1) 0;
  border-bottom: 1px solid var(--p-content-border-color);
}
.ctp-label {
  overflow-wrap: anywhere;
}
.ctp-count {
  color: var(--p-text-muted-color);
  font-size: var(--text-sm);
  font-variant-numeric: tabular-nums;
}
.ctp-sum {
  font-variant-numeric: tabular-nums;
  text-align: right;
}
.ctp-total {
  border-bottom: none;
  font-weight: 600;
}
.ctp-period {
  display: block;
  font-weight: 400;
  font-size: var(--text-sm);
  color: var(--p-text-muted-color);
}
.ctp-busy {
  opacity: 0.6;
}
.ctp-neg {
  color: var(--p-red-600);
}
.ctp-hint {
  margin: 0;
  font-size: var(--text-sm);
  color: var(--p-text-muted-color);
}
</style>
