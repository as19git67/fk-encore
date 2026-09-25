<script setup lang="ts">
import { computed, ref } from 'vue'
import { RouterLink } from 'vue-router'
import Dialog from 'primevue/dialog'
import Button from 'primevue/button'
import Checkbox from 'primevue/checkbox'
import Message from 'primevue/message'
import Tag from 'primevue/tag'
import ScrollX from '../../layout/ScrollX.vue'
import { ApiError } from '../../../api/client'
import {
  acceptForecastStatement,
  decideForecastStatementLink,
  rejectForecastStatement,
  rereadForecastStatementLink,
  type ForecastItem,
  type ForecastItemStatements,
  type ForecastStatementLink,
  type ForecastStatementValues,
} from '../../../api/finance'
import { formatEur } from './forecastModel'
import { formatMonth, sourceText } from './forecastStatements'

/**
 * Standmitteilungen of one forecast item (#1343): which documents belong
 * to the contract, what the newest one says and where that differs from
 * the item. Values change only when the user takes a proposal over.
 */

const props = defineProps<{
  visible: boolean
  item: ForecastItem | null
  state: ForecastItemStatements | null
}>()

const emit = defineEmits<{
  (e: 'update:visible', v: boolean): void
  (e: 'changed'): void
}>()

const busy = ref(false)
const error = ref<string | null>(null)
/** Proposal fields the user left ticked; all are ticked until touched. */
const unticked = ref<Set<string>>(new Set())

const links = computed(() => (props.state?.links ?? []).filter((l) => l.status !== 'rejected'))
const rejectedCount = computed(() => (props.state?.links ?? []).length - links.value.length)
const latest = computed(() => props.state?.latest ?? null)
const proposals = computed(() => props.state?.proposals ?? [])
const chosen = computed(() => proposals.value.filter((p) => !unticked.value.has(p.field)).map((p) => p.field))

function toggle(field: string, on: boolean) {
  const next = new Set(unticked.value)
  if (on) next.delete(field)
  else next.add(field)
  unticked.value = next
}

function show(v: number | string | null, kind: 'amount' | 'date'): string {
  if (v == null) return '–'
  if (kind === 'date') return formatMonth(String(v))
  return formatEur(Number(v), true)
}

const VALUE_LABELS: Array<{ key: keyof ForecastStatementValues; label: string; kind: 'amount' | 'date' }> = [
  { key: 'surrenderValue', label: 'Rückkaufswert', kind: 'amount' },
  { key: 'contractValue', label: 'Vertragsguthaben', kind: 'amount' },
  { key: 'guaranteedPayout', label: 'Garantierte Ablaufleistung', kind: 'amount' },
  { key: 'projectedPayout', label: 'Voraussichtliche Ablaufleistung', kind: 'amount' },
  { key: 'guaranteedMonthlyPension', label: 'Garantierte Rente pro Monat', kind: 'amount' },
  { key: 'projectedMonthlyPension', label: 'Voraussichtliche Rente pro Monat', kind: 'amount' },
  { key: 'lumpSum', label: 'Kapitalabfindung', kind: 'amount' },
  { key: 'premiumMonthly', label: 'Beitrag pro Monat', kind: 'amount' },
  { key: 'premiumYearly', label: 'Beitrag pro Jahr', kind: 'amount' },
  { key: 'premiumEndDate', label: 'Beitragszahlung bis', kind: 'date' },
  { key: 'maturityDate', label: 'Ablauf', kind: 'date' },
  { key: 'pensionStartDate', label: 'Rentenbeginn', kind: 'date' },
]

const latestValues = computed(() => {
  const v = latest.value?.values
  if (!v) return []
  return VALUE_LABELS.filter((l) => v[l.key] != null).map((l) => ({ label: l.label, text: show(v[l.key], l.kind) }))
})

const LINK_KIND: Record<ForecastStatementLink['matchKind'], string> = {
  tag: 'Vertragsnummer erkannt',
  text: 'Nummer im Text gefunden',
  user: 'von Hand zugeordnet',
}

