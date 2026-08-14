<script setup lang="ts">
/**
 * Dialog to split one transaction into several parts.
 *
 * Lives on the transaction detail page: a split always concerns exactly
 * one booking, so the basket — which is about acting on many bookings at
 * once — is the wrong place for it.
 *
 * Amounts are entered as unsigned magnitudes; the sign of the source
 * transaction is applied when saving, so splitting an expense yields
 * expense parts without the user typing a single minus.
 */
import { computed, ref, watch } from 'vue'
import Button from 'primevue/button'
import Checkbox from 'primevue/checkbox'
import Dialog from 'primevue/dialog'
import InputText from 'primevue/inputtext'
import Message from 'primevue/message'
import TagAutoComplete from './TagAutoComplete.vue'
import SplitAmountInput from './SplitAmountInput.vue'
import { getTransactionSplits, setTransactionSplits, type Transaction, type TransactionSplit } from '../../api/finance'
import { useTagsStore } from '../../stores/finance/tags'
import {
  applySplitSign,
  defaultSplitMagnitudes,
  isSplitBalanced,
  splitDifference,
  splitMagnitude,
} from '../../utils/financeSplit'

const props = defineProps<{
  visible: boolean
  transaction: Transaction | null
}>()

const emit = defineEmits<{
  (e: 'update:visible', value: boolean): void
  (e: 'saved', splits: TransactionSplit[]): void
}>()

interface SplitRow {
  amount: number
  tags: string[]
  notice: string
  is_tax_relevant: boolean
}

const tagsStore = useTagsStore()
const rows = ref<SplitRow[]>([])
const loading = ref(false)
const saving = ref(false)
const loadError = ref<string | null>(null)
const saveError = ref<string | null>(null)
const editingExisting = ref(false)

const currency = computed(() => props.transaction?.currency_code ?? 'EUR')
const isExpense = computed(() => Number(props.transaction?.amount ?? 0) < 0)
const magnitudes = computed(() => rows.value.map(row => row.amount))
const difference = computed(() => splitDifference(props.transaction?.amount ?? 0, magnitudes.value))
const balanced = computed(() => isSplitBalanced(props.transaction?.amount ?? 0, magnitudes.value))

const totalLabel = computed(() => formatCurrency(Math.abs(Number(props.transaction?.amount ?? 0))))
const differenceLabel = computed(() => formatCurrency(Math.abs(difference.value)))
const differenceHint = computed(() => {
  if (balanced.value) return 'Die Teilbeträge ergeben genau den Buchungsbetrag.'
  return difference.value > 0
    ? `Noch offen: ${differenceLabel.value}`
    : `${differenceLabel.value} zu viel verteilt`
})

function formatCurrency(value: number): string {
  return new Intl.NumberFormat('de-DE', { style: 'currency', currency: currency.value }).format(value)
}

function newRow(amount = 0): SplitRow {
  return { amount, tags: [], notice: '', is_tax_relevant: false }
}

watch(() => props.visible, (open) => {
  if (open) void initialise()
})

async function initialise() {
  const tx = props.transaction
  loadError.value = null
  saveError.value = null
  editingExisting.value = false
  if (!tx) {
    rows.value = [newRow(), newRow()]
    return
  }
  if (tagsStore.items.length === 0) void tagsStore.refresh('user').catch(() => {})
  const [first, second] = defaultSplitMagnitudes(tx.amount)
  rows.value = [newRow(first), newRow(second)]

  loading.value = true
  try {
    const existing = await getTransactionSplits(tx.id)
    if (existing.items.length) {
      editingExisting.value = true
      rows.value = existing.items.map(item => ({
        amount: splitMagnitude(item.amount),
        tags: [...item.tags],
        notice: item.notice ?? '',
        is_tax_relevant: !!item.is_tax_relevant,
      }))
    }
  } catch (err) {
    loadError.value = err instanceof Error ? err.message : String(err)
  } finally {
    loading.value = false
  }
}

function addRow() {
  // Pre-fill with what is still missing so the common "split off one
  // part, keep the rest" case needs no arithmetic from the user.
  rows.value.push(newRow(Math.max(difference.value, 0)))
}

function removeRow(index: number) {
  if (rows.value.length <= 2) return
  rows.value.splice(index, 1)
}

/** Puts the remaining amount on a row, so the split adds up exactly. */
function assignRest(index: number) {
  const row = rows.value[index]
  if (!row) return
  row.amount = Math.max(0, Math.round((row.amount + difference.value) * 100) / 100)
}

