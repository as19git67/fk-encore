<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import DataTable from 'primevue/datatable'
import Column from 'primevue/column'
import Button from 'primevue/button'
import Dialog from 'primevue/dialog'
import InputText from 'primevue/inputtext'
import Select from 'primevue/select'
import Tag from 'primevue/tag'
import Message from 'primevue/message'
import { useAccountsStore } from '../../stores/finance/accounts'
import { useBankcontactsStore } from '../../stores/finance/bankcontacts'
import { useTransactionsStore } from '../../stores/finance/transactions'
import { useAuthStore } from '../../stores/auth'

const route = useRoute()
const router = useRouter()
const accountsStore = useAccountsStore()
const bankcontactsStore = useBankcontactsStore()
const txStore = useTransactionsStore()
const authStore = useAuthStore()

const accountId = computed(() => Number(route.params.id))
const account = computed(() => accountsStore.byId(accountId.value))

const canWrite = computed(() => authStore.hasPermission('finance.admin'))

onMounted(async () => {
  if (accountsStore.items.length === 0) await accountsStore.refresh()
  if (bankcontactsStore.items.length === 0) await bankcontactsStore.refresh()
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

// --- Link / Unlink bankcontact ----------------------------------------

const linkDialogVisible = ref(false)
const linkBcId = ref<number | null>(null)
const linkFintsNumber = ref<string>('')
const linkErrorMsg = ref<string | null>(null)
const linking = ref(false)

function openLink() {
  linkBcId.value = bankcontactsStore.items[0]?.id ?? null
  linkFintsNumber.value = account.value?.account_number ?? ''
  linkErrorMsg.value = null
  linkDialogVisible.value = true
}

async function doLink() {
  if (!account.value || linkBcId.value === null) return
  linking.value = true
  linkErrorMsg.value = null
  try {
    await accountsStore.link(account.value.id, {
      bankcontact_id: linkBcId.value,
      fints_account_number: linkFintsNumber.value.trim(),
    })
    linkDialogVisible.value = false
  } catch (err) {
    linkErrorMsg.value = err instanceof Error ? err.message : String(err)
  } finally {
    linking.value = false
  }
}

async function doUnlink() {
  if (!account.value) return
  if (
    !confirm(
      `Verknüpfung zu "${account.value.bankcontact_name}" aufheben? ` +
        `Das Konto wird wieder manuell, Transaktionen bleiben erhalten.`,
    )
  )
    return
  try {
    await accountsStore.unlink(account.value.id)
  } catch (err) {
    // Fall through to Message display via store.error; no dialog.
    alert(err instanceof Error ? err.message : String(err))
  }
}
</script>

<template>
  <div class="page">
    <header class="page-header">
      <div>
        <h1>{{ account?.label ?? 'Konto' }}</h1>
        <p v-if="account" class="subtitle">
          {{ account.iban ?? account.account_number }}
          ·
          <span v-if="account.bankcontact_name">{{ account.bankcontact_name }}</span>
          <span v-else class="manual-hint">manuell</span>
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

    <section v-if="account" class="card">
      <div class="card-head">
        <h2>Bankzugang</h2>
      </div>
      <p v-if="account.bankcontact_name" class="hint">
        Verknüpft mit <strong>{{ account.bankcontact_name }}</strong>
        (Bank-Kontonr. {{ account.fints_account_number }}). Beim nächsten
        Sync werden Umsätze und Saldo automatisch befüllt.
      </p>
      <p v-else class="hint">
        Dieses Konto ist manuell — Buchungen müssen von Hand erfasst
        werden. Verknüpfen mit einem Bankzugang ist jederzeit möglich.
      </p>
      <div class="actions">
        <Button
          v-if="canWrite && !account.bankcontact_id"
          label="Mit Bankzugang verknüpfen"
          icon="pi pi-link"
          @click="openLink"
        />
        <Button
          v-if="canWrite && account.bankcontact_id"
          label="Verknüpfung aufheben"
          icon="pi pi-unlink"
          severity="secondary"
          @click="doUnlink"
        />
      </div>
    </section>

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

    <Dialog
      v-model:visible="linkDialogVisible"
      modal
      header="Mit Bankzugang verknüpfen"
      :style="{ width: '30rem' }"
    >
      <Message v-if="linkErrorMsg" severity="error" :closable="false">
        {{ linkErrorMsg }}
      </Message>
      <p class="hint">
        Wähle einen Bankzugang und gib die Kontonummer bei der Bank ein
        (so wie sie der Bankzugang beim Sync zurückliefert).
      </p>
      <div class="field">
        <label>Bankzugang</label>
        <Select
          v-model="linkBcId"
          :options="bankcontactsStore.items"
          option-label="name"
          option-value="id"
          placeholder="Bankzugang wählen"
        />
      </div>
      <div class="field">
        <label>Kontonummer bei der Bank</label>
        <InputText
          v-model="linkFintsNumber"
          placeholder="z. B. 1234567890"
        />
      </div>
      <template #footer>
        <Button
          label="Abbrechen"
          severity="secondary"
          text
          @click="linkDialogVisible = false"
        />
        <Button
          label="Verknüpfen"
          icon="pi pi-check"
          :loading="linking"
          :disabled="linkBcId === null || !linkFintsNumber.trim()"
          @click="doLink"
        />
      </template>
    </Dialog>
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
.manual-hint {
  font-style: italic;
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
.actions {
  display: flex;
  gap: 0.5rem;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  margin-bottom: 0.5rem;
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
