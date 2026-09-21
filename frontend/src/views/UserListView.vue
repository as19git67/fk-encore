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
import PageLayout from '../components/layout/PageLayout.vue'
import ScrollX from '../components/layout/ScrollX.vue'
import ListToolbar from '../components/layout/ListToolbar.vue'
import EmptyState from '../components/layout/EmptyState.vue'
import PageSkeleton from '../components/layout/PageSkeleton.vue'
import ErrorBanner from '../components/layout/ErrorBanner.vue'
import { useListSearch, useListToolbar } from '../composables/useListToolbar'
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
import { anchorKey, saveListAnchor } from '../utils/listAnchor'

const router = useRouter()
/** Schlüssel für Anker und Scroll-Offset dieser Liste (#1279). */
const ANCHOR_KEY = 'admin-users'
const auth = useAuthStore()
const users = ref<UserWithRoles[]>([])
const loading = ref(true)
const error = ref('')

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

// ─── Shared list toolbar (#1272, stage 3) ───────────────────────────────────
// The whole list is in memory, so the search filters the rows right here —
// it runs over exactly the two identifying columns the table shows.
const search = useListSearch({
  placeholder: 'Name oder E-Mail suchen',
  storageKey: 'admin.users.search',
})

const searching = computed(() => search.term.value.trim().length > 0)

const visibleUsers = computed(() => {
  const term = search.term.value.trim().toLowerCase()
  if (!term) return users.value
  return users.value.filter(
    (user) =>
      user.name.toLowerCase().includes(term) || user.email.toLowerCase().includes(term),
  )
})

const toolbar = useListToolbar({
  search,
  result: {
    loaded: () => visibleUsers.value.length,
    total: () => users.value.length,
    loading: () => loading.value,
  },
})

async function loadUsers() {
  loading.value = true
  error.value = ''
  try {
    const res = await listUsers()
    users.value = res.users
  } catch (err: any) {
    error.value = err?.message || 'Benutzer konnten nicht geladen werden'
  } finally {
    loading.value = false
  }
}

onMounted(async () => {
  await loadUsers()
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
  // Merken, aus welcher Zeile heraus die Detailseite geöffnet wurde, damit
  // der Weg zurück wieder dort landet statt am Listenanfang.
  saveListAnchor(ANCHOR_KEY, { kind: 'user', id: event.data.id })
  router.push(`/admin/benutzer/${event.data.id}`)
}

/**
 * Eine `DataTable`-Zeile nimmt kein gebundenes Attribut entgegen wie ein
 * `v-for`-Element — nur der Passthrough kommt an das `<tr>` heran, und die
 * Zeilendaten stecken dort in den Props der Zeilenkomponente.
 */
function anchorRowAttrs(options: { props?: { rowData?: UserWithRoles } }) {
  const id = options.props?.rowData?.id
  if (!id) return {}
  // `tabindex="-1"`, weil ein `<tr>` sonst keinen Fokus annehmen kann und die
  // Rückkehr nur scrollen, aber nicht weitertippen ließe.
  return { 'data-anchor': anchorKey('user', id), class: 'scroll-anchor', tabindex: '-1' }
}
</script>

<template>
  <PageLayout title="Benutzer" width="wide" :ready="!loading" :anchor-key="ANCHOR_KEY">
    <template #actions>
      <Button
        v-if="mayInvite"
        label="Einladen"
        icon="pi pi-envelope"
        size="small"
        @click="openInviteDialog"
      />
    </template>

    <template #toolbar>
      <ListToolbar :model="toolbar" />
    </template>

    <template #notice>
      <ErrorBanner
        v-if="error"
        :message="error"
        closable
        @retry="loadUsers"
        @close="error = ''"
      />
      <Message
        v-if="inviteNotice"
        severity="success"
        :closable="true"
        @close="inviteNotice = ''"
      >
        {{ inviteNotice }}
      </Message>
    </template>

    <div class="user-list-view">
    <PageSkeleton v-if="loading && users.length === 0" variant="table" :count="8" />

    <EmptyState
      v-else-if="visibleUsers.length === 0"
      icon="pi pi-users"
      :title="searching ? 'Keine Treffer' : 'Keine Benutzer'"
      :message="
        searching
          ? 'Zu diesem Suchbegriff passt kein Benutzer.'
          : 'Es ist noch kein Benutzerkonto angelegt — neue Konten entstehen über eine Einladung.'
      "
      :filtered="searching"
      @clear-filters="search.clear()"
    />

    <ScrollX v-else>
    <DataTable
      :value="visibleUsers"
      :loading="loading"
      striped-rows
      hover
      paginator
      :rows="10"
      @row-click="onRowClick"
      :row-class="() => 'cursor-pointer'"
      :pt="{ bodyRow: anchorRowAttrs }"
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
    </ScrollX>

    <section v-if="mayInvite && invites.length > 0" class="invites">
      <h2 class="subtitle">Einladungen</h2>
      <ScrollX>
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
      </ScrollX>
    </section>

    <Dialog
    class="dialog-sm" v-model:visible="dialogOpen" modal header="Benutzer einladen">
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
  </PageLayout>
</template>

<style scoped>
/* Page frame and title: PageLayout (issue #1272). */
.user-list-view {
  gap: 1rem;
  display: flex;
  flex-direction: column;
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
  font-size: var(--text-base);
}

.hint {
  color: var(--p-text-muted-color);
  font-size: var(--text-md);
}

.mb {
  margin-bottom: 1rem;
}
</style>