async function run(fn: () => Promise<unknown>) {
  busy.value = true
  error.value = null
  try {
    await fn()
    unticked.value = new Set()
    emit('changed')
  } catch (err) {
    error.value = err instanceof ApiError || err instanceof Error ? err.message : String(err)
  } finally {
    busy.value = false
  }
}

const decide = (l: ForecastStatementLink, status: 'confirmed' | 'rejected') => run(() => decideForecastStatementLink(l.id, status))
const reread = (l: ForecastStatementLink) => run(() => rereadForecastStatementLink(l.id))
const accept = () => latest.value && run(() => acceptForecastStatement(latest.value!.id, chosen.value))
const reject = () => latest.value && run(() => rejectForecastStatement(latest.value!.id))
</script>

<template>
  <Dialog
    :visible="visible"
    modal
    class="dialog-lg"
    :header="item ? `Standmitteilungen · ${item.label}` : 'Standmitteilungen'"
    @update:visible="emit('update:visible', $event)"
  >
    <div v-if="state" class="stmt">
      <p class="muted stmt__meta">
        <span v-if="state.contractNo">Vertragsnummer {{ state.contractNo }}</span>
        <span>{{ sourceText(state.valuesSource) }}</span>
      </p>

      <Message v-if="error" severity="error" :closable="false">{{ error }}</Message>
      <Message v-if="state.overdue" severity="warn" :closable="false">
        Die letzte Standmitteilung ist über ein Jahr alt. Liegt eine neuere vor, erscheint sie hier, sobald sie in den Dokumenten klassifiziert ist.
      </Message>
      <Message v-if="state.reading" severity="info" :closable="false">Dokumente werden gerade gelesen …</Message>

      <section>
        <h3 class="stmt__title">Dokumente</h3>
        <p v-if="links.length === 0" class="muted">
          Noch keine Standmitteilung zu diesem Vertrag gefunden.
          <template v-if="!state.contractNo">Ohne Vertragsnummer kann nicht gesucht werden.</template>
        </p>
        <ul v-else class="stmt__links">
          <li v-for="l in links" :key="l.id" class="stmt__link">
            <div class="stmt__link-main">
              <RouterLink :to="{ name: 'dokumente-detail', params: { id: l.documentId } }">{{ l.title || `Dokument ${l.documentId}` }}</RouterLink>
              <span class="muted">
                <template v-if="l.docDate">{{ formatMonth(l.docDate) }} · </template>{{ LINK_KIND[l.matchKind] }}
              </span>
            </div>
            <div class="stmt__link-actions">
              <template v-if="l.status === 'suggested'">
                <Tag value="Vorschlag" severity="info" />
                <Button label="Gehört dazu" icon="pi pi-check" size="small" text :disabled="busy" @click="decide(l, 'confirmed')" />
                <Button label="Nicht dazu" icon="pi pi-times" size="small" text severity="secondary" :disabled="busy" @click="decide(l, 'rejected')" />
              </template>
              <template v-else>
                <Button icon="pi pi-refresh" size="small" text rounded :disabled="busy" aria-label="Neu lesen" v-tooltip.top="'Neu lesen'" @click="reread(l)" />
                <Button icon="pi pi-times" size="small" text rounded severity="secondary" :disabled="busy" aria-label="Zuordnung lösen" v-tooltip.top="'Zuordnung lösen'" @click="decide(l, 'rejected')" />
              </template>
            </div>
          </li>
        </ul>
        <p v-if="rejectedCount > 0" class="muted stmt__hint">{{ rejectedCount }} abgelehnte Zuordnung{{ rejectedCount === 1 ? '' : 'en' }} ausgeblendet.</p>
      </section>

      <section v-if="latest">
        <h3 class="stmt__title">
          Neueste Standmitteilung
          <span class="muted">· Stand {{ latest.referenceDate ? formatMonth(latest.referenceDate) : 'unbekannt' }}</span>
        </h3>
        <dl v-if="latestValues.length" class="stmt__values">
          <template v-for="v in latestValues" :key="v.label">
            <dt>{{ v.label }}</dt>
            <dd>{{ v.text }}</dd>
          </template>
        </dl>

        <template v-if="proposals.length">
          <h4 class="stmt__subtitle">Abweichungen zum Eintrag</h4>
          <ScrollX>
            <table class="stmt__table">
              <thead>
                <tr>
                  <th scope="col"><span class="sr-only">Übernehmen</span></th>
                  <th scope="col">Feld</th>
                  <th scope="col" class="num">Im Eintrag</th>
                  <th scope="col" class="num">Laut Standmitteilung</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="p in proposals" :key="p.field">
                  <td>
                    <Checkbox
                      :model-value="!unticked.has(p.field)"
                      binary
                      :input-id="`stmt-${p.field}`"
                      @update:model-value="toggle(p.field, $event)"
                    />
                  </td>
                  <td><label :for="`stmt-${p.field}`">{{ p.label }}</label></td>
                  <td class="num muted">{{ show(p.current, p.kind) }}</td>
                  <td class="num">{{ show(p.proposed, p.kind) }}</td>
                </tr>
              </tbody>
            </table>
          </ScrollX>
        </template>
        <p v-else-if="latest.status === 'accepted' || latest.status === 'no_change'" class="muted">Der Eintrag stimmt mit dieser Standmitteilung überein.</p>
      </section>

      <section v-if="state.history.length">
        <h3 class="stmt__title">Übernommen</h3>
        <ul class="stmt__history">
          <li v-for="h in state.history" :key="h.id">
            Stand {{ h.referenceDate ? formatMonth(h.referenceDate) : 'unbekannt' }}
            <span class="muted">· gelesen per {{ h.method === 'llm' ? 'KI' : 'Textmuster' }}</span>
          </li>
        </ul>
      </section>
    </div>

    <template #footer>
      <Button
        v-if="latest && proposals.length"
        label="Verwerfen"
        severity="secondary"
        text
        class="footer-leading-btn"
        :disabled="busy"
        @click="reject"
      />
      <Button label="Schließen" severity="secondary" text @click="emit('update:visible', false)" />
      <Button
        v-if="latest && proposals.length"
        :label="chosen.length === proposals.length ? 'Alle übernehmen' : `${chosen.length} übernehmen`"
        icon="pi pi-check"
        :loading="busy"
        :disabled="chosen.length === 0"
        @click="accept"
      />
    </template>
  </Dialog>
