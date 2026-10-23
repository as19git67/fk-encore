<script setup lang="ts">
/**
 * The Ausfüllhilfe for one tax year, opened from the Steuer page: the
 * values read off the evidence by Anlage, line and Kennzahl (documentation/
 * plans/steuer-ausfuellhilfe.md, stage 3), each traceable to the documents
 * it came from and confirmable or correctable here; then per Anlage the
 * flagged documents, the tax-relevant bookings by tag, the businesses' EÜR,
 * the depot's figures and the hints — what the assistant's `tax_worksheet`
 * tool reads, without a chat. "Als PDF ablegen" stores it as a document
 * linked to the flagged documents, the same PDF the assistant proposes.
 */
import { computed, ref, watch } from 'vue'
import Button from 'primevue/button'
import Dialog from 'primevue/dialog'
import InputNumber from 'primevue/inputnumber'
import Message from 'primevue/message'
import Tag from 'primevue/tag'
import { getTaxWorksheet, storeTaxWorksheetPdf, type TaxWorksheet, type TaxWorksheetPdfResult } from '../../api/assistant'
import { confirmTaxValue, correctTaxValue } from '../../api/documents'
import { formatCurrency } from '../../utils/financeFormat'
import { eurosToCents, groupFormValues, TAX_VALUE_STATUS_LABEL, taxValueSeverity } from '../../utils/taxFormValues'

const props = defineProps<{
  visible: boolean
  year: number
  /** A household member's own Steuerakte; null for the user's own return. */
  personId: number | null
  canStore: boolean
  /** May confirm and correct the values read off the documents. */
  canEdit?: boolean
}>()
const emit = defineEmits<{ 'update:visible': [value: boolean] }>()

const worksheet = ref<TaxWorksheet | null>(null)
const loading = ref(false)
const error = ref('')
const storing = ref(false)
const stored = ref<TaxWorksheetPdfResult | null>(null)

/** The worksheet's amounts are EUR. */
function eur(n: number): string {
  return formatCurrency(n.toFixed(2))
}

/** The form values' amounts are cents. */
function cents(n: number): string {
  return formatCurrency((n / 100).toFixed(2))
}

const formGroups = computed(() => groupFormValues(worksheet.value?.form?.values ?? []))
const openValues = computed(() => (worksheet.value?.form?.values ?? []).reduce((n, v) => n + v.open, 0))

/** The evidence value being corrected, and the amount typed for it (EUR). */
const editing = ref<number | null>(null)
const editAmount = ref<number | null>(null)
const saving = ref<number | null>(null)

function startCorrect(valueId: number, valueCents: number) {
  editing.value = valueId
  editAmount.value = valueCents / 100
}

function cancelCorrect() {
  editing.value = null
  editAmount.value = null
}

/** Store the change, then read the worksheet again: the sums and notes follow from it. */
async function change(valueId: number, action: () => Promise<unknown>) {
  if (saving.value !== null) return
  saving.value = valueId
  error.value = ''
  try {
    await action()
    cancelCorrect()
    worksheet.value = await getTaxWorksheet(props.year, props.personId)
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Der Wert konnte nicht gespeichert werden'
  } finally {
    saving.value = null
  }
}

function confirmValue(valueId: number) {
  void change(valueId, () => confirmTaxValue(valueId))
}

/** The invoice was not paid in cash: the cash flag read off it becomes 0. */
function notCash(flagId: number) {
  void change(flagId, () => correctTaxValue(flagId, 0))
}

function saveCorrection(valueId: number) {
  const value = eurosToCents(editAmount.value)
  if (value === null) {
    error.value = 'Bitte einen Betrag in Euro eingeben'
    return
  }
  void change(valueId, () => correctTaxValue(valueId, value))
}

async function load() {
  loading.value = true
  error.value = ''
  stored.value = null
  try {
    worksheet.value = await getTaxWorksheet(props.year, props.personId)
  } catch (e) {
    worksheet.value = null
    error.value = e instanceof Error ? e.message : 'Die Ausfüllhilfe konnte nicht geladen werden'
  } finally {
    loading.value = false
  }
}

async function storePdf() {
  if (storing.value) return
  storing.value = true
  error.value = ''
  try {
    stored.value = await storeTaxWorksheetPdf(props.year, props.personId)
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Das PDF konnte nicht abgelegt werden'
  } finally {
    storing.value = false
  }
}

watch(() => [props.visible, props.year, props.personId] as const, ([visible]) => {
  if (visible) void load()
}, { immediate: true })
</script>

