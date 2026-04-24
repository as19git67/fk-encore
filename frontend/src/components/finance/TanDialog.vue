<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import Dialog from 'primevue/dialog'
import Button from 'primevue/button'
import InputText from 'primevue/inputtext'
import Message from 'primevue/message'
import { useBankcontactsStore } from '../../stores/finance/bankcontacts'

const store = useBankcontactsStore()
const tan = ref('')
const submitting = ref(false)
const errorMsg = ref<string | null>(null)

const visible = computed({
  get: () => store.pendingTan !== null,
  set: (v: boolean) => {
    if (!v) store.cancelTan()
  },
})

watch(
  () => store.pendingTan?.tanReference,
  () => {
    tan.value = ''
    errorMsg.value = null
  },
)

async function submit() {
  if (!store.pendingTan) return
  submitting.value = true
  errorMsg.value = null
  try {
    const resp = await store.submitTan(tan.value || undefined)
    if (resp.state === 'error') {
      errorMsg.value = `${resp.errorCode}: ${resp.errorMessage}`
    }
  } catch (err) {
    errorMsg.value = err instanceof Error ? err.message : String(err)
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <Dialog
    v-model:visible="visible"
    :closable="false"
    :modal="true"
    :style="{ width: '30rem' }"
    :header="`TAN erforderlich${store.pendingTan?.tanMediaName ? ' — ' + store.pendingTan.tanMediaName : ''}`"
  >
    <div class="tan-dialog-body">
      <p class="challenge">
        {{ store.pendingTan?.challenge }}
      </p>

      <label>
        <span>TAN (leer lassen bei decoupled / pushTAN)</span>
        <InputText
          v-model="tan"
          :disabled="submitting"
          autocomplete="one-time-code"
          inputmode="numeric"
          maxlength="12"
        />
      </label>

      <Message v-if="errorMsg" severity="error" :closable="false">
        {{ errorMsg }}
      </Message>
    </div>

    <template #footer>
      <Button
        label="Abbrechen"
        severity="secondary"
        :disabled="submitting"
        @click="store.cancelTan()"
      />
      <Button
        label="Bestätigen"
        :loading="submitting"
        @click="submit"
      />
    </template>
  </Dialog>
</template>

<style scoped>
.tan-dialog-body {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}
.tan-dialog-body .challenge {
  white-space: pre-wrap;
  margin: 0;
}
.tan-dialog-body label {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}
</style>
