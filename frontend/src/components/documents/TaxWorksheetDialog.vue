<script setup lang="ts">
/**
 * The Ausfüllhilfe for one tax year, opened from the Steuer page: per
 * Anlage the flagged documents (their values are not read yet, see
 * documentation/plans/steuer-ausfuellhilfe.md), the tax-relevant bookings
 * by tag, the businesses' EÜR, the depot's
 * figures and the hints — what the assistant's `tax_worksheet` tool reads,
 * without a chat. "Als PDF ablegen" stores it as a document linked to the
 * flagged documents, the same PDF the assistant proposes.
 */
import { ref, watch } from 'vue'
import Button from 'primevue/button'
import Dialog from 'primevue/dialog'
import Message from 'primevue/message'
import { getTaxWorksheet, storeTaxWorksheetPdf, type TaxWorksheet, type TaxWorksheetPdfResult } from '../../api/assistant'
import { formatCurrency } from '../../utils/financeFormat'

const props = defineProps<{
  visible: boolean
  year: number
  /** A household member's own Steuerakte; null for the user's own return. */
  personId: number | null
  canStore: boolean
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
        {{ worksheet.bookingCount }} steuerrelevante Buchungen. Die Werte auf den Belegen werden noch nicht
        ausgelesen: jede Zahl bitte direkt aus dem Dokument übernehmen.
      </p>

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