<template>
  <Dialog
    :visible="visible"
    modal
    :header="`Ausfüllhilfe Steuererklärung ${year}`"
    class="dialog-lg"
    @update:visible="emit('update:visible', $event)"
  >
    <Message v-if="error" severity="error" :closable="false">{{ error }}</Message>
    <Message v-if="stored" severity="success" :closable="false">
      Als Dokument abgelegt.
      <RouterLink :to="stored.route">Ausfüllhilfe öffnen</RouterLink>
    </Message>
    <p v-if="loading" class="hint">Wird zusammengestellt …</p>

    <template v-else-if="worksheet">
      <p class="hint">
        {{ worksheet.documentCount }} markierte Dokumente in {{ worksheet.sections.length }} Anlagen,
        {{ worksheet.bookingCount }} steuerrelevante Buchungen.
        <template v-if="worksheet.form?.values.length">
          Die Werte unten sind von den Belegen ausgelesen;
          <template v-if="openValues">{{ openValues }} davon noch ungeprüft — bitte je Wert am Dokument prüfen.</template>
          <template v-else>alle sind geprüft.</template>
        </template>
        <template v-else>Von den Belegen sind noch keine Werte ausgelesen: jede Zahl bitte direkt aus dem Dokument übernehmen.</template>
      </p>

      <section v-if="formGroups.length || worksheet.form?.previous?.missing.length" class="part">
        <h3>Werte nach Kennzahl</h3>
        <p v-if="worksheet.form && !worksheet.form.exact" class="hint">
          Für {{ worksheet.year }} gibt es noch keinen geprüften Formularkatalog: Zeilen und Kennzahlen am Vordruck
          {{ worksheet.year }} prüfen.
        </p>
        <div v-for="g in formGroups" :key="g.id" class="form-group">
          <h4>{{ g.anlage }} <span class="owner">· {{ g.owner }}</span></h4>
          <table class="sheet">
            <thead>
              <tr>
                <th class="place">Zeile · Kz</th><th>Bezeichnung</th><th class="num">Wert</th>
                <th v-if="worksheet.form?.previous" class="num prev">{{ worksheet.form.previous.year }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="v in g.values" :key="`${v.key}|${v.owner}`">
                <td class="place" :class="{ unchecked: !v.checked }">{{ v.place }}</td>
                <td>
                  {{ v.label }}
                  <Tag v-if="v.prefilled" class="chip" severity="secondary" value="vorausgefüllt" />
                  <ul class="contribs">
                    <li v-for="c in v.contributions" :key="c.value_id">
                      <div class="contrib-head">
                        <RouterLink :to="{ name: 'dokumente-detail', params: { id: String(c.document_id) } }">{{ c.document_title }}</RouterLink>
                        <span class="amount">{{ cents(c.cents) }}<template v-if="c.cents !== c.value_cents"> (Hälfte von {{ cents(c.value_cents) }})</template></span>
                        <Tag class="chip" :severity="taxValueSeverity(c.status)" :value="TAX_VALUE_STATUS_LABEL[c.status]" />
                        <template v-if="canEdit && editing !== c.value_id">
                          <Button
                            v-if="c.status === 'read'"
                            icon="pi pi-check"
                            text
                            rounded
                            size="small"
                            :loading="saving === c.value_id"
                            :aria-label="`${c.field_label} bestätigen`"
                            v-tooltip.top="'Bestätigen'"
                            @click="confirmValue(c.value_id)"
                          />
                          <Button
                            icon="pi pi-pencil"
                            text
                            rounded
                            size="small"
                            :aria-label="`${c.field_label} korrigieren`"
                            v-tooltip.top="'Korrigieren'"
                            @click="startCorrect(c.value_id, c.value_cents)"
                          />
                        </template>
                      </div>
                      <span class="sub">
                        {{ c.evidence_kind_name }}: {{ c.field_label }}<template v-if="c.page">, Seite {{ c.page }}</template>
                        <template v-if="c.quote"> — „{{ c.quote }}“</template>
                      </span>
                      <span v-if="c.note" class="sub">{{ c.note }}</span>
                      <div v-if="editing === c.value_id" class="correct">
                        <InputNumber
                          v-model="editAmount"
                          mode="currency"
                          currency="EUR"
                          locale="de-DE"
                          :min="0"
                          :input-props="{ 'aria-label': `${c.field_label} laut Beleg in Euro` }"
                          @keydown.enter="saveCorrection(c.value_id)"
                        />
                        <Button label="Abbrechen" severity="secondary" text size="small" @click="cancelCorrect" />
                        <Button label="Speichern" size="small" :loading="saving === c.value_id" @click="saveCorrection(c.value_id)" />
                      </div>
                    </li>
                  </ul>
                  <span v-if="v.form_note" class="sub">Vordruck: {{ v.form_note }}</span>
                  <span v-for="n in v.notes" :key="n" class="sub">{{ n }}</span>
                </td>
                <td class="num">{{ cents(v.cents) }}</td>
                <td v-if="worksheet.form?.previous" class="num prev">{{ v.previous_cents === null ? '–' : cents(v.previous_cents) }}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <template v-if="worksheet.form?.previous?.missing.length">
          <h4>{{ worksheet.form.previous.year }} vorhanden, {{ worksheet.year }} noch ohne Wert</h4>
          <p class="hint">Fehlt hier noch ein Beleg?</p>
          <ul class="plain">
            <li v-for="m in worksheet.form.previous.missing" :key="`${m.key}|${m.owner_label}`">
              {{ m.anlage_name }} · {{ m.owner_label }}: {{ m.place }} {{ m.label }} —
              {{ worksheet.form.previous.year }} {{ cents(m.previous_cents) }}
              <template v-for="(d, i) in m.previous_documents" :key="d.document_id">
                {{ i === 0 ? 'aus ' : ', ' }}<RouterLink :to="{ name: 'dokumente-detail', params: { id: String(d.document_id) } }">{{ d.document_title }}</RouterLink>
              </template>
            </li>
          </ul>
        </template>

        <template v-if="worksheet.form?.skipped.length">
          <h4>Nicht übernommen</h4>
          <ul class="plain">
            <li v-for="s in worksheet.form.skipped" :key="s.value_id">
              <RouterLink :to="{ name: 'dokumente-detail', params: { id: String(s.document_id) } }">{{ s.document_title }}</RouterLink>:
              {{ s.field_label }}<template v-if="s.printed"> „{{ s.printed }}“</template> — {{ s.reason }}
              <Button
                v-if="canEdit && s.cash_flag_value_id !== null"
                label="Nicht bar bezahlt"
                text
                size="small"
                :loading="saving === s.cash_flag_value_id"
                v-tooltip.top="'Überwiesen oder per Lastschrift bezahlt: der Betrag zählt'"
                @click="notCash(s.cash_flag_value_id)"
              />
              <Button
                v-if="canEdit && s.status === 'rejected' && editing !== s.value_id"
                icon="pi pi-pencil"
                text
                rounded
                size="small"
                :aria-label="`${s.field_label} korrigieren`"
                v-tooltip.top="'Wert laut Beleg eintragen'"
                @click="startCorrect(s.value_id, s.value_cents)"
              />
              <div v-if="editing === s.value_id" class="correct">
                <InputNumber
                  v-model="editAmount"
                  mode="currency"
                  currency="EUR"
                  locale="de-DE"
                  :min="0"
                  :input-props="{ 'aria-label': `${s.field_label} laut Beleg in Euro` }"
                  @keydown.enter="saveCorrection(s.value_id)"
                />
                <Button label="Abbrechen" severity="secondary" text size="small" @click="cancelCorrect" />
                <Button label="Speichern" size="small" :loading="saving === s.value_id" @click="saveCorrection(s.value_id)" />
              </div>
            </li>
          </ul>
        </template>
      </section>

      <section v-if="worksheet.sections.length" class="part">
        <h3>Anlagen</h3>
        <table class="sheet">
          <thead>
            <tr><th>Anlage</th><th class="num">Dokumente</th></tr>
          </thead>
          <tbody>
            <tr v-for="s in worksheet.sections" :key="s.slug">
              <td>
                {{ s.name }}
                <ul class="docs">
                  <li v-for="d in s.documents" :key="d.id">
                    <RouterLink :to="{ name: 'dokumente-detail', params: { id: String(d.id) } }">{{ d.title }}</RouterLink>
                    <span class="sub">{{ [d.date, d.from].filter(Boolean).join(' · ') }}</span>
                  </li>
                </ul>
              </td>
              <td class="num">{{ s.documents.length }}</td>
            </tr>
          </tbody>
        </table>
      </section>

      <section v-if="worksheet.tags.length" class="part">
        <h3>Steuerrelevante Buchungen {{ worksheet.year }} nach Tag</h3>
        <table class="sheet">
          <thead><tr><th>Tag</th><th class="num">Buchungen</th><th class="num">Summe</th></tr></thead>
          <tbody>
            <tr v-for="t in worksheet.tags" :key="t.tag">
              <td>{{ t.tag }}</td><td class="num">{{ t.count }}</td><td class="num">{{ eur(t.sum) }}</td>
            </tr>
            <tr class="total"><td>Gesamt</td><td class="num">{{ worksheet.bookingCount }}</td><td class="num">{{ eur(worksheet.bookingTotal) }}</td></tr>
          </tbody>
        </table>
      </section>

      <section v-if="worksheet.businesses.length" class="part">
        <h3>Betriebe (EÜR {{ worksheet.year }})</h3>
        <ul class="plain">
          <li v-for="b in worksheet.businesses" :key="b.id">
            <RouterLink :to="`/finanzen/betriebe/${b.id}`">{{ b.name }}</RouterLink> ({{ b.tax_section }}):
            <template v-if="b.exempt === true">steuerfrei nach § 3 Nr. 72 EStG, nur zur Information Einnahmen {{ eur(b.income) }}, Ausgaben {{ eur(b.expenses) }}</template>
            <template v-else>Einnahmen {{ eur(b.income) }}, Ausgaben {{ eur(b.expenses) }} (davon AfA {{ eur(b.afa) }}), {{ b.result >= 0 ? 'Gewinn' : 'Verlust' }} {{ eur(b.result) }}</template>
            <ul v-if="b.hints.length" class="plain sub"><li v-for="h in b.hints" :key="h">{{ h }}</li></ul>
          </li>
        </ul>
      </section>

      <section v-if="worksheet.depot" class="part">
        <h3>Depot {{ worksheet.year }} (Anlage KAP)</h3>
        <p>
          Erträge {{ formatCurrency(worksheet.depot.income) }} aus {{ worksheet.depot.dividend_count }} Zahlungen,
          realisierter Gewinn {{ formatCurrency(worksheet.depot.realized) }}<template v-if="!worksheet.depot.realized_complete"> (unvollständig)</template>
          aus {{ worksheet.depot.sell_count }} Verkäufen, einbehaltene Steuern {{ formatCurrency(worksheet.depot.taxes) }},
          Gebühren {{ formatCurrency(worksheet.depot.fees) }}.
        </p>
      </section>

      <section v-if="worksheet.hints.length" class="part">
        <h3>Hinweise</h3>
        <ul class="plain"><li v-for="h in worksheet.hints" :key="h">{{ h }}</li></ul>
      </section>

      <p v-if="!worksheet.documentCount && !worksheet.bookingCount" class="hint">
        Für {{ worksheet.year }} ist nichts markiert. Markiere zuerst Dokumente auf dieser Seite.
      </p>
    </template>

    <template #footer>
      <Button label="Schließen" severity="secondary" text @click="emit('update:visible', false)" />
      <Button
        v-if="canStore"
        label="Als PDF ablegen"
        icon="pi pi-file-pdf"
        :loading="storing"
        :disabled="loading || !worksheet || (!worksheet.documentCount && !worksheet.bookingCount) || stored !== null"
        @click="storePdf"
      />
    </template>
  </Dialog>
</template>

<style scoped>
.hint {
  margin: 0 0 var(--space-3);
  color: var(--p-text-muted-color);
  font-size: var(--text-sm);
}

.part {
  margin-bottom: var(--space-4);
}

.part h3 {
  margin: 0 0 var(--space-2);
  font-size: var(--text-base);
  font-weight: 600;
}

.sheet {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--text-sm);
}

