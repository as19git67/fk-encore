<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import DataTable from 'primevue/datatable'
import Column from 'primevue/column'
import Dialog from 'primevue/dialog'
import Button from 'primevue/button'
import InputText from 'primevue/inputtext'
import Select from 'primevue/select'
import ToggleSwitch from 'primevue/toggleswitch'
import DatePicker from 'primevue/datepicker'
import Message from 'primevue/message'
import PageLayout from '../../components/layout/PageLayout.vue'
import ScrollX from '../../components/layout/ScrollX.vue'
import ListToolbar from '../../components/layout/ListToolbar.vue'
import EmptyState from '../../components/layout/EmptyState.vue'
import PageSkeleton from '../../components/layout/PageSkeleton.vue'
import ErrorBanner from '../../components/layout/ErrorBanner.vue'
import { useListSearch, useListToolbar } from '../../composables/useListToolbar'
import { useAccountsStore } from '../../stores/finance/accounts'
import { useBankcontactsStore } from '../../stores/finance/bankcontacts'
import { useAuthStore } from '../../stores/auth'

const store = useAccountsStore()
const bankcontactsStore = useBankcontactsStore()
const authStore = useAuthStore()
const router = useRouter()

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
  void bankcontactsStore.refresh()
})

// ─── Shared list toolbar (#1272, stage 3) ───────────────────────────
// The store holds every account the user may see, so the search narrows
// the table in place — over the account's own name and the bank behind it.
const search = useListSearch({
  placeholder: 'Konto oder Bank suchen',
  storageKey: 'finance.accounts.search',
})

const searching = computed(() => search.term.value.trim().length > 0)

const visibleAccounts = computed(() => {
  const term = search.term.value.trim().toLowerCase()
  if (!term) return store.items
  return store.items.filter(
    (acc) =>
      acc.label.toLowerCase().includes(term) ||
      (acc.bankcontact_name ?? '').toLowerCase().includes(term),
  )
})

const toolbar = useListToolbar({
  search,
  result: {
    loaded: () => visibleAccounts.value.length,
    total: () => store.items.length,
    loading: () => store.loading,
  },
})

function formatIban(iban: string | null): string {
  if (!iban) return '—'
  // Compact display: first 4 + last 4
  if (iban.length <= 10) return iban
  return `${iban.slice(0, 4)} … ${iban.slice(-4)}`
}

const canWrite = computed(() => authStore.hasPermission('finance.accounts.manage'))

const editDialogVisible = ref(false)
const editErrorMsg = ref<string | null>(null)
const editing = ref(false)
const editId = ref<number | null>(null)
const editForm = ref({
  label: '',
  type_kind: 'giro',
  currency_code: 'EUR',
  account_number: '',
  iban: '',
  closed: false,
  closedAtDate: null as Date | null,
  bankcontact_id: null as number | null,
})

const isEditingCash = computed(() => editForm.value.type_kind === 'bargeld')

const saveDisabled = computed(
  () =>
    !editForm.value.label.trim() ||
    !editForm.value.account_number.trim() ||
    (editForm.value.closed && !editForm.value.closedAtDate),
)

function onRowClick(acc: any) {
  openEdit(acc)
}

function openEdit(acc?: any) {
  if (acc) {
    editId.value = acc.id
    editForm.value = {
      label: acc.label,
      type_kind: acc.type_kind,
      currency_code: acc.currency_code,
      account_number: acc.account_number,
      iban: acc.iban ?? '',
      closed: !!acc.closed_at,
      closedAtDate: acc.closed_at ? new Date(acc.closed_at) : null,
      bankcontact_id: acc.bankcontact_id ?? null,
    }
  } else {
    editId.value = null
    editForm.value = {
      label: '',
      type_kind: 'giro',
      currency_code: 'EUR',
      account_number: '',
      iban: '',
      closed: false,
      closedAtDate: null,
      bankcontact_id: null,
    }
  }
  editErrorMsg.value = null
  editDialogVisible.value = true
}

