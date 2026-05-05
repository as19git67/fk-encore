<script setup lang="ts">
import { ref, onMounted } from 'vue'
import Button from 'primevue/button'
import InputText from 'primevue/inputtext'
import Message from 'primevue/message'
import Dialog from 'primevue/dialog'
import Select from 'primevue/select'
import DataTable from 'primevue/datatable'
import Column from 'primevue/column'
import Tag from 'primevue/tag'
import {
  listGroups,
  createGroup,
  deleteGroup,
  getGroup,
  addGroupMember,
  removeGroupMember,
  type GroupSummary,
  type GroupMemberDTO
} from '../api/documents'
import { listUsers, type UserWithRoles } from '../api/users'
import { useAuthStore } from '../stores/auth'

const auth = useAuthStore()
const groups = ref<GroupSummary[]>([])
const loading = ref(false)
const error = ref('')

// Group creation
const showCreateDialog = ref(false)
const newGroupName = ref('')
const creating = ref(false)

// Group details/editing
const selectedGroup = ref<(GroupSummary & { members: GroupMemberDTO[] }) | null>(null)
const loadingDetails = ref(false)
const showMemberDialog = ref(false)
const selectedUser = ref<UserWithRoles | null>(null)
const memberRole = ref<'owner' | 'member'>('member')
const addingMember = ref(false)

const allUsers = ref<UserWithRoles[]>([])

const roleOptions = [
  { label: 'Eigentümer', value: 'owner' },
  { label: 'Mitglied', value: 'member' }
]

async function load() {
  loading.value = true
  error.value = ''
  try {
    const [hRes, uRes] = await Promise.all([
      listGroups(),
      listUsers()
    ])
    groups.value = hRes.items
    allUsers.value = uRes.users
  } catch (err: any) {
    error.value = err.message || 'Fehler beim Laden der Daten'
  } finally {
    loading.value = false
  }
}

function getAvailableUsers() {
  if (!selectedGroup.value) return []
  const memberIds = new Set(selectedGroup.value.members.map(m => m.user_id))
  return allUsers.value.filter(u => !memberIds.has(u.id))
}

async function handleCreate() {
  if (!newGroupName.value.trim()) return
  creating.value = true
  try {
    await createGroup(newGroupName.value.trim())
    newGroupName.value = ''
    showCreateDialog.value = false
    await load()
  } catch (err: any) {
    error.value = err.message || 'Fehler beim Erstellen'
  } finally {
    creating.value = false
  }
}

async function openDetails(h: GroupSummary) {
  loadingDetails.value = true
  try {
    selectedGroup.value = await getGroup(h.id)
  } catch (err: any) {
    error.value = err.message || 'Fehler beim Laden der Details'
  } finally {
    loadingDetails.value = false
  }
}

async function handleAddMember() {
  if (!selectedGroup.value || !selectedUser.value) return
  addingMember.value = true
  try {
    await addGroupMember(selectedGroup.value.id, selectedUser.value.email, memberRole.value)
    selectedUser.value = null
    showMemberDialog.value = false
    await openDetails(selectedGroup.value) // Refresh
  } catch (err: any) {
    error.value = err.message || 'Fehler beim Hinzufügen'
  } finally {
    addingMember.value = false
  }
}

async function handleRemoveMember(userId: number) {
  if (!selectedGroup.value) return
  if (!confirm('Mitglied wirklich entfernen?')) return
  try {
    await removeGroupMember(selectedGroup.value.id, userId)
    await openDetails(selectedGroup.value) // Refresh
  } catch (err: any) {
    error.value = err.message || 'Fehler beim Entfernen'
  }
}

async function handleDeleteGroup(h: GroupSummary) {
  if (!confirm(`Gruppe "${h.name}" wirklich löschen? Alle Dokument-Zuordnungen gehen verloren.`)) return
  try {
    await deleteGroup(h.id)
    if (selectedGroup.value?.id === h.id) selectedGroup.value = null
    await load()
  } catch (err: any) {
    error.value = err.message || 'Fehler beim Löschen'
  }
}

onMounted(load)
</script>

