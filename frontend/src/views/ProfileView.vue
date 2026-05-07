<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import Card from 'primevue/card'
import Chip from 'primevue/chip'
import Button from 'primevue/button'
import DataTable from 'primevue/datatable'
import Column from 'primevue/column'
import InputText from 'primevue/inputtext'
import Password from 'primevue/password'
import Message from 'primevue/message'
import { useAuthStore } from '../stores/auth'
import {
  listPasskeys,
  passkeyRegisterOptions,
  passkeyRegisterVerify,
  deletePasskey,
  type PasskeyInfo,
} from '../api/passkeys'
import { changePassword } from '../api/users'
import { formatDateShort } from '../utils/dateFormat'
import {
  startRegistration,
  browserSupportsWebAuthn,
} from '@simplewebauthn/browser'
import { usePushNotifications } from '../composables/usePushNotifications'
import {
  getPushPreferences,
  updatePushPreferences,
  type NotificationKind,
  type NotificationPrefs,
} from '../api/push'

const auth = useAuthStore()

const passkeys = ref<PasskeyInfo[]>([])
const loading = ref(true)
const error = ref('')
const passkeyName = ref('')
const registering = ref(false)
const supportsPasskey = browserSupportsWebAuthn()

async function loadPasskeys() {
  loading.value = true
  error.value = ''
  try {
    const res = await listPasskeys()
    passkeys.value = res.passkeys
  } catch (err: any) {
    error.value = err.message || 'Fehler beim Laden der Passkeys'
  } finally {
    loading.value = false
  }
}

async function handleRegisterPasskey() {
  error.value = ''
  registering.value = true
  try {
    const { challengeId, options } = await passkeyRegisterOptions()
    const credential = await startRegistration({ optionsJSON: options })
    await passkeyRegisterVerify(challengeId, credential, passkeyName.value || undefined)
    passkeyName.value = ''
    await loadPasskeys()
  } catch (err: any) {
    if (err.name === 'NotAllowedError') {
      error.value = 'Passkey-Registrierung abgebrochen'
    } else {
      error.value = err.message || 'Passkey-Registrierung fehlgeschlagen'
    }
  } finally {
    registering.value = false
  }
}

async function handleDeletePasskey(credentialId: string) {
  error.value = ''
  try {
    await deletePasskey(credentialId)
    await loadPasskeys()
  } catch (err: any) {
    error.value = err.message || 'Passkey konnte nicht gelöscht werden'
  }
}

function formatDate(dateStr: string) {
  return formatDateShort(dateStr)
}

// ── Password change ──────────────────────────────────────────────────────────
const pwCurrent = ref('')
const pwNew = ref('')
const pwConfirm = ref('')
const pwLoading = ref(false)
const pwError = ref('')
const pwSuccess = ref(false)

async function handleChangePassword() {
  pwError.value = ''
  pwSuccess.value = false

  if (pwNew.value !== pwConfirm.value) {
    pwError.value = 'Neues Passwort und Bestätigung stimmen nicht überein.'
    return
  }
  if (pwNew.value.length < 8) {
    pwError.value = 'Das neue Passwort muss mindestens 8 Zeichen lang sein.'
    return
  }

  pwLoading.value = true
  try {
    await changePassword(pwCurrent.value, pwNew.value)
    pwSuccess.value = true
    pwCurrent.value = ''
    pwNew.value = ''
    pwConfirm.value = ''
  } catch (err: any) {
    pwError.value = err.message || 'Passwort konnte nicht geändert werden.'
  } finally {
    pwLoading.value = false
  }
}

// ── Push notifications ──────────────────────────────────────────────────────
const push = usePushNotifications()

const pushLabel = computed(() => {
  switch (push.status.value) {
    case 'unsupported':
      return 'Dein Browser unterstützt keine Push-Nachrichten.'
    case 'disabled-server':
      return 'Push ist auf dem Server nicht konfiguriert.'
    case 'denied':
      return 'Benachrichtigungen wurden im Browser blockiert. Bitte in den Browser-Einstellungen freigeben.'
    case 'subscribed':
      return 'Push-Nachrichten sind auf diesem Gerät aktiv.'
    case 'unsubscribed':
    default:
      return 'Push-Nachrichten sind auf diesem Gerät nicht aktiv.'
  }
})

async function togglePush() {
  if (push.status.value === 'subscribed') {
    await push.unsubscribe()
  } else {
    await push.subscribe()
  }
}

// ── Per-type notification preferences ──────────────────────────────────────
interface NotificationTypeConfig {
  kind: NotificationKind
  label: string
  description: string
}

