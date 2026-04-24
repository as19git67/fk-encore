<script setup lang="ts">
import { computed, onMounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import DataTable from 'primevue/datatable'
import Column from 'primevue/column'
import Button from 'primevue/button'
import Tag from 'primevue/tag'
import Message from 'primevue/message'
import { useAccountsStore } from '../../stores/finance/accounts'
import { useTransactionsStore } from '../../stores/finance/transactions'
import { useAuthStore } from '../../stores/auth'

const route = useRoute()
const router = useRouter()
const accountsStore = useAccountsStore()
const txStore = useTransactionsStore()
const authStore = useAuthStore()

const accountId = computed(() => Number(route.params.id))
const account = computed(() => accountsStore.byId(accountId.value))

const canWrite = computed(() => authStore.hasPermission('finance.admin'))

onMounted(async () => {
  if (accountsStore.items.length === 0) await accountsStore.refresh()
  await txStore.refresh({ accountId: accountId.value, limit: 50 })
})

watch(accountId, async (id) => {
  await txStore.refresh({ accountId: id, limit: 50 })
})

function formatAmount(amount: string, currency: string): string {
  const n = Number(amount)
  return new Intl.NumberFormat('de-DE', {
    style: 'currency',
    currency,
  }).format(n)
}
</script>

<template>
  <div class="page">
    <header class="page-header">
      <div>
        <h1>{{ account?.label ?? 'Konto' }}</h1>
        <p v-if="account" class="subtitle">
          {{ account.iban ?? account.account_number }} · {{ account.bankcontact_name }}
        </p>
      </div>
      <Button
        label="Zurück"
        icon="pi pi-arrow-left"
        severity="secondary"
        text
        @click="router.push({ name: 'finance-accounts' })"
      />
    </header>

    <Message v-if="txStore.error" severity="error" :closable="false">
      {{ txStore.error }}
    </Message>

    <section class="card">
      <div class="card-head">
        <h2>Umsätze</h2>
        <Button
          v-if="canWrite"
          label="Manuelle Buchung"
          icon="pi pi-plus"
          size="small"
          @click="router.push({ name: 'finance-transaction-new', query: { accountId } })"
        />
      </div>
      <DataTable
        :value="txStore.items"
        :loading="txStore.loading"
        dataKey="id"
        :rowHover="true"
        @row-click="(e) => router.push({ name: 'finance-transaction-detail', params: { id: (e.data as { id: number }).id } })"
        striped-rows
      >
        <Column field="booking_date" header="Datum" />
        <Column field="counterparty" header="Gegenseite" />
        <Column field="purpose" header="Verwendungszweck" />
        <Column header="Betrag">
          <template #body="{ data }">
            {{ account ? formatAmount(data.amount, account.currency_code) : data.amount }}
          </template>
        </Column>
        <Column header="Tags">
          <template #body="{ data }">
            <Tag
              v-for="t in data.tags"
              :key="t.name"
              :severity="t.source === 'ai' ? 'secondary' : 'info'"
              :value="t.name"
              class="tag-chip"
            />
          </template>
        </Column>
      </DataTable>
      <p class="hint">Zeige {{ txStore.items.length }} von {{ txStore.total }} Buchungen</p>
    </section>
  </div>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  padding: 1.5rem;
}
.page-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
}
.page-header h1 {
  margin: 0;
}
.subtitle {
  margin: 0.25rem 0 0;
  color: var(--p-text-muted-color);
}
.card {
  border: 1px solid var(--p-content-border-color);
  border-radius: 0.5rem;
  padding: 1rem 1.25rem;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.card-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.card-head h2 {
  margin: 0;
  font-size: 1rem;
}
.tag-chip {
  margin-right: 0.25rem;
}
.hint {
  margin: 0;
  color: var(--p-text-muted-color);
  font-size: 0.875rem;
}
</style>
