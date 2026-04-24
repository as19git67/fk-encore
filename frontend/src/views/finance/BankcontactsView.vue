<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import DataTable from 'primevue/datatable'
import Column from 'primevue/column'
import Button from 'primevue/button'
import Tag from 'primevue/tag'
import Message from 'primevue/message'
import { useBankcontactsStore } from '../../stores/finance/bankcontacts'
import TanDialog from '../../components/finance/TanDialog.vue'

const store = useBankcontactsStore()
const router = useRouter()

const syncingId = ref<number | null>(null)
const syncError = ref<string | null>(null)

onMounted(() => {
  void store.refresh()
})

function statusSeverity(status: string | null): 'success' | 'warn' | 'danger' | 'secondary' {
  if (!status) return 'secondary'
  if (status === 'ok') return 'success'
  if (status === 'tan-required') return 'warn'
  if (status.startsWith('error')) return 'danger'
  return 'secondary'
}

function statusLabel(status: string | null): string {
  if (!status) return '—'
  if (status === 'ok') return 'OK'
  if (status === 'tan-required') return 'TAN offen'
  if (status.startsWith('error:')) return `Fehler ${status.slice(6)}`
  return status
}

async function triggerSync(id: number) {
  syncingId.value = id
  syncError.value = null
  try {
    const resp = await store.syncNow(id)
    if (resp.state === 'error') {
      syncError.value = `${resp.errorCode}: ${resp.errorMessage}`
    }
  } catch (err) {
    syncError.value = err instanceof Error ? err.message : String(err)
  } finally {
    syncingId.value = null
  }
}

function openDetail(id: number) {
  void router.push({ name: 'finance-bankcontact-detail', params: { id } })
}
</script>

<template>
  <div class="page">
    <header class="page-header">
      <h1>Bankkontakte</h1>
      <Button
        label="Neu anlegen"
        icon="pi pi-plus"
        @click="router.push({ name: 'finance-bankcontact-new' })"
      />
    </header>

    <Message v-if="store.error" severity="error" :closable="false">
      {{ store.error }}
    </Message>
    <Message v-if="syncError" severity="error" :closable="true" @close="syncError = null">
      {{ syncError }}
    </Message>

    <DataTable
      :value="store.items"
      :loading="store.loading"
      dataKey="id"
      :rowHover="true"
      @row-click="(e) => openDetail((e.data as { id: number }).id)"
      striped-rows
    >
      <Column field="name" header="Name" />
      <Column field="blz" header="BLZ" />
      <Column field="login" header="Login" />
      <Column header="Letzter Sync">
        <template #body="{ data }">
          {{ data.last_sync_at ? new Date(data.last_sync_at).toLocaleString('de-DE') : '—' }}
        </template>
      </Column>
      <Column header="Status">
        <template #body="{ data }">
          <Tag :severity="statusSeverity(data.last_sync_status)" :value="statusLabel(data.last_sync_status)" />
        </template>
      </Column>
      <Column header="Aktionen" :style="{ width: '12rem' }">
        <template #body="{ data }">
          <Button
            icon="pi pi-refresh"
            size="small"
            severity="secondary"
            text
            :loading="syncingId === data.id"
            @click.stop="triggerSync(data.id)"
            v-tooltip="'Sync jetzt'"
          />
        </template>
      </Column>
    </DataTable>

    <TanDialog />
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
  align-items: center;
}
.page-header h1 {
  margin: 0;
}
</style>
