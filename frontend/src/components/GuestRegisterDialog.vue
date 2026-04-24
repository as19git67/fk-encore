<script setup lang="ts">
/**
 * Modal that collects name + email from a public-link visitor and
 * triggers the magic-link mail flow. The dialog stays open after a
 * successful submit so the user sees the "check your inbox" copy
 * without an additional toast.
 */

import { computed, nextTick, ref, watch } from 'vue'
import Dialog from 'primevue/dialog'
import Button from 'primevue/button'
import InputText from 'primevue/inputtext'
import Message from 'primevue/message'

const props = defineProps<{
  visible: boolean
  submitting: boolean
  errorMessage?: string | null
  /** Pre-fill from a previously-registered guest (re-send flow). */
  initialEmail?: string
  initialName?: string
}>()

const emit = defineEmits<{
  (e: 'update:visible', v: boolean): void
  (e: 'submit', payload: { email: string; displayName: string }): void
}>()

const name = ref(props.initialName ?? '')
const email = ref(props.initialEmail ?? '')
const submitted = ref(false)
const nameInput = ref<InstanceType<typeof InputText> | null>(null)

const isValid = computed(() => {
  const n = name.value.trim()
  const e = email.value.trim()
  return n.length > 0 && n.length <= 80 && /.+@.+\..+/.test(e)
})

function focusName() {
  // Grab the underlying <input> — PrimeVue's InputText wraps it and
  // exposes the wrapping element via $el, so we drill through once.
  const el = nameInput.value as unknown as { $el?: HTMLInputElement } | HTMLInputElement | null
  const input = (el as { $el?: HTMLInputElement })?.$el ?? (el as HTMLInputElement | null)
  input?.focus()
  input?.select?.()
}

function handleClose() {
  emit('update:visible', false)
  // Reset only after the dialog actually closes so the form doesn't
  // wipe under the user's eyes.
  setTimeout(() => {
    submitted.value = false
  }, 300)
}

function handleSubmit() {
  if (!isValid.value || props.submitting) return
  submitted.value = true
  emit('submit', { email: email.value.trim(), displayName: name.value.trim() })
}

// Reset submitted flag if the parent surfaces a new error (so the
// inbox confirmation isn't shown alongside a failure message).
watch(
  () => props.errorMessage,
  (msg) => {
    if (msg) submitted.value = false
  },
)

watch(
  () => props.visible,
  (v) => {
    if (v) {
      name.value = props.initialName ?? ''
      email.value = props.initialEmail ?? ''
      submitted.value = false
      // Initial focus on the name field. Wait for the dialog content
      // to mount — Dialog uses a teleport + transition so the ref
      // isn't bound yet on the same tick.
      void nextTick(() => focusName())
    }
  },
)
</script>

<template>
  <Dialog
    :visible="visible"
    modal
    header="Anmelden"
    :style="{ width: 'min(420px, 92vw)' }"
    :closable="!submitting"
    @update:visible="emit('update:visible', $event)"
  >
    <p v-if="!submitted" class="guest-dialog__intro">
      Hinterlasse Name und E-Mail-Adresse, um Fotos zu kommentieren und über
      Neuigkeiten in diesem Album benachrichtigt zu werden.
    </p>

    <div v-if="submitted && !errorMessage" class="guest-dialog__success">
      <i class="pi pi-envelope" />
      <div>
        <strong>E-Mail unterwegs.</strong>
        <p>Wir haben einen Bestätigungslink an <em>{{ email }}</em> geschickt. Klicke darauf, um Kommentare zu schreiben.</p>
      </div>
    </div>

    <form v-else class="guest-dialog__form" @submit.prevent="handleSubmit">
      <label class="guest-dialog__field">
        <span>Name</span>
        <InputText
          ref="nameInput"
          v-model="name"
          autocomplete="name"
          maxlength="80"
          required
          :disabled="submitting"
          fluid
        />
      </label>
      <label class="guest-dialog__field">
        <span>E-Mail</span>
        <InputText
          v-model="email"
          type="email"
          autocomplete="email"
          required
          :disabled="submitting"
          fluid
        />
      </label>
      <Message v-if="errorMessage" severity="error" :closable="false">
        {{ errorMessage }}
      </Message>
    </form>

    <template #footer>
      <Button
        v-if="submitted && !errorMessage"
        label="Schließen"
        @click="handleClose"
      />
      <template v-else>
        <Button
          label="Abbrechen"
          severity="secondary"
          outlined
          :disabled="submitting"
          @click="handleClose"
        />
        <Button
          label="Bestätigungslink senden"
          icon="pi pi-send"
          :loading="submitting"
          :disabled="!isValid || submitting"
          @click="handleSubmit"
        />
      </template>
    </template>
  </Dialog>
</template>

<style scoped>
.guest-dialog__intro {
  margin: 0 0 1em;
  color: var(--p-text-muted-color);
  font-size: 0.9em;
}

.guest-dialog__form {
  display: flex;
  flex-direction: column;
  gap: 0.85rem;
}

.guest-dialog__field {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
}
.guest-dialog__field span {
  font-size: 0.85em;
  font-weight: 600;
  color: var(--p-text-muted-color);
}

.guest-dialog__success {
  display: flex;
  gap: 0.75rem;
  align-items: flex-start;
  padding: 0.75rem;
  background: color-mix(in srgb, var(--p-primary-color) 12%, transparent);
  border-radius: 8px;
  font-size: 0.9em;
}
.guest-dialog__success i {
  font-size: 1.25rem;
  color: var(--p-primary-color);
  margin-top: 0.1em;
}
.guest-dialog__success p {
  margin: 0.25em 0 0;
  color: var(--p-text-color);
}
</style>
