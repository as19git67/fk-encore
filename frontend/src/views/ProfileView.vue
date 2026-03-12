<script setup lang="ts">
import { ref, onMounted } from 'vue'
import Card from 'primevue/card'
import Button from 'primevue/button'
import DataTable from 'primevue/datatable'
import Column from 'primevue/column'
import InputText from 'primevue/inputtext'
import Message from 'primevue/message'
import { useAuthStore } from '../stores/auth'
import {
  listPasskeys,
  passkeyRegisterOptions,
  passkeyRegisterVerify,
  deletePasskey,
  type PasskeyInfo,
} from '../api/passkeys'
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
</style>

