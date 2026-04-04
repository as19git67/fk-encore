<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import Card from 'primevue/card'
import Chip from 'primevue/chip'
import Select from 'primevue/select'
import Button from 'primevue/button'
import Dialog from 'primevue/dialog'
import Message from 'primevue/message'
import { getUser, deleteUser, type UserWithRoles } from '../api/users'
import { listRoles, assignRole, removeRole } from '../api/roles'
import type { Role } from '../api/users'
import { useAuthStore } from '../stores/auth'

const auth = useAuthStore()
const route = useRoute()
const router = useRouter()

const user = ref<UserWithRoles | null>(null)
const allRoles = ref<Role[]>([])
const selectedRole = ref<Role | null>(null)
const loading = ref(true)
const error = ref('')
const showDeleteConfirm = ref(false)
const showRemoveRoleConfirm = ref(false)
const roleToRemove = ref<Role | null>(null)

const userId = Number(route.params.id)

const availableRoles = computed(() => {
  if (!user.value) return allRoles.value
  const assignedIds = new Set(user.value.roles.map((r) => r.id))
  return allRoles.value.filter((r) => !assignedIds.has(r.id))
})

async function loadData() {
  loading.value = true
  error.value = ''
  try {
    const [userData, rolesData] = await Promise.all([getUser(userId), listRoles()])
    user.value = userData
    allRoles.value = rolesData.roles
  } catch (err: any) {
    error.value = err.message || 'Fehler beim Laden'
  } finally {
    loading.value = false
  }
}

async function handleAssignRole() {
  if (!selectedRole.value) return
  try {
    await assignRole(userId, selectedRole.value.id)
    selectedRole.value = null
    await loadData()
  } catch (err: any) {
    error.value = err.message || 'Rolle konnte nicht zugewiesen werden'
  }
}

function confirmRemoveRole(role: Role) {
  roleToRemove.value = role
  showRemoveRoleConfirm.value = true
}

async function handleRemoveRole() {
  if (!roleToRemove.value) return
  try {
    await removeRole(userId, roleToRemove.value.id)
    showRemoveRoleConfirm.value = false
    roleToRemove.value = null
    await loadData()
  } catch (err: any) {
    showRemoveRoleConfirm.value = false
    roleToRemove.value = null
    await loadData()
    error.value = err.message || 'Rolle konnte nicht entfernt werden'
  }
}

async function handleDelete() {
  try {
    await deleteUser(userId)
    router.push('/users')
  } catch (err: any) {
    showDeleteConfirm.value = false
    error.value = err.message || 'Benutzer konnte nicht gelöscht werden'
  }
}

function formatDate(dateStr: string) {
  return new Date(dateStr).toLocaleString('de-DE')
}

onMounted(loadData)
</script>

<template>
  <div v-if="loading" class="loading">Laden...</div>
  <div class="user-detail-view" v-else-if="user">
    <div class="header-row">
      <h1 class="title">{{ user.name }}</h1>
      <Button v-if="auth.hasPermission('users.delete')" label="Benutzer löschen" icon="pi pi-trash" severity="danger" outlined @click="showDeleteConfirm = true" />
    </div>

    <Message v-if="error" severity="error" :closable="false" class="mb">{{ error }}</Message>

    <!-- Confirm Delete Dialog -->
    <Dialog v-model:visible="showDeleteConfirm" header="Benutzer löschen" :modal="true" :style="{ width: '400px' }">
      <p>Benutzer <strong>{{ user.name }}</strong> wirklich löschen?</p>
      <template #footer>
        <Button label="Abbrechen" severity="secondary" @click="showDeleteConfirm = false" />
        <Button label="Löschen" severity="danger" @click="handleDelete" />
      </template>
    </Dialog>

    <!-- Confirm Remove Role Dialog -->
    <Dialog v-model:visible="showRemoveRoleConfirm" header="Rolle entfernen" :modal="true" :style="{ width: '400px' }">
      <p>Rolle <strong>{{ roleToRemove?.name }}</strong> von Benutzer <strong>{{ user.name }}</strong> wirklich entfernen?</p>
      <template #footer>
        <Button label="Abbrechen" severity="secondary" @click="showRemoveRoleConfirm = false" />
        <Button label="Entfernen" severity="danger" @click="handleRemoveRole" />
      </template>
    </Dialog>

    <Card class="mb">
      <template #title>Benutzerdetails</template>
      <template #content>
        <div class="detail-grid">
          <div class="detail-label">ID</div>
          <div>{{ user.id }}</div>
          <div class="detail-label">Name</div>
          <div>{{ user.name }}</div>
          <div class="detail-label">E-Mail</div>
          <div>{{ user.email }}</div>
          <div class="detail-label">Erstellt</div>
          <div>{{ formatDate(user.created_at) }}</div>
          <div class="detail-label">Aktualisiert</div>
          <div>{{ formatDate(user.updated_at) }}</div>
        </div>
      </template>
    </Card>

    <Card>
      <template #title>Rollen</template>
      <template #content>
        <div class="roles-list" v-if="user.roles.length > 0">
          <div v-for="role in user.roles" :key="role.id" class="role-item">
            <Chip :label="role.name" />
            <Button
              v-if="auth.hasPermission('roles.revoke')"
              icon="pi pi-times"
              severity="danger"
              text
              rounded
              size="small"
              @click="confirmRemoveRole(role)"
            />
          </div>
        </div>
        <p v-else class="no-roles">Keine Rollen zugewiesen.</p>

        <div class="assign-form" v-if="auth.hasPermission('roles.assign') && availableRoles.length > 0">
          <Select
            v-model="selectedRole"
            :options="availableRoles"
            option-label="name"
            placeholder="Rolle auswählen"
            class="role-select"
          />
          <Button label="Zuweisen" icon="pi pi-plus" :disabled="!selectedRole" @click="handleAssignRole" />
        </div>
      </template>
    </Card>
  </div>
  <div v-else>
    <Message severity="error" :closable="false">Benutzer nicht gefunden.</Message>
  </div>
</template>

<style scoped>
.user-detail-view {
  gap: 1rem;
  display: flex;
  flex-direction: column;
}

@media (min-width: 800px) {
  .user-detail-view {
    margin-inline: 0.5em;
  }
}

.user-detail-view .title {
  font-size: 1.5em;
  font-weight: 600;
  margin-block: 0.25em;
}

.header-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-block: 0.25rem;
  margin-bottom: 1rem;
}

.detail-grid {
  display: grid;
  grid-template-columns: 10rem 1fr;
  gap: 0.5rem 1rem;
}

.detail-label {
  font-weight: 600;
  color: var(--p-text-muted-color);
}

.roles-list {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  margin-bottom: 1rem;
}

.role-item {
  display: flex;
  align-items: center;
  gap: 0.1rem;
}

.no-roles {
  color: var(--p-text-muted-color);
  margin-bottom: 1rem;
}

.assign-form {
  display: flex;
  gap: 0.5rem;
  align-items: center;
  margin-top: 1rem;
}

.role-select {
  min-width: 200px;
}

.mb {
  margin-bottom: 1rem;
}

.loading {
  text-align: center;
  padding: 2rem;
  color: var(--p-text-muted-color);
}

.confirm-content {
  padding: 1rem;
}

.confirm-actions {
  display: flex;
  gap: 0.5rem;
  justify-content: flex-end;
  margin-top: 1rem;
}
</style>

