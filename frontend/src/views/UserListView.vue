<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import DataTable from 'primevue/datatable'
import Column from 'primevue/column'
import { listUsers, type User } from '../api/users'

const router = useRouter()
const users = ref<User[]>([])
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
  <div>
    <h1>Benutzer</h1>
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
      <Column field="created_at" header="Erstellt am" sortable>
        <template #body="{ data }">
          {{ formatDate(data.created_at) }}
        </template>
      </Column>
    </DataTable>
  </div>
</template>

<style scoped>
:deep(.cursor-pointer) {
  cursor: pointer;
}
</style>