async function saveAccount() {
  editing.value = true
  editErrorMsg.value = null
  try {
    if (editId.value) {
      // closed_at: only patched on existing accounts. We always send a
      // value so toggling off (reopen) reaches the backend as null.
      const closedAtIso = editForm.value.closed
        ? (editForm.value.closedAtDate as Date).toISOString()
        : null
      await store.update(editId.value, {
        label: editForm.value.label.trim(),
        type_kind: editForm.value.type_kind,
        currency_code: editForm.value.currency_code.trim().toUpperCase(),
        account_number: editForm.value.account_number.trim(),
        iban: editForm.value.iban.trim() || null,
        closed_at: closedAtIso,
      })
      // Link/Unlink bankcontact if changed
      const current = store.byId(editId.value)
      if (current && editForm.value.bankcontact_id !== current.bankcontact_id) {
        if (editForm.value.bankcontact_id === null) {
          await store.unlink(editId.value)
        } else {
          await store.link(editId.value, {
            bankcontact_id: editForm.value.bankcontact_id,
            fints_account_number: editForm.value.account_number.trim(),
          })
        }
      }
    } else {
      const created = await store.create({
        label: editForm.value.label.trim(),
        type_kind: editForm.value.type_kind,
        currency_code: editForm.value.currency_code.trim().toUpperCase(),
        account_number: editForm.value.account_number.trim(),
        iban: editForm.value.iban.trim() || undefined,
      })
      if (editForm.value.bankcontact_id !== null) {
        await store.link(created.id, {
          bankcontact_id: editForm.value.bankcontact_id,
          fints_account_number: editForm.value.account_number.trim(),
        })
      }
    }
    editDialogVisible.value = false
  } catch (err) {
    editErrorMsg.value = err instanceof Error ? err.message : String(err)
  } finally {
    editing.value = false
  }
}

function goToManualBooking() {
  if (!editId.value) return
  const id = editId.value
  editDialogVisible.value = false
  void router.push({ name: 'finance-transaction-new', query: { accountId: id } })
}
</script>

