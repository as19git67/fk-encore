<script setup lang="ts">
import { ref } from 'vue'
import { useRoute } from 'vue-router'
import Card from 'primevue/card'
import InputText from 'primevue/inputtext'
import Password from 'primevue/password'
import Button from 'primevue/button'
import Message from 'primevue/message'
import { requestPasswordReset, resetPassword } from '../api/users'

const route = useRoute()
const token = ref((route.query.token as string) || '')

// Request form state
const email = ref('')
const requesting = ref(false)
const requestError = ref('')
const requestSuccess = ref('')

// Reset form state
const newPassword = ref('')
const confirmPassword = ref('')
const resetting = ref(false)
const resetError = ref('')
const resetSuccess = ref(false)

async function handleRequestReset() {
  if (!email.value.trim()) return
  requesting.value = true
  requestError.value = ''
  requestSuccess.value = ''
  try {
    const res = await requestPasswordReset(email.value.trim())
    requestSuccess.value = res.message
  } catch (err: any) {
    requestError.value = err.message || 'Fehler beim Anfordern des Zurücksetzungslinks'
  } finally {
    requesting.value = false
  }
}

async function handleResetPassword() {
  if (!newPassword.value || !confirmPassword.value) return
  if (newPassword.value !== confirmPassword.value) {
    resetError.value = 'Passwörter stimmen nicht überein'
    return
  }
  if (newPassword.value.length < 6) {
    resetError.value = 'Passwort muss mindestens 6 Zeichen lang sein'
    return
  }
  resetting.value = true
  resetError.value = ''
  try {
    await resetPassword(token.value, newPassword.value)
    resetSuccess.value = true
  } catch (err: any) {
    resetError.value = err.message || 'Fehler beim Zurücksetzen des Passworts'
  } finally {
    resetting.value = false
  }
}
</script>

<template>
  <div class="forgot-password-container">
    <!-- Reset form (when token is present) -->
    <Card v-if="token" class="forgot-password-card">
      <template #title>Neues Passwort setzen</template>
      <template #content>
        <div v-if="resetSuccess" class="success-message">
          <Message severity="success" :closable="false">
            Passwort wurde erfolgreich zurückgesetzt.
          </Message>
          <router-link to="/login">
            <Button label="Zur Anmeldung" icon="pi pi-sign-in" fluid class="mt" />
          </router-link>
        </div>
        <template v-else>
          <Message v-if="resetError" severity="error" :closable="false" class="mb">{{ resetError }}</Message>
          <form @submit.prevent="handleResetPassword" class="form">
            <div class="field">
              <label for="newPassword">Neues Passwort</label>
              <Password id="newPassword" v-model="newPassword" :feedback="true" toggle-mask fluid />
            </div>
            <div class="field">
              <label for="confirmPassword">Passwort bestätigen</label>
              <Password id="confirmPassword" v-model="confirmPassword" :feedback="false" toggle-mask fluid />
            </div>
            <Button type="submit" label="Passwort zurücksetzen" icon="pi pi-check" :loading="resetting" fluid />
          </form>
        </template>
      </template>
    </Card>

    <!-- Request form (no token) -->
    <Card v-else class="forgot-password-card">
      <template #title>Passwort vergessen</template>
      <template #content>
        <Message v-if="requestError" severity="error" :closable="false" class="mb">{{ requestError }}</Message>
        <Message v-if="requestSuccess" severity="success" :closable="false" class="mb">{{ requestSuccess }}</Message>

        <form v-if="!requestSuccess" @submit.prevent="handleRequestReset" class="form">
          <p class="hint">Gib deine E-Mail-Adresse ein. Falls ein Konto mit dieser E-Mail existiert, wird ein Zurücksetzungslink erstellt.</p>
          <div class="field">
            <label for="email">E-Mail</label>
            <InputText id="email" v-model="email" type="email" placeholder="E-Mail" fluid />
          </div>
          <Button type="submit" label="Zurücksetzungslink anfordern" icon="pi pi-envelope" :loading="requesting" fluid />
        </form>
        <p class="link">
          <router-link to="/login">Zurück zur Anmeldung</router-link>
        </p>
      </template>
    </Card>
  </div>
</template>

<style scoped>
.forgot-password-container {
  display: flex;
  justify-content: center;
  align-items: center;
  min-height: 70vh;
}

.forgot-password-card {
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

.hint {
  font-size: 0.875rem;
  color: var(--text-color-secondary);
  margin: 0 0 0.5rem;
}

.link {
  text-align: center;
  margin-top: 1rem;
}

.mb {
  margin-bottom: 1rem;
}

.mt {
  margin-top: 1rem;
}

.success-message {
  display: flex;
  flex-direction: column;
}
</style>
