<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import Button from 'primevue/button'
import Tag from 'primevue/tag'
import Message from 'primevue/message'
import AutoComplete from 'primevue/autocomplete'
import { useTransactionsStore } from '../../stores/finance/transactions'
import { useAccountsStore } from '../../stores/finance/accounts'
import { useTagsStore } from '../../stores/finance/tags'
import type { Transaction } from '../../api/finance'
import * as api from '../../api/finance'

const route = useRoute()
const router = useRouter()
const txStore = useTransactionsStore()
const accountsStore = useAccountsStore()
const tagsStore = useTagsStore()

const tx = ref<Transaction | null>(null)
const newTag = ref<string[]>([])
const suggestions = ref<string[]>([])
const error = ref<string | null>(null)
const promoting = ref<string | null>(null)

const account = computed(() => tx.value ? accountsStore.byId(tx.value.account_id) : undefined)

onMounted(async () => {
  if (accountsStore.items.length === 0) await accountsStore.refresh()
  if (tagsStore.items.length === 0) await tagsStore.refresh('user')
  try {
    tx.value = await api.getTransaction(Number(route.params.id))
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  }
})

function userTags() {
  return tx.value?.tags.filter((t) => t.source === 'user') ?? []
}
function aiTags() {
  return tx.value?.tags.filter((t) => t.source === 'ai') ?? []
}

function searchTags(event: { query: string }) {
  const q = event.query.toLowerCase()
  suggestions.value = tagsStore.items
    .filter((t) => t.name.toLowerCase().includes(q))
    .map((t) => t.name)
}

async function addUserTags() {
  if (!tx.value || newTag.value.length === 0) return
  try {
    await api.batchTag({
      transaction_ids: [tx.value.id],
      add: newTag.value,
    })
    tx.value = await api.getTransaction(tx.value.id)
    newTag.value = []
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  }
}

async function removeUserTag(name: string) {
  if (!tx.value) return
  try {
    await api.batchTag({
      transaction_ids: [tx.value.id],
      remove: [name],
    })
    tx.value = await api.getTransaction(tx.value.id)
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  }
}

async function promote(name: string) {
  if (!tx.value) return
  promoting.value = name
  try {
    const resp = await txStore.promoteAiTag(tx.value.id, name)
    tx.value = { ...tx.value, tags: resp.tags }
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    promoting.value = null
  }
}

function formatAmount(): string {
  if (!tx.value || !account.value) return tx.value?.amount ?? ''
  return new Intl.NumberFormat('de-DE', {
    style: 'currency',
    currency: account.value.currency_code,
  }).format(Number(tx.value.amount))
}
</script>

<template>
  <div class="page">
    <header class="page-header">
      <h1>Transaktion #{{ route.params.id }}</h1>
      <Button label="Zurück" icon="pi pi-arrow-left" severity="secondary" text @click="router.back()" />
    </header>

    <Message v-if="error" severity="error" :closable="true" @close="error = null">{{ error }}</Message>

    <section v-if="tx" class="card">
      <h2>Details</h2>
      <dl class="details">
        <dt>Buchungsdatum</dt><dd>{{ tx.booking_date }}</dd>
        <dt>Wertstellung</dt><dd>{{ tx.value_date ?? '—' }}</dd>
        <dt>Konto</dt><dd>{{ account?.label }} ({{ account?.iban ?? account?.account_number }})</dd>
        <dt>Gegenseite</dt><dd>{{ tx.counterparty ?? '—' }}</dd>
        <dt>IBAN Gegenseite</dt><dd>{{ tx.counterparty_iban ?? '—' }}</dd>
        <dt>Verwendung</dt><dd class="multiline">{{ tx.purpose ?? '—' }}</dd>
        <dt>Betrag</dt><dd class="amount">{{ formatAmount() }}</dd>
      </dl>
    </section>

    <section v-if="tx" class="card">
      <h2>User-Tags</h2>
      <div class="tags-row">
        <Tag
          v-for="t in userTags()"
          :key="t.name"
          severity="info"
          class="tag-chip removable"
          :value="t.name"
        >
          <template #default>
            <span>{{ t.name }}</span>
            <i class="pi pi-times tag-remove" @click="removeUserTag(t.name)" />
          </template>
        </Tag>
      </div>
      <div class="field">
        <label>Tag hinzufügen</label>
        <AutoComplete
          v-model="newTag"
          :suggestions="suggestions"
          @complete="searchTags"
          multiple
          typeahead
        />
        <div class="actions">
          <Button label="Hinzufügen" :disabled="newTag.length === 0" @click="addUserTags" />
        </div>
      </div>
    </section>

    <section v-if="tx" class="card">
      <h2>KI-Vorschläge</h2>
      <p v-if="aiTags().length === 0" class="hint">Keine Vorschläge.</p>
      <ul v-else class="ai-list">
        <li v-for="t in aiTags()" :key="t.name" class="ai-item">
          <span class="name">{{ t.name }}</span>
          <span class="confidence">{{ t.confidence !== null ? (t.confidence * 100).toFixed(0) + '%' : '—' }}</span>
          <Button
            label="Übernehmen"
            size="small"
            :loading="promoting === t.name"
            @click="promote(t.name)"
          />
        </li>
      </ul>
    </section>
  </div>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  padding: 1.5rem;
  max-width: 48rem;
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
  gap: 0.5rem;
}
.card h2 {
  margin: 0 0 0.5rem;
  font-size: 1rem;
}
.details {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 0.5rem 1rem;
  margin: 0;
}
.details dt {
  color: var(--p-text-muted-color);
}
.details dd {
  margin: 0;
}
.amount {
  font-weight: 600;
}
.multiline {
  white-space: pre-wrap;
}
.tags-row {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
}
.tag-chip.removable :deep(.p-tag-value) {
  display: inline-flex;
  gap: 0.375rem;
  align-items: center;
}
.tag-remove {
  cursor: pointer;
  font-size: 0.75rem;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}
.actions {
  margin-top: 0.5rem;
  display: flex;
  justify-content: flex-end;
}
.ai-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}
.ai-item {
  display: grid;
  grid-template-columns: 1fr auto auto;
  gap: 0.5rem;
  align-items: center;
}
.ai-item .confidence {
  color: var(--p-text-muted-color);
  font-variant-numeric: tabular-nums;
}
.hint {
  color: var(--p-text-muted-color);
}
</style>
