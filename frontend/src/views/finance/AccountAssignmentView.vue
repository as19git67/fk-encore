<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import Select from 'primevue/select'
import Button from 'primevue/button'
import Message from 'primevue/message'
import { useAccountsStore } from '../../stores/finance/accounts'
import * as financeApi from '../../api/finance'
import * as usersApi from '../../api/users'
import type { UserWithRoles } from '../../api/users'

const accountsStore = useAccountsStore()
const selectedAccountId = ref<number | null>(null)

interface AccountOption {
  id: number
  label: string
  access_count: number
}

// Unassigned accounts (access_count === 0) come first so the admin
// has a visible TODO list right after a fresh Finanzkraft import.
// Within each group we keep the natural label ordering from the store.
const accountOptions = computed<AccountOption[]>(() => {
  const items = accountsStore.items.map((a) => {
    const suffix =
      a.access_count === 0
        ? ' — noch keine Zuweisung'
        : a.access_count === 1
          ? ' — 1 Person'
          : ` — ${a.access_count} Personen`
    return {
      id: a.id,
      label: `${a.label}${suffix}`,
      access_count: a.access_count,
    }
  })
  return items.sort((x, y) => {
    if ((x.access_count === 0) !== (y.access_count === 0)) {
      return x.access_count === 0 ? -1 : 1
    }
    return x.label.localeCompare(y.label, 'de')
  })
})

const unassignedCount = computed(
  () => accountsStore.items.filter((a) => a.access_count === 0).length,
)
interface Entry {
  user_id: number
  user_email: string
  user_name: string
  level: 'read' | 'write'
}
const entries = ref<Entry[]>([])
// Snapshot of the server-side state, used to compute `isDirty` so the
// Save button only lights up after a real change. Replaced on initial
// load and after every successful save.
const baseline = ref<Array<{ user_id: number; level: 'read' | 'write' }>>([])
const users = ref<UserWithRoles[]>([])
const addUserId = ref<number | null>(null)
const addLevel = ref<'read' | 'write'>('read')
const loading = ref(false)
const saving = ref(false)
const diff = ref<{ inserted: number; updated: number; deleted: number } | null>(null)
const error = ref<string | null>(null)

function snapshot(items: Entry[]): Array<{ user_id: number; level: 'read' | 'write' }> {
  return items.map((e) => ({ user_id: e.user_id, level: e.level }))
}

const isDirty = computed(() => {
  if (entries.value.length !== baseline.value.length) return true
  const baseByUser = new Map(baseline.value.map((e) => [e.user_id, e.level]))
  for (const e of entries.value) {
    const prev = baseByUser.get(e.user_id)
    if (prev === undefined || prev !== e.level) return true
  }
  return false
})

const LEVELS: Array<{ label: string; value: 'read' | 'write' }> = [
  { label: 'read', value: 'read' },
  { label: 'write', value: 'write' },
]

onMounted(async () => {
  if (accountsStore.items.length === 0) await accountsStore.refresh()
  try {
    const list = await usersApi.listUsers()
    users.value = list.users
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  }
})

watch(selectedAccountId, async (id) => {
  entries.value = []
  baseline.value = []
  diff.value = null
  if (!id) return
  loading.value = true
  try {
    const resp = await financeApi.listAccess(id)
    entries.value = resp.items
    baseline.value = snapshot(resp.items)
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    loading.value = false
  }
})

function removeEntry(userId: number) {
  entries.value = entries.value.filter((e) => e.user_id !== userId)
}

function addEntry() {
  if (addUserId.value === null) return
  if (entries.value.some((e) => e.user_id === addUserId.value)) return
  const user = users.value.find((u) => u.id === addUserId.value)
  if (!user) return
  entries.value = [
    ...entries.value,
    { user_id: user.id, user_email: user.email, user_name: user.name, level: addLevel.value },
  ]
  addUserId.value = null
  addLevel.value = 'read'
}

