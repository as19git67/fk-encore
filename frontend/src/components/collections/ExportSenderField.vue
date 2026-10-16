<script setup lang="ts">
/**
 * Who an export mail is from (#1548): the app's address, or — as the
 * alternative, when the user's own address shares the app's domain — the
 * user's. Any other address would fail SPF/DMARC, so the switch is not
 * offered then and the app sends, with answers going to the user.
 */
import { computed } from 'vue'
import ToggleSwitch from 'primevue/toggleswitch'

const props = defineProps<{
  /** The user's address. */
  senderEmail: string | null
  /** The app's address. */
  systemSender: string
  /** The user's address shares the app's domain. */
  allowed: boolean
  /** For the label's `for`. */
  inputId: string
}>()
const fromSelf = defineModel<boolean>({ default: false })

const sender = computed(() => (props.allowed && fromSelf.value ? props.senderEmail : props.systemSender))
</script>

<template>
  <div class="sender">
    <p class="sender-from">Von: <strong>{{ sender }}</strong></p>
    <label v-if="allowed && senderEmail" class="sender-switch" :for="inputId">
      <ToggleSwitch v-model="fromSelf" :input-id="inputId" />
      <span>Von meiner Adresse senden</span>
    </label>
    <p v-if="!(allowed && fromSelf) && senderEmail" class="sender-hint">Antworten gehen an {{ senderEmail }}.</p>
  </div>
</template>

<style scoped>
.sender {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}
.sender-from {
  margin: 0;
  font-size: var(--text-sm);
  overflow-wrap: anywhere;
}
.sender-switch {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--text-sm);
}
.sender-hint {
  margin: 0;
  font-size: var(--text-sm);
  color: var(--p-text-muted-color);
  overflow-wrap: anywhere;
}
</style>
