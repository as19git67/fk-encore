<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import DataTable from 'primevue/datatable'
import Column from 'primevue/column'
import Chip from 'primevue/chip'
import Button from 'primevue/button'
import Dialog from 'primevue/dialog'
import InputText from 'primevue/inputtext'
import Message from 'primevue/message'
import Tag from 'primevue/tag'
import {
  listUsers,
  listInvites,
  createInvite,
  revokeInvite,
  type UserWithRoles,
  type Invite,
} from '../api/users'
import { useAuthStore } from '../stores/auth'
import { formatDateShort } from '../utils/dateFormat'

const router = useRouter()
const auth = useAuthStore()
const users = ref<UserWithRoles[]>([])
const loading = ref(true)

// Accounts are created by invitation only, so this list is the one place
// where new ones start. Without users.create there is nothing to show.
const mayInvite = computed(() => auth.hasPermission('users.create'))
const invites = ref<Invite[]>([])
const invitesLoading = ref(false)
const dialogOpen = ref(false)
const inviteEmail = ref('')
const inviteError = ref('')
const inviteNotice = ref('')
const inviting = ref(false)

onMounted(async () => {
  try {
    const res = await listUsers()
    users.value = res.users
  } finally {
    loading.value = false
  }
  if (mayInvite.value) await loadInvites()
})

async function loadInvites() {
  invitesLoading.value = true
  try {
    const res = await listInvites()
    invites.value = res.invites
  } finally {
    invitesLoading.value = false
  }
}

function openInviteDialog() {
  inviteEmail.value = ''
  inviteError.value = ''
  dialogOpen.value = true
}

async function submitInvite() {
  inviteError.value = ''
  inviting.value = true
  try {
    await createInvite(inviteEmail.value)
    // The link itself is not shown here — it goes to the invited mailbox
    // and nowhere else, so holding users.create is not the same as being
    // able to register as somebody.
    inviteNotice.value = `Einladung an ${inviteEmail.value} verschickt.`
    dialogOpen.value = false
    await loadInvites()
  } catch (err: any) {
    inviteError.value = err.message || 'Einladung konnte nicht verschickt werden'
  } finally {
    inviting.value = false
  }
}

async function withdraw(invite: Invite) {
  await revokeInvite(invite.id)
  await loadInvites()
}

function formatDate(dateStr: string) {
  return formatDateShort(dateStr)
}

function onRowClick(event: any) {
  router.push(`/admin/benutzer/${event.data.id}`)
}
</script>

<template>
  <div class="user-list-view">
    <div class="header">
      <h1 class="title">Benutzer</h1>
      <Button
        v-if="mayInvite"
        label="Einladen"
        icon="pi pi-envelope"
        size="small"
        @click="openInviteDialog"
      />
    </div>

    <Message
      v-if="inviteNotice"
      severity="success"
      :closable="true"
      @close="inviteNotice = ''"
    >
      {{ inviteNotice }}
    </Message>

    <DataTable
      :value="users"
      :loading="loading"
      striped-rows
      hover
      paginator
      :rows="10"
      @row-click="onRowClick"
      :row-class="() => 'cursor-pointer'"
    >
      <Column field="id" header="ID" sortable style="width: 5rem" class="mobile-hidden" headerClass="mobile-hidden" />
      <Column field="name" header="Name" sortable />
      <Column field="email" header="E-Mail" sortable />
      <Column header="Rollen" class="mobile-hidden" headerClass="mobile-hidden">
        <template #body="{ data }">
          <div class="roles-chips">
            <Chip v-for="role in data.roles" :key="role.id" :label="role.name" />
          </div>
        </template>
      </Column>
      <Column field="created_at" header="Erstellt am" sortable class="mobile-hidden" headerClass="mobile-hidden">
        <template #body="{ data }">
          {{ formatDate(data.created_at) }}
        </template>
      </Column>
    </DataTable>

    <section v-if="mayInvite && invites.length > 0" class="invites">
      <h2 class="subtitle">Einladungen</h2>
      <DataTable :value="invites" :loading="invitesLoading" striped-rows>
        <Column field="email" header="E-Mail" />
        <Column header="Status" style="width: 10rem">
          <template #body="{ data }">
            <Tag
              v-if="data.accepted_at"
              severity="success"
              :value="`Angenommen ${formatDate(data.accepted_at)}`"
            />
            <Tag v-else severity="info" :value="`Gültig bis ${formatDate(data.expires_at)}`" />
          </template>
        </Column>
        <Column style="width: 8rem">
          <template #body="{ data }">
            <Button
              v-if="!data.accepted_at"
              label="Zurückziehen"
              severity="secondary"
              text
              size="small"
              @click="withdraw(data)"
            />
          </template>
        </Column>
      </DataTable>
    </section>

    <Dialog v-model:visible="dialogOpen" modal header="Benutzer einladen" :style="{ width: '26rem' }">
      <Message v-if="inviteError" severity="error" :closable="false" class="mb">
        {{ inviteError }}
      </Message>
      <form @submit.prevent="submitInvite" class="form">
        <div class="field">
          <label for="invite-email">E-Mail</label>
          <InputText id="invite-email" v-model="inviteEmail" type="email" fluid autofocus />
          <small class="hint">
            Der Eingeladene legt Name und Passwort selbst fest. Rollen werden erst danach
            vergeben — eine Einladung allein erteilt keine Rechte.
          </small>
        </div>
        <Button type="submit" label="Einladung verschicken" icon="pi pi-send" :loading="inviting" fluid />
      </form>
    </Dialog>
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

.header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
}

.user-list-view .title {
  font-size: 1.5em;
  font-weight: 600;
  margin-block: 0.25em;
}

.subtitle {
  font-size: 1.1em;
  font-weight: 600;
  margin-block: 0.25em;
}

.invites {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

:deep(.cursor-pointer) {
  cursor: pointer;
}

.roles-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 0.25rem;
}

.form {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.field label {
  font-weight: 600;
  font-size: 0.875rem;
}

.hint {
  color: var(--p-text-muted-color);
  font-size: 0.8rem;
}

.mb {
  margin-bottom: 1rem;
}
</style>
