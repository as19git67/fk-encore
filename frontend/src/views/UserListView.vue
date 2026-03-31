<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import DataTable from 'primevue/datatable'
import Column from 'primevue/column'
import Chip from 'primevue/chip'
import { listUsers, type UserWithRoles } from '../api/users'

const router = useRouter()
const users = ref<UserWithRoles[]>([])
const loading = ref(true)

onMounted(async () => {
  try {
    const res = await listUsers()
    users.value = res.users
  } finally {
    loading.value = false
  }
})

function onRowClick(event: any) {
  router.push(`/users/${event.data.id}`)
}

function formatDate(dateStr: string) {
  return new Date(dateStr).toLocaleString('de-DE')
}
</script>

<template>
  <div class="user-list-view">
    <h1 class="title">Benutzer</h1>
    <DataTable
      :value="users"
      :loading="loading"
      striped-rows
      hover
      paginator
      :rows="10"
      @row-click="onRowClick"
      :row-class="() => 'cursor-pointer'"
      table-style="min-width: 50rem"
    >
      <Column field="id" header="ID" sortable style="width: 5rem" />
      <Column field="name" header="Name" sortable />
      <Column field="email" header="E-Mail" sortable />
      <Column header="Rollen">
        <template #body="{ data }">
          <div class="roles-chips">
            <Chip v-for="role in data.roles" :key="role.id" :label="role.name" />
          </div>
        </template>
      </Column>
      <Column field="created_at" header="Erstellt am" sortable>
        <template #body="{ data }">
          {{ formatDate(data.created_at) }}
        </template>
      </Column>
    </DataTable>
  </div>
</template>

<style scoped>
.user-list-view {
  gap: 1rem;
  display: flex;
  flex-direction: column;
}

@media (min-width: 800px) {
  .user-list-view {
    margin-inline: 0.5em;
  }
}

.user-list-view .title {
  font-size: 1.5em;
  font-weight: 600;
  margin-block: 0.25em;
}

:deep(.cursor-pointer) {
  cursor: pointer;
}

.roles-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 0.25rem;
}
</style>

