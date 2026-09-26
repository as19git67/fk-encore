<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'
import Dialog from 'primevue/dialog'
import Button from 'primevue/button'
import Checkbox from 'primevue/checkbox'
import InputText from 'primevue/inputtext'
import InputNumber from 'primevue/inputnumber'
import DatePicker from 'primevue/datepicker'
import { useConfirm } from 'primevue/useconfirm'
import Select from 'primevue/select'
import Message from 'primevue/message'
import Tag from 'primevue/tag'
import ScrollX from '../../layout/ScrollX.vue'
import { ApiError } from '../../../api/client'
import {
  acceptForecastStatement,
  correctForecastStatementValues,
  decideForecastStatementLink,
  linkForecastStatementDocument,
  rejectForecastStatement,
  rereadForecastStatementLink,
  searchForecastStatementDocuments,
  setForecastDeclinedIncrease,
  setForecastStatementLinkKind,
  type ForecastDocKind,
  type ForecastDocumentCandidate,
  type ForecastItem,
  type ForecastItemStatements,
  type ForecastStatementLink,
  type ForecastStatementValues,
} from '../../../api/finance'
import { formatEur } from './forecastModel'
import { formatMonth, sourceText } from './forecastStatements'
import { parseLocalDate, toLocalIsoDate } from '../../../utils/dateFormat'

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

const KIND_OPTIONS: Array<{ value: ForecastDocKind; label: string }> = [
  { value: 'statement', label: 'Standmitteilung' },
  { value: 'dynamic_increase', label: 'Beitragserhöhung (Dynamik)' },
  { value: 'dynamic_declined', label: 'Erhöhung abgelehnt' },
  { value: 'other', label: 'Sonstiges (ohne Werte)' },
]

const setKind = (l: ForecastStatementLink, kind: ForecastDocKind) => run(() => setForecastStatementLinkKind(l.id, kind))

// ---- link a document by hand ----

const searchOpen = ref(false)
const query = ref('')
const candidates = ref<ForecastDocumentCandidate[]>([])
const searching = ref(false)
let searchTimer: ReturnType<typeof setTimeout> | null = null

const linkedIds = computed(() => new Set((props.state?.links ?? []).filter((l) => l.status !== 'rejected').map((l) => l.documentId)))
const shownCandidates = computed(() => candidates.value.filter((c) => !linkedIds.value.has(c.id)))

watch(query, (q) => {
  if (searchTimer) clearTimeout(searchTimer)
  if (q.trim().length < 2) {
    candidates.value = []
    return
  }
  searchTimer = setTimeout(async () => {
    searching.value = true
    try {
      candidates.value = (await searchForecastStatementDocuments(q)).documents
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err)
    } finally {
      searching.value = false
    }
  }, 300)
})

watch(
  () => props.visible,
  (v) => {
    if (!v) {
      searchOpen.value = false
      query.value = ''
    }
  },
)

const linkDoc = (c: ForecastDocumentCandidate) => props.item && run(() => linkForecastStatementDocument(props.item!.id, c.id))

const confirm = useConfirm()

// ---- a declined increase without a document ----

