<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import Select from 'primevue/select'
import InputText from 'primevue/inputtext'
import InputNumber from 'primevue/inputnumber'
import DatePicker from 'primevue/datepicker'
import Textarea from 'primevue/textarea'
import Button from 'primevue/button'
import RadioButton from 'primevue/radiobutton'
import AutoComplete from 'primevue/autocomplete'
import Message from 'primevue/message'
import { useAccountsStore } from '../../stores/finance/accounts'
import { useTransactionsStore } from '../../stores/finance/transactions'
import { useTagsStore } from '../../stores/finance/tags'

const route = useRoute()
const router = useRouter()
const accountsStore = useAccountsStore()
const txStore = useTransactionsStore()
const tagsStore = useTagsStore()

const accountId = ref<number | null>(null)
const bookingDate = ref<Date>(new Date())
const valueDate = ref<Date | null>(null)
const amount = ref<number | null>(null)
const direction = ref<'credit' | 'debit'>('debit')
const counterparty = ref('')
const counterpartyIban = ref('')
const purpose = ref('')
const tags = ref<string[]>([])
const tagSuggestions = ref<string[]>([])
const error = ref<string | null>(null)
const saving = ref(false)

onMounted(async () => {
  if (accountsStore.items.length === 0) await accountsStore.refresh()
  if (tagsStore.items.length === 0) await tagsStore.refresh('user')
  if (route.query.accountId) {
    accountId.value = Number(route.query.accountId)
  }
})

function searchTags(event: { query: string }) {
  const q = event.query.toLowerCase()
  tagSuggestions.value = tagsStore.items
    .filter((t) => t.name.toLowerCase().includes(q))
    .map((t) => t.name)
}

function toIso(d: Date | null): string | null {
  if (!d) return null
  return d.toISOString().slice(0, 10)
}

async function save() {
  error.value = null
  if (!accountId.value || amount.value === null || !purpose.value.trim()) {
    error.value = 'Pflichtfelder fehlen: Konto, Betrag, Verwendungszweck.'
    return
  }
  const signedAmount = direction.value === 'debit' ? -Math.abs(amount.value) : Math.abs(amount.value)
  saving.value = true
  try {
    const created = await txStore.create({
      account_id: accountId.value,
      booking_date: toIso(bookingDate.value)!,
      value_date: toIso(valueDate.value),
      amount: signedAmount,
      purpose: purpose.value.trim(),
      counterparty: counterparty.value.trim() || undefined,
      counterparty_iban: counterpartyIban.value.trim() || undefined,
      tags: tags.value,
    })
    void router.push({ name: 'finance-transaction-detail', params: { id: created.id } })
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div class="page">
    <header class="page-header">
      <h1>Neue Buchung</h1>
      <Button label="Zurück" icon="pi pi-arrow-left" severity="secondary" text @click="router.back()" />
    </header>

    <Message v-if="error" severity="error" :closable="true" @close="error = null">
      {{ error }}
    </Message>

    <section class="card">
      <div class="field required">
        <label>Konto</label>
        <Select
          v-model="accountId"
          :options="accountsStore.items"
          optionLabel="label"
          optionValue="id"
          placeholder="Konto wählen …"
        />
      </div>

      <div class="row">
        <div class="field required">
          <label>Buchungsdatum</label>
          <DatePicker v-model="bookingDate" date-format="yy-mm-dd" />
        </div>
        <div class="field">
          <label>Wertstellung</label>
          <DatePicker v-model="valueDate" date-format="yy-mm-dd" show-button-bar />
        </div>
      </div>

      <div class="field required">
        <label>Betrag</label>
        <InputNumber
          v-model="amount"
          :minFractionDigits="2"
          :maxFractionDigits="2"
          mode="decimal"
          placeholder="0,00"
        />
        <div class="direction">
          <div class="direction-option">
            <RadioButton v-model="direction" inputId="dir-credit" value="credit" />
            <label for="dir-credit">Einnahme</label>
          </div>
          <div class="direction-option">
            <RadioButton v-model="direction" inputId="dir-debit" value="debit" />
            <label for="dir-debit">Ausgabe</label>
          </div>
        </div>
      </div>

      <div class="field">
        <label>Gegenseite</label>
        <InputText v-model="counterparty" />
      </div>
      <div class="field">
        <label>IBAN Gegenseite</label>
        <InputText v-model="counterpartyIban" />
      </div>
      <div class="field required">
        <label>Verwendungszweck</label>
        <Textarea v-model="purpose" rows="3" />
      </div>
      <div class="field">
        <label>Tags</label>
        <AutoComplete
          v-model="tags"
          :suggestions="tagSuggestions"
          @complete="searchTags"
          multiple
          typeahead
        />
      </div>

      <div class="actions">
        <Button label="Abbrechen" severity="secondary" @click="router.back()" />
        <Button label="Buchen" :loading="saving" @click="save" />
      </div>
    </section>
  </div>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  padding: 1.5rem;
  max-width: 40rem;
}
@media (max-width: 640px) {
  .page {
    padding: 0.75rem;
    gap: 0.75rem;
  }
  .card {
    padding: 0.75rem;
  }
}
.page-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.page-header h1 {
  margin: 0;
}
.card {
  border: 1px solid var(--p-content-border-color);
  border-radius: 0.5rem;
  padding: 1rem 1.25rem;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}
.field.required label::after {
  content: ' *';
  color: var(--p-red-500);
}
.row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 1rem;
}
.direction {
  display: flex;
  gap: 1rem;
  margin-top: 0.25rem;
}
.direction-option {
  display: flex;
  gap: 0.25rem;
  align-items: center;
}
.actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
  margin-top: 0.5rem;
}
</style>
