<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import Select from 'primevue/select'
import Button from 'primevue/button'
import Message from 'primevue/message'
import { useAccountsStore } from '../../stores/finance/accounts'
import * as financeApi from '../../api/finance'
import * as usersApi from '../../api/users'
import type { UserWithRoles } from '../../api/users'

const accountsStore = useAccountsStore()
const selectedAccountId = ref<number | null>(null)
const entries = ref<
  Array<{ user_id: number; user_email: string; user_name: string; level: 'read' | 'write' }>
>([])
const users = ref<UserWithRoles[]>([])
const addUserId = ref<number | null>(null)
const addLevel = ref<'read' | 'write'>('read')
const loading = ref(false)
const saving = ref(false)
const diff = ref<{ inserted: number; updated: number; deleted: number } | null>(null)
const error = ref<string | null>(null)

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
  diff.value = null
  if (!id) return
  loading.value = true
  try {
    const resp = await financeApi.listAccess(id)
    entries.value = resp.items
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
  saving.value = true
  error.value = null
  try {
    const resp = await financeApi.putAccess(
      selectedAccountId.value,
      entries.value.map((e) => ({ user_id: e.user_id, level: e.level })),
    )
    entries.value = resp.items
    diff.value = resp.diff
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

    <section class="card">
      <label>
        <span>Konto wählen</span>
        <Select
          v-model="selectedAccountId"
          :options="accountsStore.items"
          optionLabel="label"
          optionValue="id"
          placeholder="Konto auswählen …"
          class="full"
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
        <Button label="Speichern" :loading="saving" @click="save" />
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