const NOTIFICATION_TYPES: NotificationTypeConfig[] = [
  { kind: 'photo_added', label: 'Neue Fotos', description: 'Jemand hat Fotos zu einem geteilten Album hinzugefügt' },
  { kind: 'album_shared', label: 'Album geteilt', description: 'Jemand hat ein Album mit dir geteilt' },
  { kind: 'photo_commented', label: 'Kommentare', description: 'Jemand hat ein Foto kommentiert' },
  { kind: 'photo_favorited', label: 'Favoriten', description: 'Jemand hat ein Foto favorisiert' },
  { kind: 'album_left', label: 'Freigabe verlassen', description: 'Jemand hat eine Albumfreigabe verlassen' },
  { kind: 'document_low_confidence', label: 'Dokumentklassifikation unsicher', description: 'Ein Dokument wurde mit niedriger Konfidenz klassifiziert und sollte geprüft werden' },
  { kind: 'document_failed', label: 'Dokumentverarbeitung fehlgeschlagen', description: 'Ein Dokument konnte nicht automatisch verarbeitet werden' },
]

const notifPrefs = ref<NotificationPrefs>({})
const notifPrefsLoading = ref(false)
const notifPrefsError = ref('')

function isNotifEnabled(kind: NotificationKind): boolean {
  const val = notifPrefs.value[kind]
  return val !== false
}

async function toggleNotifKind(kind: NotificationKind) {
  const current = isNotifEnabled(kind)
  const updated: NotificationPrefs = { ...notifPrefs.value, [kind]: !current }
  notifPrefs.value = updated
  try {
    await updatePushPreferences(updated)
  } catch (err: any) {
    notifPrefsError.value = err.message || 'Einstellungen konnten nicht gespeichert werden.'
    notifPrefs.value = { ...notifPrefs.value, [kind]: current }
  }
}

async function loadNotifPrefs() {
  notifPrefsLoading.value = true
  notifPrefsError.value = ''
  try {
    const res = await getPushPreferences()
    notifPrefs.value = res.preferences
  } catch { /* ignore – defaults to all enabled */ }
  finally { notifPrefsLoading.value = false }
}

onMounted(async () => {
  await loadPasskeys()
  await push.refreshState()
  await loadNotifPrefs()
})
</script>

<template>
  <div>
    <h1>Mein Profil</h1>

    <Message v-if="error" severity="error" :closable="false" class="mb">{{ error }}</Message>

    <Card class="mb">
      <template #title>Kontoinformationen</template>
      <template #content>
        <div class="detail-grid">
          <div class="detail-label">Name</div>
          <div>{{ auth.user?.name }}</div>
          <div class="detail-label">E-Mail</div>
          <div>{{ auth.user?.email }}</div>
          <div class="detail-label">Rollen</div>
          <div class="roles-chips">
            <Chip v-for="role in auth.user?.roles" :key="role.id" :label="role.name" />
            <span v-if="!auth.user?.roles?.length" class="no-roles">Keine Rollen zugewiesen.</span>
          </div>
        </div>
      </template>
    </Card>

    <Card class="mb">
      <template #title>Passwort ändern</template>
      <template #content>
        <Message v-if="pwError" severity="error" :closable="false" class="mb">{{ pwError }}</Message>
        <Message v-if="pwSuccess" severity="success" :closable="false" class="mb">Passwort erfolgreich geändert.</Message>
        <div class="pw-form">
          <Password
            v-model="pwCurrent"
            placeholder="Aktuelles Passwort"
            :feedback="false"
            toggleMask
            class="pw-input"
          />
          <Password
            v-model="pwNew"
            placeholder="Neues Passwort"
            toggleMask
            class="pw-input"
          />
          <Password
            v-model="pwConfirm"
            placeholder="Neues Passwort bestätigen"
            :feedback="false"
            toggleMask
            class="pw-input"
          />
          <Button
            label="Passwort ändern"
            icon="pi pi-lock"
            :loading="pwLoading"
            @click="handleChangePassword"
          />
        </div>
      </template>
    </Card>

    <Card class="mb">
      <template #title>Benachrichtigungen</template>
      <template #content>
        <p class="description">
          Erhalte Push-Nachrichten auf diesem Gerät, wenn jemand Fotos zu geteilten Alben hinzufügt,
          kommentiert oder ein Album mit dir teilt.
        </p>
        <Message v-if="push.error.value" severity="error" :closable="false" class="mb">
          {{ push.error.value }}
        </Message>
        <div class="push-row">
          <span class="push-label">{{ pushLabel }}</span>
          <Button
            v-if="push.canToggle.value"
            :label="push.status.value === 'subscribed' ? 'Deaktivieren' : 'Aktivieren'"
            :icon="push.status.value === 'subscribed' ? 'pi pi-bell-slash' : 'pi pi-bell'"
            :loading="push.busy.value"
            :severity="push.status.value === 'subscribed' ? 'secondary' : 'primary'"
            @click="togglePush"
          />
        </div>

        <template v-if="push.status.value === 'subscribed' || push.status.value === 'unsubscribed'">
          <div class="notif-types-header">
            <span class="notif-types-title">Benachrichtigungstypen</span>
            <span class="notif-types-hint">Wähle, welche Ereignisse du per Push erhalten möchtest.</span>
          </div>
          <Message v-if="notifPrefsError" severity="error" :closable="false" class="mb">
            {{ notifPrefsError }}
          </Message>
          <div class="notif-types-list">
            <div
              v-for="type in NOTIFICATION_TYPES"
              :key="type.kind"
              class="notif-type-row"
            >
              <div class="notif-type-info">
                <span class="notif-type-label">{{ type.label }}</span>
                <span class="notif-type-desc">{{ type.description }}</span>
              </div>
              <Button
                :icon="isNotifEnabled(type.kind) ? 'pi pi-check-circle' : 'pi pi-circle'"
                :severity="isNotifEnabled(type.kind) ? 'primary' : 'secondary'"
                text
                rounded
                size="small"
                :loading="notifPrefsLoading"
                :aria-label="isNotifEnabled(type.kind) ? 'Deaktivieren' : 'Aktivieren'"
                v-tooltip="isNotifEnabled(type.kind) ? 'Klicken zum Deaktivieren' : 'Klicken zum Aktivieren'"
                @click="toggleNotifKind(type.kind)"
              />
            </div>
          </div>
        </template>
      </template>
    </Card>

    <Card v-if="supportsPasskey">
      <template #title>Passkeys</template>
      <template #content>
        <p class="description">
          Passkeys ermöglichen eine sichere, passwortlose Anmeldung mit Fingerabdruck, Gesichtserkennung oder Sicherheitsschlüssel.
        </p>

        <div class="register-form mb">
          <InputText
            v-model="passkeyName"
            placeholder="Name für den Passkey (optional)"
            class="name-input"
          />
          <Button
            label="Neuen Passkey registrieren"
            icon="pi pi-key"
            :loading="registering"
            @click="handleRegisterPasskey"
          />
        </div>

        <DataTable
          :value="passkeys"
          :loading="loading"
          striped-rows
        >
          <template #empty>Keine Passkeys registriert.</template>
          <Column field="name" header="Name" />
          <Column field="device_type" header="Gerätetyp" class="mobile-hidden" headerClass="mobile-hidden">
            <template #body="{ data }">
              {{ data.device_type === 'multiDevice' ? 'Multi-Gerät' : 'Einzel-Gerät' }}
            </template>
          </Column>
          <Column header="Backup" class="mobile-hidden" headerClass="mobile-hidden">
            <template #body="{ data }">
              <i :class="data.backed_up ? 'pi pi-check-circle' : 'pi pi-times-circle'"
                 :style="{ color: data.backed_up ? 'var(--p-green-500)' : 'var(--p-red-500)' }" />
            </template>
          </Column>
          <Column field="created_at" header="Erstellt am">
            <template #body="{ data }">
              {{ formatDate(data.created_at) }}
            </template>
          </Column>
          <Column header="Aktionen" style="width: 6rem">
            <template #body="{ data }">
              <Button
                icon="pi pi-trash"
                severity="danger"
                text
                rounded
                @click="handleDeletePasskey(data.credential_id)"
              />
            </template>
          </Column>
        </DataTable>
      </template>
    </Card>

    <Message v-else severity="warn" :closable="false">
      Ihr Browser unterstützt keine Passkeys.
    </Message>
  </div>