<template>
  <div class="groups-view">
    <div class="header">
      <h1>Gruppen</h1>
      <Button label="Neu" icon="pi pi-plus" @click="showCreateDialog = true" />
    </div>

    <Message v-if="error" severity="error" @close="error = ''" sticky>{{ error }}</Message>

    <div class="layout">
      <!-- Sidebar: List -->
      <div class="list-panel">
        <div v-if="loading" class="info"><i class="pi pi-spin pi-spinner" /></div>
        <div v-else-if="groups.length === 0" class="info">Keine Gruppen vorhanden.</div>
        <div
          v-for="h in groups"
          :key="h.id"
          class="group-item"
          :class="{ active: selectedGroup?.id === h.id }"
          @click="openDetails(h)"
        >
          <div class="h-info">
            <span class="h-name">{{ h.name }}</span>
            <span class="h-meta">{{ h.member_count }} Mitglieder · {{ h.my_role === 'owner' ? 'Besitzer' : 'Mitglied' }}</span>
          </div>
          <Button
            v-if="h.my_role === 'owner'"
            icon="pi pi-trash"
            severity="secondary"
            text
            rounded
            @click.stop="handleDeleteGroup(h)"
          />
        </div>
      </div>

      <!-- Main: Details -->
      <div class="detail-panel">
        <div v-if="loadingDetails" class="info-centered"><i class="pi pi-spin pi-spinner" /> Details werden geladen...</div>
        <div v-else-if="selectedGroup" class="details">
          <div class="detail-header">
            <h2>{{ selectedGroup.name }}</h2>
            <Button
              v-if="selectedGroup.my_role === 'owner'"
              label="Mitglied hinzufügen"
              icon="pi pi-user-plus"
              size="small"
              @click="showMemberDialog = true"
            />
          </div>

          <DataTable :value="selectedGroup.members" size="small">
            <Column field="email" header="E-Mail" />
            <Column field="name" header="Name" />
            <Column field="role" header="Rolle">
              <template #body="{ data }">
                <Tag :value="data.role === 'owner' ? 'Besitzer' : 'Mitglied'" :severity="data.role === 'owner' ? 'info' : 'secondary'" />
              </template>
            </Column>
            <Column v-if="selectedGroup.my_role === 'owner'" style="width: 3rem">
              <template #body="{ data }">
                <Button
                  v-if="data.user_id !== auth.user?.id"
                  icon="pi pi-user-minus"
                  severity="danger"
                  text
                  rounded
                  @click="handleRemoveMember(data.user_id)"
                  v-tooltip.left="'Mitglied entfernen'"
                />
              </template>
            </Column>
          </DataTable>
        </div>
        <div v-else class="info-centered">Wähle eine Gruppe aus, um Details anzuzeigen.</div>
      </div>
    </div>

    <!-- Create Dialog -->
    <Dialog v-model:visible="showCreateDialog" header="Neue Gruppe" :modal="true" :style="{ width: '400px' }">
      <div class="field">
        <label for="name" class="block">Name der Gruppe</label>
        <InputText id="name" v-model="newGroupName" autofocus class="w-full" @keyup.enter="handleCreate" />
      </div>
      <template #footer>
        <Button label="Abbrechen" icon="pi pi-times" text @click="showCreateDialog = false" />
        <Button label="Erstellen" icon="pi pi-check" :loading="creating" @click="handleCreate" />
      </template>
    </Dialog>

    <!-- Member Dialog -->
    <Dialog v-model:visible="showMemberDialog" header="Mitglied hinzufügen" :modal="true" :style="{ width: '400px' }">
      <div class="field mb-3">
        <label for="user" class="block">Benutzer auswählen</label>
        <Select
          id="user"
          v-model="selectedUser"
          :options="getAvailableUsers()"
          optionLabel="name"
          placeholder="Benutzer suchen..."
          class="w-full"
          filter
          :autoFocus="true"
        >
          <template #option="slotProps">
            <div class="flex flex-column">
              <div>{{ slotProps.option.name }}</div>
              <small class="text-muted-color">{{ slotProps.option.email }}</small>
            </div>
          </template>
        </Select>
      </div>
      <div class="field">
        <label for="role" class="block">Rolle</label>
        <Select
          id="role"
          v-model="memberRole"
          :options="roleOptions"
          optionLabel="label"
          optionValue="value"
          class="w-full"
        />
      </div>
      <template #footer>
        <Button label="Abbrechen" icon="pi pi-times" text @click="showMemberDialog = false" />
        <Button label="Hinzufügen" icon="pi pi-check" :loading="addingMember" :disabled="!selectedUser" @click="handleAddMember" />
      </template>
    </Dialog>
  </div>
</template>

<style scoped>
.groups-view {
  padding: 1.5rem;
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
  height: 100%;
}
.header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.header h1 { margin: 0; font-size: 1.5rem; }

.layout {
  display: grid;
  grid-template-columns: 300px 1fr;
  gap: 1.5rem;
  flex: 1;
  min-height: 0;
}

.list-panel {
  background: var(--p-content-background);
  border: 1px solid var(--p-content-border-color);
  border-radius: 8px;
  overflow-y: auto;
}

.group-item {
  padding: 1rem;
  border-bottom: 1px solid var(--p-content-border-color);
  cursor: pointer;
  display: flex;
  justify-content: space-between;
  align-items: center;
  transition: background 0.2s;
}
.group-item:hover { background: var(--p-surface-ground); }
.group-item.active {
  background: var(--p-highlight-background);
  color: var(--p-highlight-color);
}
.h-info { display: flex; flex-direction: column; gap: 0.25rem; }
.h-name { font-weight: 600; }
.h-meta { font-size: 0.85rem; opacity: 0.8; }

.detail-panel {
  background: var(--p-content-background);
  border: 1px solid var(--p-content-border-color);
  border-radius: 8px;
  padding: 1.5rem;
  overflow-y: auto;
}

.detail-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: 1.5rem;
}
.detail-header h2 { margin: 0; font-size: 1.25rem; }

.info, .info-centered {
  padding: 2rem;
  text-align: center;
  color: var(--p-text-muted-color);
}
.info-centered {
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
}

.field label {
  display: block;
  margin-bottom: 0.5rem;
  font-weight: 500;
}
.w-full { width: 100%; }
.mb-3 { margin-bottom: 1rem; }
</style>