</template>

<style scoped>
.stmt {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}
.stmt__meta {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1) var(--space-3);
  margin: 0;
}
.stmt__title {
  font-size: var(--text-base);
  margin: 0 0 var(--space-2);
}
.stmt__subtitle {
  font-size: var(--text-sm);
  margin: var(--space-3) 0 var(--space-1);
}
.stmt__links,
.stmt__history {
  list-style: none;
  margin: 0;
  padding: 0;
}
.stmt__link {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  align-items: center;
  gap: var(--space-1) var(--space-2);
  padding: var(--space-1) 0;
  border-bottom: 1px solid var(--p-content-border-color);
}
.stmt__link-main {
  display: flex;
  flex-direction: column;
  min-width: 0;
  overflow-wrap: anywhere;
}
.stmt__link-actions {
  display: flex;
  align-items: center;
  gap: var(--space-1);
}
.stmt__hint {
  font-size: var(--text-sm);
  margin: var(--space-1) 0 0;
}
.stmt__values {
  display: grid;
  grid-template-columns: minmax(0, max-content) minmax(0, 1fr);
  gap: var(--space-1) var(--space-3);
  margin: 0;
}
.stmt__values dt {
  color: var(--p-text-muted-color);
}
.stmt__values dd {
  margin: 0;
  font-variant-numeric: tabular-nums;
}
.stmt__table {
  border-collapse: collapse;
  width: 100%;
}
.stmt__table th,
.stmt__table td {
  text-align: left;
  padding: var(--space-1) var(--space-2);
  border-bottom: 1px solid var(--p-content-border-color);
  white-space: nowrap;
}
.stmt__table th {
  font-weight: 600;
  font-size: var(--text-sm);
}
.num {
  text-align: right !important;
  font-variant-numeric: tabular-nums;
}
.muted {
  color: var(--p-text-muted-color);
}
.footer-leading-btn {
  margin-right: auto;
}
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}
</style>
