<script setup lang="ts">
import { ref, onMounted } from 'vue'
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
import {
  startRegistration,
  browserSupportsWebAuthn,
} from '@simplewebauthn/browser'

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
  return new Date(dateStr).toLocaleString('de-DE')
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

onMounted(loadPasskeys)
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
          table-style="min-width: 30rem"
        >
          <template #empty>Keine Passkeys registriert.</template>
          <Column field="name" header="Name" />
          <Column field="device_type" header="Gerätetyp">
            <template #body="{ data }">
              {{ data.device_type === 'multiDevice' ? 'Multi-Gerät' : 'Einzel-Gerät' }}
            </template>
          </Column>
          <Column header="Backup">
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
  color: var(--text-color-secondary);
}

.description {
  color: var(--text-color-secondary);
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
  color: var(--text-color-secondary);
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
</style>

