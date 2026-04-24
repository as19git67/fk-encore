<script setup lang="ts">
import { onMounted } from 'vue'
import { useRouter } from 'vue-router'
import DataTable from 'primevue/datatable'
import Column from 'primevue/column'
import Message from 'primevue/message'
import { useAccountsStore } from '../../stores/finance/accounts'

const store = useAccountsStore()
const router = useRouter()

onMounted(() => {
  void store.refresh()
})

function formatIban(iban: string | null): string {
  if (!iban) return '—'
  // Compact display: first 4 + last 4
  if (iban.length <= 10) return iban
  return `${iban.slice(0, 4)} … ${iban.slice(-4)}`
}
</script>

<template>
  <div class="page">
    <header class="page-header">
      <h1>Konten</h1>
    </header>

    <Message v-if="store.error" severity="error" :closable="false">
      {{ store.error }}
    </Message>

    <DataTable
      :value="store.items"
      :loading="store.loading"
      dataKey="id"
      :rowHover="true"
      @row-click="(e) => router.push({ name: 'finance-account-detail', params: { id: (e.data as { id: number }).id } })"
      striped-rows
    >
      <Column field="label" header="Label" />
      <Column header="IBAN">
        <template #body="{ data }">{{ formatIban(data.iban) }}</template>
      </Column>
      <Column field="type_label" header="Typ" />
      <Column header="Bankkontakt">
        <template #body="{ data }">{{ data.bankcontact_name }}</template>
      </Column>
      <Column field="currency_code" header="Währung" />
      <Column header="Aktiv">
        <template #body="{ data }">
          <i v-if="data.active" class="pi pi-check text-green-500" />
          <i v-else class="pi pi-times text-gray-400" />
        </template>
      </Column>
    </DataTable>
  </div>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  padding: 1.5rem;
}
.page-header h1 {
  margin: 0;
}
</style>
