<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import Card from 'primevue/card'
import InputText from 'primevue/inputtext'
import Password from 'primevue/password'
import Button from 'primevue/button'
import Message from 'primevue/message'
import { useAuthStore } from '../stores/auth'
import { checkInvite } from '../api/users'

const auth = useAuthStore()
const router = useRouter()
const route = useRoute()

// Registration is by invitation only. The token arrives in the link from
// the invite mail; the address it was issued for comes from the server, so
// this page never asks for one — it only shows which account is being set
// up, and the server would ignore anything typed here anyway.
const inviteToken = ref((route.query.token as string) ?? '')
const invitedEmail = ref('')
const checking = ref(true)
const inviteError = ref('')

const name = ref('')
const password = ref('')
const error = ref('')
const loading = ref(false)

onMounted(async () => {
  if (!inviteToken.value) {
    inviteError.value =
      'Zum Anlegen eines Kontos wird eine Einladung benötigt. Bitte wende dich an die Person, die die Benutzer verwaltet.'
    checking.value = false
    return
  }
  try {
    const { email } = await checkInvite(inviteToken.value)
    invitedEmail.value = email
  } catch {
    inviteError.value =
      'Diese Einladung ist ungültig, wurde bereits verwendet oder ist abgelaufen. Bitte lass dir eine neue schicken.'
  } finally {
    checking.value = false
  }
})

async function handleRegister() {
  error.value = ''
  loading.value = true
  try {
    await auth.register(inviteToken.value, name.value, password.value)
    router.push('/fotos')
  } catch (err: any) {
    error.value = err.message || 'Registrierung fehlgeschlagen'
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div class="register-container">
    <Card class="register-card">
      <template #title>Konto anlegen</template>
      <template #content>
        <p v-if="checking" class="info-text">
          <i class="pi pi-spin pi-spinner" /> Einladung wird geprüft…
        </p>

        <template v-else-if="inviteError">
          <Message severity="warn" :closable="false" class="mb">{{ inviteError }}</Message>
          <p class="link">
            <router-link to="/login">Zur Anmeldung</router-link>
          </p>
        </template>

        <template v-else>
          <Message v-if="error" severity="error" :closable="false" class="mb">{{ error }}</Message>
          <form @submit.prevent="handleRegister" class="form">
            <div class="field">
              <label for="email">E-Mail</label>
              <InputText id="email" :model-value="invitedEmail" disabled fluid />
              <small class="hint">Die Adresse, an die die Einladung ging.</small>
            </div>
            <div class="field">
              <label for="name">Name</label>
              <InputText id="name" v-model="name" placeholder="Name" fluid />
            </div>
            <div class="field">
              <label for="password">Passwort</label>
              <Password id="password" v-model="password" :feedback="false" toggle-mask fluid />
              <small class="hint">Mindestens 8 Zeichen.</small>
            </div>
            <Button type="submit" label="Konto anlegen" icon="pi pi-user-plus" :loading="loading" fluid />
          </form>
          <p class="link">
            Bereits registriert? <router-link to="/login">Anmelden</router-link>
          </p>
        </template>
      </template>
    </Card>
  </div>
</template>

<style scoped>
.register-container {
  display: flex;
  justify-content: center;
  align-items: center;
  min-height: 70vh;
}

.register-card {
  width: 100%;
  max-width: 400px;
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

.link {
  text-align: center;
  margin-top: 1rem;
}

.hint {
  color: var(--p-text-muted-color);
  font-size: 0.8rem;
}

.info-text {
  text-align: center;
  color: var(--p-text-muted-color);
}

.mb {
  margin-bottom: 1rem;
}
</style>