.sheet th,
.sheet td {
  padding: var(--space-1) var(--space-2);
  border-bottom: 1px solid var(--p-content-border-color);
  text-align: left;
  vertical-align: top;
}

.sheet th {
  color: var(--p-text-muted-color);
  font-weight: 600;
}

.num {
  text-align: right;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.total td {
  font-weight: 600;
}

.form-group {
  margin-bottom: var(--space-3);
}

.form-group h4,
.part h4 {
  margin: var(--space-2) 0 var(--space-1);
  font-size: var(--text-sm);
  font-weight: 600;
}

.owner {
  color: var(--p-text-muted-color);
  font-weight: 400;
}

.place {
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}

.prev {
  color: var(--p-text-muted-color);
}

.place.unchecked {
  color: var(--p-text-muted-color);
  font-style: italic;
}

.chip {
  margin-left: var(--space-1);
  font-size: var(--text-xs);
}

.contribs {
  margin: var(--space-1) 0 0;
  padding-left: var(--space-3);
}

.contribs li {
  margin-bottom: var(--space-1);
}

.contrib-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-1);
}

.amount {
  font-variant-numeric: tabular-nums;
}

.correct {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-1);
  margin-top: var(--space-1);
}

.docs {
  margin: var(--space-1) 0 0;
  padding-left: var(--space-4);
}

.docs li {
  margin-bottom: 2px;
}

.sub {
  display: block;
  color: var(--p-text-muted-color);
  font-size: var(--text-xs);
}

.plain {
  margin: 0;
  padding-left: var(--space-4);
}

.plain.sub {
  margin-top: var(--space-1);
}
</style>