const declineOpen = ref(false)
const declineDate = ref<Date>(new Date())
const formatDay = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`
const recordDecline = () =>
  props.item &&
  run(async () => {
    await setForecastDeclinedIncrease(props.item!.id, toLocalIsoDate(declineDate.value))
    declineOpen.value = false
  })
const removeDecline = (date: string) => props.item && run(() => setForecastDeclinedIncrease(props.item!.id, date, true))

// ---- correcting what was read ----

const editing = ref(false)
const draft = ref<ForecastStatementValues | null>(null)
const EDIT_FIELDS: Array<{ key: keyof ForecastStatementValues; label: string; kind: 'amount' | 'date' }> = [
  { key: 'referenceDate', label: 'Stand', kind: 'date' },
  ...VALUE_LABELS,
]

function startEdit() {
  if (!latest.value) return
  draft.value = { ...latest.value.values }
  editing.value = true
}

function draftDate(key: keyof ForecastStatementValues): Date | null {
  const v = draft.value?.[key]
  return typeof v === 'string' ? parseLocalDate(v) : null
}

function setDraft(key: keyof ForecastStatementValues, v: number | string | null) {
  if (draft.value) draft.value = { ...draft.value, [key]: v }
}

const saveEdit = () =>
  latest.value &&
  draft.value &&
  run(async () => {
    await correctForecastStatementValues(latest.value!.id, draft.value!)
    editing.value = false
  })

/** Reading again replaces a correction: ask first. */
function rereadAsking(l: ForecastStatementLink) {
  if (latest.value?.method === 'user' && latest.value.documentId === l.documentId) {
    confirm.require({
      header: 'Neu lesen?',
      message: 'Die Werte dieser Mitteilung wurden von Hand korrigiert. Neu lesen ersetzt die Korrektur durch das, was im Dokument erkannt wird.',
      acceptLabel: 'Neu lesen',
      rejectLabel: 'Abbrechen',
      accept: () => void reread(l),
    })
  } else void reread(l)
}

watch(
  () => props.visible,
  (v) => {
    if (!v) {
      editing.value = false
      declineOpen.value = false
    }
  },
)

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
      <Message v-for="n in state.notes" :key="n" severity="info" :closable="false">{{ n }}</Message>

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
                <Select
                  :model-value="l.kind"
                  :options="KIND_OPTIONS"
                  option-label="label"
                  option-value="value"
                  size="small"
                  :disabled="busy"
                  :aria-label="`Art von ${l.title || 'Dokument'}`"
                  @update:model-value="setKind(l, $event)"
                />
                <Button icon="pi pi-refresh" size="small" text rounded :disabled="busy" aria-label="Neu lesen" v-tooltip.top="'Neu lesen'" @click="rereadAsking(l)" />
                <Button icon="pi pi-times" size="small" text rounded severity="secondary" :disabled="busy" aria-label="Zuordnung lösen" v-tooltip.top="'Zuordnung lösen'" @click="decide(l, 'rejected')" />
              </template>
            </div>
          </li>
        </ul>
        <p v-if="rejectedCount > 0" class="muted stmt__hint">{{ rejectedCount }} abgelehnte Zuordnung{{ rejectedCount === 1 ? '' : 'en' }} ausgeblendet.</p>
        <p class="muted stmt__hint">
          Die Art entscheidet, welcher Beitrag gilt: Nach einer abgelehnten Erhöhung wird der erhöhte Beitrag nicht vorgeschlagen.
        </p>

        <div class="stmt__declined">
          <ul v-if="state.declinedWithoutDocument.length" class="stmt__links">
            <li v-for="d in state.declinedWithoutDocument" :key="d" class="stmt__link">
              <div class="stmt__link-main">
                <span>Erhöhung abgelehnt (ohne Dokument)</span>
                <span class="muted">{{ formatDay(d) }}</span>
              </div>
              <Button icon="pi pi-times" size="small" text rounded severity="secondary" :disabled="busy" :aria-label="`Vermerk vom ${formatDay(d)} entfernen`" @click="removeDecline(d)" />
            </li>
          </ul>
          <div v-if="declineOpen" class="stmt__decline-form">
            <label for="stmt-decline-date" class="stmt__search-label">Abgelehnt am</label>
            <DatePicker v-model="declineDate" input-id="stmt-decline-date" date-format="dd.mm.yy" show-icon size="small" />
            <Button label="Vermerken" icon="pi pi-check" size="small" :disabled="busy || !declineDate" @click="recordDecline" />
            <Button label="Abbrechen" size="small" text severity="secondary" @click="declineOpen = false" />
          </div>
          <Button
            v-else
            label="Erhöhung ohne Dokument als abgelehnt vermerken"
            icon="pi pi-ban"
            size="small"
            text
            @click="declineOpen = true"
          />
        </div>

        <Button
          v-if="!searchOpen"
          label="Dokument von Hand zuordnen"
          icon="pi pi-link"
          size="small"
          text
          class="stmt__search-toggle"
          @click="searchOpen = true"
        />
        <div v-else class="stmt__search">
          <label for="stmt-search" class="stmt__search-label">Dokument suchen (Titel, Text oder Nummer)</label>
          <InputText id="stmt-search" v-model="query" size="small" placeholder="z. B. Dynamik oder Nachtrag" autocomplete="off" />
          <p v-if="searching" class="muted stmt__hint">Suche …</p>
          <p v-else-if="query.trim().length >= 2 && shownCandidates.length === 0" class="muted stmt__hint">Nichts gefunden.</p>
          <ul v-if="shownCandidates.length" class="stmt__links">
            <li v-for="c in shownCandidates" :key="c.id" class="stmt__link">
              <div class="stmt__link-main">
                <span>{{ c.title || `Dokument ${c.id}` }}</span>
                <span v-if="c.docDate" class="muted">{{ formatMonth(c.docDate) }}</span>
              </div>
              <Button label="Zuordnen" icon="pi pi-plus" size="small" text :disabled="busy" @click="linkDoc(c)" />
            </li>
          </ul>
        </div>
      </section>

      <section v-if="latest">
        <h3 class="stmt__title">
          Neueste Mitteilung mit Werten
          <span class="muted">· Stand {{ latest.referenceDate ? formatMonth(latest.referenceDate) : 'unbekannt' }}</span>
          <span v-if="latest.method === 'user'" class="muted"> · von Hand korrigiert</span>
        </h3>
        <div v-if="editing && draft" class="stmt__edit">
          <div v-for="f in EDIT_FIELDS" :key="f.key" class="stmt__edit-row">
            <label :for="`stmt-edit-${f.key}`">{{ f.label }}</label>
            <InputNumber
              v-if="f.kind === 'amount'"
              :input-id="`stmt-edit-${f.key}`"
              :model-value="(draft[f.key] as number | null)"
              mode="currency"
              currency="EUR"
              locale="de-DE"
              size="small"
              @update:model-value="setDraft(f.key, $event)"
            />
            <DatePicker
              v-else
              :input-id="`stmt-edit-${f.key}`"
              :model-value="draftDate(f.key)"
              date-format="dd.mm.yy"
              size="small"
              show-button-bar
              @update:model-value="setDraft(f.key, $event instanceof Date ? toLocalIsoDate($event) : null)"
            />
          </div>
          <div class="stmt__edit-actions">
            <Button label="Abbrechen" size="small" text severity="secondary" @click="editing = false" />
            <Button label="Korrektur speichern" icon="pi pi-check" size="small" :loading="busy" @click="saveEdit" />
          </div>
        </div>
        <Button v-else label="Werte korrigieren" icon="pi pi-pencil" size="small" text class="stmt__edit-toggle" @click="startEdit" />
        <dl v-if="!editing && latestValues.length" class="stmt__values">
          <template v-for="v in latestValues" :key="v.label">
            <dt>{{ v.label }}</dt>
            <dd>{{ v.text }}</dd>
          </template>
        </dl>

        <template v-if="proposals.length && !editing">
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
        <p v-else-if="!editing" class="muted">Keine Abweichungen zum Eintrag.</p>
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
        v-if="latest && proposals.length && !editing"
        label="Verwerfen"
        severity="secondary"
        text
        class="footer-leading-btn"
        :disabled="busy"
        @click="reject"
      />
      <Button label="Schließen" severity="secondary" text @click="emit('update:visible', false)" />
      <Button
        v-if="latest && proposals.length && !editing"
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
.stmt__declined {
  margin-top: var(--space-2);
}
.stmt__decline-form {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
}
.stmt__edit {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}
.stmt__edit-row {
  display: grid;
  grid-template-columns: minmax(0, 14rem) minmax(0, 1fr);
  align-items: center;
  gap: var(--space-2);
}
.stmt__edit-row :deep(.p-inputnumber),
.stmt__edit-row :deep(.p-datepicker) {
  width: 100%;
  min-width: 0;
}
.stmt__edit-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
  margin-top: var(--space-1);
}
.stmt__edit-toggle {
  margin-bottom: var(--space-1);
}
@media (max-width: 639px) {
  .stmt__edit-row {
    grid-template-columns: minmax(0, 1fr);
    gap: 0;
  }
}
.stmt__search-toggle {
  margin-top: var(--space-1);
}
.stmt__search {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  margin-top: var(--space-2);
}
.stmt__search-label {
  font-size: var(--text-sm);
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
