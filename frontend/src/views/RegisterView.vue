<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import Card from 'primevue/card'
import InputText from 'primevue/inputtext'
import Password from 'primevue/password'
import Button from 'primevue/button'
import Message from 'primevue/message'
import { useAuthStore } from '../stores/auth'

const auth = useAuthStore()
const router = useRouter()

const name = ref('')
const email = ref('')
const password = ref('')
const error = ref('')
const loading = ref(false)

async function handleRegister() {
  error.value = ''
  loading.value = true
  try {
    await auth.register(email.value, name.value, password.value)
    router.push('/users')
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
      <template #title>Registrieren</template>
      <template #content>
        <Message v-if="error" severity="error" :closable="false" class="mb">{{ error }}</Message>
        <form @submit.prevent="handleRegister" class="form">
          <div class="field">
            <label for="name">Name</label>
            <InputText id="name" v-model="name" placeholder="Name" fluid />
          </div>
          <div class="field">
            <label for="email">E-Mail</label>
            <InputText id="email" v-model="email" type="email" placeholder="E-Mail" fluid />
          </div>
          <div class="field">
            <label for="password">Passwort</label>
            <Password id="password" v-model="password" :feedback="false" toggle-mask fluid />
          </div>
          <Button type="submit" label="Registrieren" icon="pi pi-user-plus" :loading="loading" fluid />
        </form>
        <p class="link">
          Bereits registriert? <router-link to="/login">Anmelden</router-link>
        </p>
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

.mb {
  margin-bottom: 1rem;
}
</style>

