<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import DataTable from 'primevue/datatable'
import Column from 'primevue/column'
import Dialog from 'primevue/dialog'
import Button from 'primevue/button'
import InputText from 'primevue/inputtext'
import Select from 'primevue/select'
import Message from 'primevue/message'
import { useAccountsStore } from '../../stores/finance/accounts'
import { useAuthStore } from '../../stores/auth'

const store = useAccountsStore()
const router = useRouter()
const authStore = useAuthStore()

// "I have finance.view but the listAccounts response is empty" — that
// almost always means the user has no ACL entries yet. Distinguish from
// "still loading" / "request failed". Admins bypass the ACL on the
// backend, so they should never hit this banner — guard explicitly.
const showAclEmptyHint = computed(
  () =>
    !store.loading &&
    !store.error &&
    store.items.length === 0 &&
    !authStore.hasPermission('finance.admin'),
)

onMounted(() => {
  void store.refresh()
})

function formatIban(iban: string | null): string {
  if (!iban) return '—'
  // Compact display: first 4 + last 4
  if (iban.length <= 10) return iban
  return `${iban.slice(0, 4)} … ${iban.slice(-4)}`
}

// --- "Neues Konto"-dialog (manual account) ----------------------------
//
// A manual finance_account has no bankcontact_id. Linking to a bank
// happens later on the AccountDetailView after a sync reveals the
// bank-side account list.

const createDialogVisible = ref(false)
const createErrorMsg = ref<string | null>(null)
const creating = ref(false)
const form = ref({
  label: '',
  type_kind: 'giro',
  currency_code: 'EUR',
  account_number: '',
  iban: '',
})

const typeOptions = [
  { kind: 'giro', label: 'Girokonto' },
  { kind: 'tagesgeld', label: 'Tagesgeld' },
  { kind: 'festgeld', label: 'Festgeld' },
  { kind: 'kredit', label: 'Kredit' },
  { kind: 'depot', label: 'Depot' },
  { kind: 'bausparen', label: 'Bausparen' },
  { kind: 'kreditkarte', label: 'Kreditkarte' },
  { kind: 'bargeld', label: 'Bargeld' },
  { kind: 'sonstige', label: 'Sonstige' },
]

function openCreate() {
  form.value = {
    label: '',
    type_kind: 'giro',
    currency_code: 'EUR',
    account_number: '',
    iban: '',
  }
  createErrorMsg.value = null
  createDialogVisible.value = true
}

async function createManual() {
  creating.value = true
  createErrorMsg.value = null
  try {
    const created = await store.create({
      type_kind: form.value.type_kind,
      currency_code: form.value.currency_code.trim() || 'EUR',
      account_number: form.value.account_number.trim(),
      iban: form.value.iban.trim() || undefined,
      label: form.value.label.trim(),
    })
    createDialogVisible.value = false
    void router.push({
      name: 'finance-account-detail',
      params: { id: created.id },
    })
  } catch (err) {
    createErrorMsg.value = err instanceof Error ? err.message : String(err)
  } finally {
    creating.value = false
  }
}
</script>

<template>
  <div class="page">
    <header class="page-header">
      <h1>Konten</h1>
      <Button
        label="Neues Konto"
        icon="pi pi-plus"
        @click="openCreate"
      />
    </header>

    <Message v-if="store.error" severity="error" :closable="false">
      {{ store.error }}
    </Message>

    <Message v-if="showAclEmptyHint" severity="info" :closable="false">
      Du hast noch keine Konten freigeschaltet. Bitte wende dich an einen
      Administrator — er kann dir über „Konto-Zugriff" Lese- oder
      Schreibrechte für einzelne Konten vergeben.
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
        <template #body="{ data }">
          <span v-if="data.bankcontact_name">{{ data.bankcontact_name }}</span>
          <span v-else class="manual-hint">manuell</span>
        </template>
      </Column>
      <Column field="currency_code" header="Währung" />
      <Column header="Aktiv">
        <template #body="{ data }">
          <i v-if="data.active" class="pi pi-check text-green-500" />
          <i v-else class="pi pi-times text-gray-400" />
        </template>
      </Column>
    </DataTable>

    <Dialog
      v-model:visible="createDialogVisible"
      modal
      header="Neues Konto"
      :style="{ width: '28rem' }"
    >
      <Message v-if="createErrorMsg" severity="error" :closable="false">
        {{ createErrorMsg }}
      </Message>
      <p class="hint">
        Das Konto wird zunächst manuell angelegt. Bankzugang + Kontonummer
        bei der Bank kannst du später im Konto-Detail verknüpfen.
      </p>
      <div class="field"><label>Label</label><InputText v-model="form.label" /></div>
      <div class="field">
        <label>Kontotyp</label>
        <Select
          v-model="form.type_kind"
          :options="typeOptions"
          option-label="label"
          option-value="kind"
        />
      </div>
      <div class="field">
        <label>Währung</label>
        <InputText v-model="form.currency_code" maxlength="3" />
      </div>
      <div class="field">
        <label>Interne Kontonummer</label>
        <InputText
          v-model="form.account_number"
          placeholder="z. B. '1' für Hauptkonto"
        />
      </div>
      <div class="field"><label>IBAN (optional)</label><InputText v-model="form.iban" /></div>
      <template #footer>
        <Button
          label="Abbrechen"
          severity="secondary"
          text
          @click="createDialogVisible = false"
        />
        <Button
          label="Anlegen"
          icon="pi pi-check"
          :loading="creating"
          :disabled="!form.label.trim() || !form.account_number.trim()"
          @click="createManual"
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
/* Tight padding on narrow screens — same pattern as the photo/album
 * views, so the grid meets the viewport edges instead of wasting half
 * the screen on chrome. */
@media (max-width: 640px) {
  .page {
    padding: 0.75rem;
    gap: 0.75rem;
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
.manual-hint {
  color: var(--p-text-muted-color);
  font-style: italic;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  margin-bottom: 0.5rem;
}
.hint {
  color: var(--p-text-muted-color);
  margin: 0 0 0.75rem;
}
</style>