<template>
  <PageLayout title="Konten" width="wide" :ready="!store.loading">
    <template #actions>
      <Button
        v-if="canWrite"
        label="Neues Konto"
        icon="pi pi-plus"
        @click="openEdit()"
      />
    </template>

    <template #toolbar>
      <ListToolbar :model="toolbar" />
    </template>

    <template #notice>
      <ErrorBanner v-if="store.error" :message="store.error" @retry="store.refresh()" />
      <Message v-if="showAclEmptyHint" severity="info" :closable="false">
        Du hast noch keine Konten freigeschaltet. Bitte wende dich an einen
        Administrator — er kann dir über „Konto-Zugriff" Lese- oder
        Schreibrechte für einzelne Konten vergeben.
      </Message>
    </template>

    <PageSkeleton v-if="store.loading && store.items.length === 0" variant="table" :count="8" />

    <EmptyState
      v-else-if="visibleAccounts.length === 0"
      icon="pi pi-wallet"
      :title="searching ? 'Keine Treffer' : 'Keine Konten'"
      :message="
        searching
          ? 'Zu diesem Suchbegriff passt kein Konto.'
          : 'Es ist noch kein Konto angelegt — erst mit einem Konto lassen sich Buchungen zuordnen.'
      "
      :filtered="searching"
      @clear-filters="search.clear()"
    />

    <ScrollX v-else>
    <DataTable
      :value="visibleAccounts"
      :loading="store.loading"
      dataKey="id"
      :rowHover="true"
      :rowClass="(data) => (data.closed_at ? 'row-closed' : '')"
      @row-click="(e) => onRowClick(e.data)"
      striped-rows
    >
      <Column field="label" header="Label">
        <template #body="{ data }">
          <span>{{ data.label }}</span>
          <span v-if="data.closed_at" class="closed-badge" title="Geschlossen">
            geschlossen
          </span>
        </template>
      </Column>
      <Column header="IBAN" class="mobile-hidden" headerClass="mobile-hidden">
        <template #body="{ data }">{{ formatIban(data.iban) }}</template>
      </Column>
      <Column field="type_label" header="Typ" />
      <Column header="Bankkontakt" class="mobile-hidden" headerClass="mobile-hidden">
        <template #body="{ data }">
          <span v-if="data.bankcontact_name">{{ data.bankcontact_name }}</span>
          <span v-else class="manual-hint">manuell</span>
        </template>
      </Column>
      <Column field="currency_code" header="Währung" class="mobile-hidden" headerClass="mobile-hidden" />
      <Column header="Status">
        <template #body="{ data }">
          <i
            v-if="data.closed_at"
            class="pi pi-lock text-orange-500"
            title="Geschlossen"
          />
          <i v-else class="pi pi-check text-green-500" title="Aktiv" />
        </template>
      </Column>
    </DataTable>
    </ScrollX>

    <Dialog
      v-model:visible="editDialogVisible"
      modal
      :header="editId ? 'Stammdaten bearbeiten' : 'Neues Konto'"
      :style="{ width: '30rem' }"
    >
      <Message v-if="editErrorMsg" severity="error" :closable="false">
        {{ editErrorMsg }}
      </Message>

      <div class="field"><label>Label</label><InputText v-model="editForm.label" /></div>
      <div class="field">
        <label>Kontotyp</label>
        <Select
          v-model="editForm.type_kind"
          :options="[
            { kind: 'giro', label: 'Girokonto' },
            { kind: 'tagesgeld', label: 'Tagesgeld' },
            { kind: 'festgeld', label: 'Festgeld' },
            { kind: 'kredit', label: 'Kredit' },
            { kind: 'depot', label: 'Depot' },
            { kind: 'bausparen', label: 'Bausparen' },
            { kind: 'kreditkarte', label: 'Kreditkarte' },
            { kind: 'bargeld', label: 'Bargeld' },
            { kind: 'sonstige', label: 'Sonstige' },
          ]"
          option-label="label"
          option-value="kind"
        />
      </div>
      <div class="field">
        <label>Währung</label>
        <InputText v-model="editForm.currency_code" maxlength="3" />
      </div>
      <div class="field">
        <label>Interne Kontonummer / Bank-Kontonummer</label>
        <InputText v-model="editForm.account_number" />
      </div>
      <div class="field"><label>IBAN</label><InputText v-model="editForm.iban" /></div>

      <div class="field">
        <label>Bankzugang</label>
        <Select
          v-model="editForm.bankcontact_id"
          :options="[
            { id: null, name: 'Kein Bankzugang (manuell)' },
            ...bankcontactsStore.items.map(bc => ({ id: bc.id, name: bc.name }))
          ]"
          option-label="name"
          option-value="id"
          placeholder="Wähle einen Bankzugang"
        />
      </div>

      <template v-if="editId">
        <div class="field field--inline">
          <label>Geschlossen</label>
          <ToggleSwitch v-model="editForm.closed" />
        </div>
        <div v-if="editForm.closed" class="field">
          <label>Schließdatum <span class="req">*</span></label>
          <DatePicker
            v-model="editForm.closedAtDate"
            date-format="dd.mm.yy"
            show-icon
            fluid
            :max-date="new Date()"
          />
          <small v-if="!editForm.closedAtDate" class="hint-error">
            Pflichtfeld, wenn das Konto geschlossen ist.
          </small>
        </div>
      </template>

      <template #footer>
        <Button
          v-if="editId && isEditingCash && !editForm.closed"
          label="Manuelle Buchung"
          icon="pi pi-plus"
          severity="secondary"
          outlined
          class="footer-leading-btn"
          @click="goToManualBooking"
        />
        <Button
          label="Abbrechen"
          severity="secondary"
          text
          @click="editDialogVisible = false"
        />
        <Button
          label="Speichern"
          icon="pi pi-check"
          :loading="editing"
          :disabled="saveDisabled"
          @click="saveAccount"
        />
      </template>
    </Dialog>
  </PageLayout>
</template>

<style scoped>
/* Page frame and title: PageLayout (issue #1272). */
.manual-hint {
  color: var(--p-text-muted-color);
  font-style: italic;
}
.closed-badge {
  display: inline-block;
  margin-left: 0.5rem;
  padding: 0.05rem 0.5rem;
  border-radius: 0.5rem;
  font-size: var(--text-xs);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  background: rgba(0, 0, 0, 0.06);
  color: var(--p-text-muted-color);
}
:deep(.row-closed) {
  opacity: 0.65;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  margin-bottom: 0.5rem;
}
.field--inline {
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
}
.req {
  color: var(--p-red-500);
}
.hint-error {
  color: var(--p-red-500);
  font-size: var(--text-base);
}
.footer-leading-btn {
  margin-right: auto;
}
</style>
