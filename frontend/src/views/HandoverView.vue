<script setup lang="ts">
/**
 * Where the iOS app's in-app browser lands (assistent-ios.md, stage 5): the
 * one-time token in the URL fragment is redeemed for a session, and the page
 * goes on to the row the user tapped. The fragment is read once and dropped
 * from the history entry, so Back never returns to a spent token.
 */
import { onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import Card from 'primevue/card'
import Button from 'primevue/button'
import Message from 'primevue/message'
import ProgressSpinner from 'primevue/progressspinner'
import PageLayout from '../components/layout/PageLayout.vue'
import { useAuthStore } from '../stores/auth'
import { parseHandoverHash } from '../utils/handover'

const auth = useAuthStore()
const router = useRouter()
const route = useRoute()

const error = ref('')
const redirect = ref<string | null>(null)

onMounted(async () => {
  const params = parseHandoverHash(route.hash)
  redirect.value = params.redirect
  if (!params.token) {
    error.value = 'Der Link enthält keinen gültigen Übergabe-Code.'
    return
  }
  try {
    await auth.loginWithHandover(params.token)
    await router.replace(params.redirect ?? '/')
  } catch (err: any) {
    error.value = err.message || 'Die Anmeldung aus der App ist fehlgeschlagen.'
  }
})

function toLogin() {
  void router.replace({ name: 'login', query: redirect.value ? { redirect: redirect.value } : {} })
}
</script>

<template>
  <PageLayout title="Anmelden" width="normal">
    <div class="handover-container">
      <Card class="handover-card">
        <template #content>
          <template v-if="error">
            <Message severity="error" :closable="false" class="mb">{{ error }}</Message>
            <p class="hint">Der Code aus der App gilt eine Minute und nur einmal. Melde dich stattdessen hier an.</p>
            <Button label="Zur Anmeldung" icon="pi pi-sign-in" fluid @click="toLogin" />
          </template>
          <div v-else class="waiting" role="status" aria-live="polite">
            <ProgressSpinner class="spinner" stroke-width="4" aria-hidden="true" />
            <span>Anmeldung aus der App …</span>
          </div>
        </template>
      </Card>
    </div>
  </PageLayout>
</template>

<style scoped>
.handover-container {
  display: flex;
  justify-content: center;
  align-items: center;
  min-height: 70vh;
}

.handover-card {
  width: 100%;
  max-width: 400px;
}

.waiting {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-3);
  color: var(--p-text-muted-color);
}

.spinner {
  width: 2.5rem;
  height: 2.5rem;
}

.hint {
  margin: 0 0 var(--space-3);
  color: var(--p-text-muted-color);
  font-size: var(--text-sm);
}

.mb {
  margin-bottom: var(--space-3);
}
</style>