async function save() {
  if (!selectedAccountId.value) return
  if (!isDirty.value) return
  saving.value = true
  error.value = null
  try {
    const resp = await financeApi.putAccess(
      selectedAccountId.value,
      entries.value.map((e) => ({ user_id: e.user_id, level: e.level })),
    )
    entries.value = resp.items
    baseline.value = snapshot(resp.items)
    diff.value = resp.diff
    // Re-pull the account list so the selector's "noch keine Zuweisung"
    // tag and the unassigned counter reflect the change immediately.
    await accountsStore.refresh()
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
      <h1>Konto-Zugriff (Admin)</h1>
    </header>

    <Message v-if="error" severity="error" :closable="true" @close="error = null">
      {{ error }}
    </Message>
    <Message
      v-if="diff"
      severity="success"
      :closable="true"
      @close="diff = null"
    >
      Gespeichert: +{{ diff.inserted }} / ~{{ diff.updated }} / −{{ diff.deleted }}
    </Message>
    <Message
      v-if="unassignedCount > 0"
      severity="warn"
      :closable="false"
    >
      {{ unassignedCount }} {{ unassignedCount === 1 ? 'Konto' : 'Konten' }}
      ohne Zuweisung — für non-admin User unsichtbar, bis hier Zugriffe
      vergeben sind.
    </Message>

    <section class="card">
      <label>
        <span>Konto wählen</span>
        <Select
          v-model="selectedAccountId"
          :options="accountOptions"
          optionLabel="label"
          optionValue="id"
          placeholder="Konto auswählen …"
          class="full account-select"
          filter
        />
      </label>
    </section>

    <section v-if="selectedAccountId" class="card">
      <h2>Zugriffsberechtigte</h2>
      <p v-if="loading" class="hint">Laden …</p>
      <ul v-else class="entries">
        <li v-for="e in entries" :key="e.user_id" class="entry">
          <div>
            <strong>{{ e.user_name }}</strong>
            <span class="email">{{ e.user_email }}</span>
          </div>
          <div class="entry-actions">
            <Select
              v-model="e.level"
              :options="LEVELS"
              optionLabel="label"
              optionValue="value"
            />
            <Button
              icon="pi pi-trash"
              severity="danger"
              text
              size="small"
              @click="removeEntry(e.user_id)"
            />
          </div>
        </li>
      </ul>

      <div class="add-row">
        <Select
          v-model="addUserId"
          :options="users.filter((u) => !entries.find((e) => e.user_id === u.id))"
          optionLabel="name"
          optionValue="id"
          placeholder="User suchen …"
          class="flex-1"
          filter
        />
        <Select
          v-model="addLevel"
          :options="LEVELS"
          optionLabel="label"
          optionValue="value"
        />
        <Button icon="pi pi-plus" @click="addEntry" />
      </div>

      <div class="actions">
        <Button
          label="Speichern"
          :loading="saving"
          :disabled="!isDirty"
          @click="save"
        />
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
  max-width: 48rem;
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
.card h2 {
  margin: 0;
  font-size: 1rem;
}
.card label {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}
.full {
  width: 100%;
}
.account-select {
  min-width: 0;
}
:deep(.p-select-label) {
  text-overflow: ellipsis;
  overflow: hidden;
  white-space: nowrap;
}
:deep(.p-select-option) {
  white-space: normal;
  word-break: break-word;
}
.entries {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.entry {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0.5rem;
  border: 1px solid var(--p-content-border-color);
  border-radius: 0.25rem;
}
.entry .email {
  color: var(--p-text-muted-color);
  margin-left: 0.5rem;
  font-size: 0.875rem;
}
.entry-actions {
  display: flex;
  gap: 0.5rem;
  align-items: center;
}
.add-row {
  display: flex;
  gap: 0.5rem;
  align-items: center;
}
.flex-1 {
  flex: 1;
}
.actions {
  display: flex;
  justify-content: flex-end;
}
.hint {
  color: var(--p-text-muted-color);
  margin: 0;
}
</style>


/* Mobile-friendly Select dropdown: constrain overlay width and wrap long options */
@media (max-width: 640px) {
  .account-select {
    max-width: 100%;
  }
}
/* Truncate selected label in the closed control; wrap items in the panel */
.account-select:deep(.p-select-label) {
  text-overflow: ellipsis;
  overflow: hidden;
  white-space: nowrap;
}
.account-select:deep(.p-select-panel) {
  max-width: 95vw;
}
.account-select:deep(.p-select-option-label) {
  white-space: normal;
  word-break: break-word;
  overflow-wrap: anywhere;
}


/* Ensure all PrimeVue Select panels fit on small screens */
:deep(.p-select-panel) {
  max-width: 95vw;
}