</template>

<style scoped>
.detail-grid {
  display: grid;
  grid-template-columns: 8rem 1fr;
  gap: 0.5rem 1rem;
}

.detail-label {
  font-weight: 600;
  color: var(--p-text-muted-color);
}

.description {
  color: var(--p-text-muted-color);
  margin-bottom: 1rem;
}

.register-form {
  display: flex;
  gap: 0.5rem;
  align-items: center;
  flex-wrap: wrap;
}

.name-input {
  min-width: 250px;
}

.mb {
  margin-bottom: 1rem;
}

.roles-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 0.25rem;
  align-items: center;
}

.no-roles {
  color: var(--p-text-muted-color);
  font-style: italic;
}

.pw-form {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  max-width: 22rem;
}

.pw-input {
  width: 100%;
}

.push-row {
  display: flex;
  align-items: center;
  gap: 1rem;
  flex-wrap: wrap;
}

.push-label {
  flex: 1;
  min-width: 0;
}

.notif-types-header {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  margin-top: 1.25rem;
  margin-bottom: 0.5rem;
  padding-top: 1rem;
  border-top: 1px solid var(--p-content-border-color);
}

.notif-types-title {
  font-weight: 600;
  font-size: 0.9rem;
}

.notif-types-hint {
  font-size: 0.8rem;
  color: var(--p-text-muted-color);
}

.notif-types-list {
  display: flex;
  flex-direction: column;
}

.notif-type-row {
  display: flex;
  align-items: center;
  gap: 1rem;
  padding: 0.5rem 0;
  border-bottom: 1px solid var(--p-content-border-color);
}

.notif-type-row:last-child {
  border-bottom: none;
}

.notif-type-info {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
  min-width: 0;
}

.notif-type-label {
  font-size: 0.875rem;
  font-weight: 500;
}

.notif-type-desc {
  font-size: 0.78rem;
  color: var(--p-text-muted-color);
}
</style>

