<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import DataTable from 'primevue/datatable'
import Column from 'primevue/column'
import InputText from 'primevue/inputtext'
import Button from 'primevue/button'
import Chip from 'primevue/chip'
import Dialog from 'primevue/dialog'
import Checkbox from 'primevue/checkbox'
import Message from 'primevue/message'
import {
  listRoles,
  createRole,
  deleteRole,
  listPermissions,
  assignPermission,
  revokePermission,
  type RoleWithPermissions,
  type Permission,
} from '../api/roles'
import { useAuthStore } from '../stores/auth'

const auth = useAuthStore()
const roles = ref<RoleWithPermissions[]>([])
const allPermissions = ref<Permission[]>([])
const loading = ref(true)
const error = ref('')

const newRoleName = ref('')
const newRoleDescription = ref('')
const creating = ref(false)

// Permission-Dialog
const showPermDialog = ref(false)
const selectedRole = ref<RoleWithPermissions | null>(null)

const permissionGroups = computed(() => {
  const groups = new Map<string, Permission[]>()
  for (const p of allPermissions.value) {
    const domain = p.key.split('.')[0] ?? p.key
    if (!groups.has(domain)) groups.set(domain, [])
    groups.get(domain)!.push(p)
  }
  return Array.from(groups.entries()).map(([domain, perms]) => ({ domain, perms }))
})

function roleHasPermission(permId: number): boolean {
  return selectedRole.value?.permissions.some((p) => p.id === permId) ?? false
}

async function loadData() {
  loading.value = true
  error.value = ''
  try {
    const [rolesRes, permsRes] = await Promise.all([listRoles(), listPermissions()])
    roles.value = rolesRes.roles
    allPermissions.value = permsRes.permissions
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
    await loadData()
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
    await loadData()
  } catch (err: any) {
    error.value = err.message || 'Rolle konnte nicht gelöscht werden'
  }
}

function openPermDialog(role: RoleWithPermissions) {
  selectedRole.value = role
  showPermDialog.value = true
}

async function togglePermission(permId: number) {
  if (!selectedRole.value) return
  error.value = ''
  try {
    if (roleHasPermission(permId)) {
      await revokePermission(selectedRole.value.id, permId)
    } else {
      await assignPermission(selectedRole.value.id, permId)
    }
    await loadData()
    // Update selectedRole reference after reload
    selectedRole.value = roles.value.find((r) => r.id === selectedRole.value!.id) ?? null
  } catch (err: any) {
    error.value = err.message || 'Berechtigung konnte nicht geändert werden'
  }
}

onMounted(loadData)
</script>

<template>
  <div>
    <h1>Rollen & Berechtigungen</h1>

    <Message v-if="error" severity="error" :closable="false" class="mb">{{ error }}</Message>

    <div v-if="auth.hasPermission('roles.create')" class="create-form mb">
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
      table-style="min-width: 50rem"
    >
      <Column field="id" header="ID" sortable style="width: 5rem" />
      <Column field="name" header="Name" sortable style="width: 10rem" />
      <Column field="description" header="Beschreibung" style="width: 14rem" />
      <Column header="Berechtigungen">
        <template #body="{ data }">
          <div class="perm-chips">
            <Chip v-for="perm in data.permissions" :key="perm.id" :label="perm.key" class="perm-chip" />
            <span v-if="data.permissions.length === 0" class="no-perms">Keine</span>
          </div>
        </template>
      </Column>
      <Column header="Aktionen" style="width: 8rem">
        <template #body="{ data }">
          <div class="action-buttons">
            <Button
              v-if="auth.hasPermission('roles.update')"
              icon="pi pi-lock"
              severity="info"
              text
              rounded
              v-tooltip="'Berechtigungen bearbeiten'"
              @click="openPermDialog(data)"
            />
            <Button
              v-if="auth.hasPermission('roles.delete')"
              icon="pi pi-trash"
              severity="danger"
              text
              rounded
              @click="handleDelete(data.id)"
            />
          </div>
        </template>
      </Column>
    </DataTable>

    <!-- Permission-Dialog -->
    <Dialog
      v-model:visible="showPermDialog"
      :header="'Berechtigungen: ' + (selectedRole?.name ?? '')"
      :modal="true"
      :style="{ width: '550px' }"
    >
      <div v-if="selectedRole" class="perm-dialog-content">
        <div v-for="group in permissionGroups" :key="group.domain" class="perm-group">
          <h4 class="group-title">{{ group.domain }}</h4>
          <div v-for="perm in group.perms" :key="perm.id" class="perm-row">
            <Checkbox
              :model-value="roleHasPermission(perm.id)"
              :binary="true"
              :input-id="'perm-' + perm.id"
              @update:model-value="togglePermission(perm.id)"
            />
            <label :for="'perm-' + perm.id" class="perm-label">
              <span class="perm-key">{{ perm.key }}</span>
              <span class="perm-desc">{{ perm.description }}</span>
            </label>
          </div>
        </div>
      </div>
    </Dialog>
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

.perm-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 0.25rem;
}

.perm-chip {
  font-size: 0.75rem;
}

.no-perms {
  color: var(--text-color-secondary);
  font-style: italic;
  font-size: 0.85rem;
}

.action-buttons {
  display: flex;
  gap: 0.25rem;
}

.perm-dialog-content {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.perm-group {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.group-title {
  margin: 0;
  font-size: 0.85rem;
  text-transform: uppercase;
  color: var(--text-color-secondary);
  letter-spacing: 0.05em;
  border-bottom: 1px solid var(--surface-border);
  padding-bottom: 0.25rem;
}

.perm-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding-left: 0.25rem;
}

.perm-label {
  display: flex;
  flex-direction: column;
  cursor: pointer;
}

.perm-key {
  font-family: monospace;
  font-size: 0.85rem;
  font-weight: 600;
}

.perm-desc {
  font-size: 0.8rem;
  color: var(--text-color-secondary);
}
</style>
