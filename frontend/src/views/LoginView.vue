<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import Card from 'primevue/card'
import InputText from 'primevue/inputtext'
import Password from 'primevue/password'
import Button from 'primevue/button'
import Divider from 'primevue/divider'
import Message from 'primevue/message'
import { useAuthStore } from '../stores/auth'
import { browserSupportsWebAuthn } from '@simplewebauthn/browser'

const auth = useAuthStore()
const router = useRouter()

const email = ref('')
const password = ref('')
const error = ref('')
const loading = ref(false)
const passkeyLoading = ref(false)
const supportsPasskey = browserSupportsWebAuthn()

async function handleLogin() {
  error.value = ''
  loading.value = true
  try {
    await auth.login(email.value, password.value)
    router.push('/users')
  } catch (err: any) {
    error.value = err.message || 'Anmeldung fehlgeschlagen'
  } finally {
    loading.value = false
  }
}

async function handlePasskeyLogin() {
  error.value = ''
  passkeyLoading.value = true
  try {
    await auth.loginWithPasskey()
    router.push('/users')
  } catch (err: any) {
    if (err.name === 'NotAllowedError') {
      error.value = 'Passkey-Anmeldung abgebrochen'
    } else {
      error.value = err.message || 'Passkey-Anmeldung fehlgeschlagen'
    }
  } finally {
    passkeyLoading.value = false
  }
}
</script>

<template>
  <div class="login-container">
    <Card class="login-card">
      <template #title>Anmelden</template>
      <template #content>
        <Message v-if="error" severity="error" :closable="false" class="mb">{{ error }}</Message>

        <div v-if="supportsPasskey" class="passkey-section">
          <Button
            label="Mit Passkey anmelden"
            icon="pi pi-key"
            :loading="passkeyLoading"
            fluid
            @click="handlePasskeyLogin"
          />
          <Divider align="center">oder</Divider>
        </div>

        <form @submit.prevent="handleLogin" class="form">
          <div class="field">
            <label for="email">E-Mail</label>
            <InputText id="email" v-model="email" type="email" placeholder="E-Mail" fluid />
          </div>
          <div class="field">
            <label for="password">Passwort</label>
            <Password id="password" v-model="password" :feedback="false" toggle-mask fluid />
          </div>
          <Button type="submit" label="Anmelden" icon="pi pi-sign-in" :loading="loading" fluid />
        </form>
        <p class="link">
          Noch kein Konto? <router-link to="/register">Registrieren</router-link>
        </p>
      </template>
    </Card>
  </div>
</template>

<style scoped>
.login-container {
  display: flex;
  justify-content: center;
  align-items: center;
  min-height: 70vh;
}

.login-card {
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

.mb {
  margin-bottom: 1rem;
}

.passkey-section {
  margin-bottom: 0;
}
</style>