async function save() {
  const tx = props.transaction
  if (!tx || !balanced.value || saving.value) return
  saving.value = true
  saveError.value = null
  const payload: TransactionSplit[] = rows.value.map(row => ({
    amount: applySplitSign(row.amount, tx.amount),
    tags: row.tags.map(tag => tag.trim()).filter(Boolean),
    notice: row.notice.trim() || null,
    is_tax_relevant: row.is_tax_relevant,
  }))
  try {
    await setTransactionSplits(tx.id, payload)
    tagsStore.addLocal(payload.flatMap(row => row.tags))
    emit('saved', payload)
    emit('update:visible', false)
  } catch (err) {
    saveError.value = err instanceof Error ? err.message : String(err)
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <Dialog
    :visible="visible"
    header="Buchung aufteilen"
    modal
    :style="{ width: 'min(46rem, calc(100vw - 2rem))' }"
    @update:visible="emit('update:visible', $event)"
  >
    <div class="split-form">
      <Message v-if="loading" severity="info" :closable="false">Vorhandene Aufteilung wird geladen…</Message>
      <Message v-if="loadError" severity="warn" :closable="false">Vorhandene Aufteilung konnte nicht geladen werden: {{ loadError }}</Message>
      <Message v-if="editingExisting" severity="info" :closable="false">Diese Buchung besitzt bereits eine Aufteilung. Speichern ersetzt sie vollständig.</Message>

      <p class="split-intro">
        Buchungsbetrag <strong>{{ totalLabel }}</strong>
        <span class="split-direction">({{ isExpense ? 'Ausgabe' : 'Einnahme' }})</span>
        <br>
        <small>Beträge ohne Vorzeichen eingeben – die Teilbeträge übernehmen automatisch die Richtung der Buchung.</small>
      </p>

      <div v-for="(row, index) in rows" :key="index" class="split-row">
        <SplitAmountInput
          v-model="row.amount"
          :currency-code="currency"
          :aria-label="`Teilbetrag ${index + 1}`"
        />
        <TagAutoComplete v-model="row.tags" placeholder="Tags" />
        <InputText v-model="row.notice" placeholder="Notiz" :aria-label="`Notiz zu Teilbetrag ${index + 1}`" />
        <label class="split-tax"><Checkbox v-model="row.is_tax_relevant" binary /> Steuerrelevant</label>
        <span class="split-row-actions">
          <Button
            v-if="!balanced"
            icon="pi pi-equals"
            text
            severity="secondary"
            v-tooltip.bottom="'Restbetrag hier eintragen'"
            :aria-label="`Restbetrag in Teilbetrag ${index + 1} eintragen`"
            @click="assignRest(index)"
          />
          <Button
            v-if="rows.length > 2"
            icon="pi pi-trash"
            text
            severity="danger"
            :aria-label="`Teilbetrag ${index + 1} entfernen`"
            @click="removeRow(index)"
          />
        </span>
      </div>

      <Button label="Teil hinzufügen" icon="pi pi-plus" text @click="addRow" />
      <Message :severity="balanced ? 'success' : 'warn'" :closable="false">{{ differenceHint }}</Message>
      <Message v-if="saveError" severity="error" :closable="false">{{ saveError }}</Message>
    </div>
    <template #footer>
      <Button label="Abbrechen" text severity="secondary" @click="emit('update:visible', false)" />
      <Button label="Speichern" icon="pi pi-check" :disabled="!balanced || !transaction" :loading="saving" @click="save" />
    </template>
  </Dialog>
</template>

<style scoped>
.split-form { display: grid; gap: .85rem; }
.split-form :deep(.p-inputtext) { width: 100%; }
.split-intro { margin: 0; }
.split-intro small { color: var(--p-text-muted-color); }
.split-direction { color: var(--p-text-muted-color); margin-left: .35rem; }
.split-row {
  display: grid;
  grid-template-columns: minmax(9rem, .8fr) minmax(9rem, 1fr) minmax(9rem, 1fr) auto auto;
  gap: .5rem;
  align-items: center;
}
.split-tax { display: flex; align-items: center; gap: .4rem; white-space: nowrap; }
.split-row-actions { display: flex; align-items: center; }
@media (max-width: 620px) {
  .split-row {
    grid-template-columns: 1fr;
    padding-bottom: .6rem;
    border-bottom: 1px solid var(--p-content-border-color);
  }
}
</style>
