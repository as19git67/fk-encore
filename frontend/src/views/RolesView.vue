<script setup lang="ts">
import { ref, onMounted } from 'vue'
import DataTable from 'primevue/datatable'
import Column from 'primevue/column'
import InputText from 'primevue/inputtext'
import Button from 'primevue/button'
import Message from 'primevue/message'
import { listRoles, createRole, deleteRole } from '../api/roles'
import type { Role } from '../api/users'

const roles = ref<Role[]>([])
const loading = ref(true)
const error = ref('')

const newRoleName = ref('')
const newRoleDescription = ref('')
const creating = ref(false)

async function loadRoles() {
  loading.value = true
  try {
    const res = await listRoles()
    roles.value = res.roles
  } catch (err: any) {
    error.value = err.message || 'Fehler beim Laden'
  } finally {
    loading.value = false
  }
}

async function handleCreate() {
  if (!newRoleName.value.trim()) return
  error.value = ''
  creating.value = true
  try {
    await createRole(newRoleName.value.trim(), newRoleDescription.value.trim())
    newRoleName.value = ''
    newRoleDescription.value = ''
    await loadRoles()
  } catch (err: any) {
    error.value = err.message || 'Rolle konnte nicht erstellt werden'
  } finally {
    creating.value = false
  }
}

async function handleDelete(id: number) {
  error.value = ''
  try {
    await deleteRole(id)
    await loadRoles()
  } catch (err: any) {
    error.value = err.message || 'Rolle konnte nicht gelöscht werden'
  }
}

onMounted(loadRoles)
</script>

<template>
  <div>
    <h1>Rollen</h1>

    <Message v-if="error" severity="error" :closable="false" class="mb">{{ error }}</Message>

    <div class="create-form mb">
      <InputText v-model="newRoleName" placeholder="Rollenname" />
      <InputText v-model="newRoleDescription" placeholder="Beschreibung (optional)" />
      <Button
        label="Erstellen"
        icon="pi pi-plus"
        :loading="creating"
        :disabled="!newRoleName.trim()"
        @click="handleCreate"
      />
    </div>

    <DataTable
      :value="roles"
      :loading="loading"
      striped-rows
      paginator
      :rows="10"
      table-style="min-width: 40rem"
    >
      <Column field="id" header="ID" sortable style="width: 5rem" />
      <Column field="name" header="Name" sortable />
      <Column field="description" header="Beschreibung" />
      <Column header="Aktionen" style="width: 8rem">
        <template #body="{ data }">
          <Button
            icon="pi pi-trash"
            severity="danger"
            text
            rounded
            @click="handleDelete(data.id)"
          />
        </template>
      </Column>
    </DataTable>
  </div>
</template>

<style scoped>
.create-form {
  display: flex;
  gap: 0.5rem;
  align-items: center;
  flex-wrap: wrap;
}

.mb {
  margin-bottom: 1rem;
}
</style>

