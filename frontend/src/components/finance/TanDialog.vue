<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import Dialog from 'primevue/dialog'
import Button from 'primevue/button'
import InputText from 'primevue/inputtext'
import Message from 'primevue/message'
import { useBankcontactsStore } from '../../stores/finance/bankcontacts'

const store = useBankcontactsStore()
const tan = ref('')
const submitting = ref(false)
const errorMsg = ref<string | null>(null)
const tanInput = ref<{ $el?: HTMLInputElement } | null>(null)

/**
 * Focus the TAN input as soon as the dialog opens (and on each
 * follow-up challenge). PrimeVue InputText exposes the underlying
 * <input> via `.$el`. nextTick lets the dialog finish mounting
 * before we try to focus.
 */
function focusTanInput() {
  void nextTick(() => {
    tanInput.value?.$el?.focus?.()
  })
}

const visible = computed({
  get: () => store.pendingTan !== null,
  set: (v: boolean) => {
    if (!v) store.cancelTan()
  },
})

/**
 * photoTAN / Flicker-TAN: lib-fints surfaces the matrix as
 * { mimeType, image: Uint8Array }, the backend base64-encodes the
 * image and ships it as `tanPhotoMime` + `tanPhotoBase64`. Stitched
 * back together for an <img>.
 */
const photoDataUri = computed(() => {
  const p = store.pendingTan
  if (!p?.tanPhotoMime || !p?.tanPhotoBase64) return null
  return `data:${p.tanPhotoMime};base64,${p.tanPhotoBase64}`
})

watch(
  () => store.pendingTan?.tanReference,
  (ref) => {
    tan.value = ''
    errorMsg.value = null
    // Each challenge (initial + follow-up after wrong-TAN) deserves
    // a fresh focus so the user can start typing right away.
    if (ref) focusTanInput()
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
    @show="focusTanInput"
  >
    <div class="tan-dialog-body">
      <p class="challenge">
        {{ store.pendingTan?.challenge }}
      </p>

      <figure v-if="photoDataUri" class="tan-photo">
        <img
          :src="photoDataUri"
          alt="TAN-Bildmatrix"
          class="tan-photo__img"
        />
        <figcaption class="tan-photo__caption">
          Mit der TAN-App auf deinem Zweitgerät einscannen — die App
          zeigt dann den TAN-Code an.
        </figcaption>
      </figure>

      <label>
        <span>TAN (leer lassen bei decoupled / pushTAN)</span>
        <InputText
          ref="tanInput"
          v-model="tan"
          :disabled="submitting"
          autocomplete="one-time-code"
          inputmode="numeric"
          maxlength="12"
          @keyup.enter="submit"
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
.tan-photo {
  margin: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.5rem;
  padding: 0.75rem;
  background: var(--p-surface-50, var(--p-content-background));
  border-radius: 0.5rem;
}
.tan-photo__img {
  max-width: 100%;
  height: auto;
  /* photoTAN matrices are tiny — let them render at native size up
   * to ~15rem so the user can hit them with a phone scan. */
  width: 15rem;
  image-rendering: crisp-edges;
}
.tan-photo__caption {
  font-size: 0.875rem;
  color: var(--p-text-muted-color);
  text-align: center;
}
</style>
