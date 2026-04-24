<script setup lang="ts">
/**
 * Options dialog for a registered guest on the public share page.
 *
 * The map-mode banner has no room for the mail / push toggles, so in
 * that layout the SharedAlbumView swaps it for a compact button in
 * the stats overlay that opens this dialog on demand. Contents
 * mirror the verified-state block inside GuestStatusBanner:
 *
 *   - unverified: gentle "please check your inbox" + resend action
 *   - verified:   mail-digest toggle, Web Push toggle, logout
 */

import { computed } from 'vue'
import Dialog from 'primevue/dialog'
import Button from 'primevue/button'
import ToggleSwitch from 'primevue/toggleswitch'
import type { GuestSelf } from '../api/sharedalbum'
import type { PushStatus } from '../composables/usePushNotifications'

const props = defineProps<{
  visible: boolean
  guest: GuestSelf | null
  togglingNotify: boolean
  pushStatus: PushStatus
  pushBusy: boolean
  pushCanToggle: boolean
}>()

const emit = defineEmits<{
  (e: 'update:visible', v: boolean): void
  (e: 'resend-verify'): void
  (e: 'logout'): void
  (e: 'toggle-notify', value: boolean): void
  (e: 'toggle-push', value: boolean): void
}>()

const header = computed(() => {
  if (!props.guest) return 'Konto'
  return `Hallo ${props.guest.display_name}`
})

const pushChecked = computed(() => props.pushStatus === 'subscribed')

const pushStatusHint = computed<string | null>(() => {
  switch (props.pushStatus) {
    case 'unsupported':
      return 'Push wird von diesem Browser nicht unterstützt.'
    case 'disabled-server':
      return 'Push ist auf dem Server nicht konfiguriert.'
    case 'denied':
      return 'Im Browser blockiert — Berechtigung in den Browser-Einstellungen aktivieren.'
    default:
      return null
  }
})

function close() {
  emit('update:visible', false)
}

function onResend() {
  emit('resend-verify')
  close()
}

function onLogout() {
  emit('logout')
  close()
}
</script>

<template>
  <Dialog
    :visible="visible"
    modal
    :header="header"
    :style="{ width: 'min(420px, 92vw)' }"
    @update:visible="emit('update:visible', $event)"
  >
    <div v-if="!guest" class="guest-account__empty">
      Keine Session gefunden.
    </div>

    <div v-else-if="!guest.verified" class="guest-account__pending">
      <p>
        Bitte bestätige deine E-Mail-Adresse
        <em>({{ guest.email }})</em> — wir haben dir einen Link
        geschickt. Danach kannst du kommentieren und Benachrichtigungen
        empfangen.
      </p>
    </div>

    <ul v-else class="guest-account__list">
      <li class="guest-account__row">
        <div class="guest-account__label">
          <i class="pi pi-envelope" />
          <span>Mail-Benachrichtigungen</span>
        </div>
        <ToggleSwitch
          :modelValue="guest.notify_opt_in"
          :disabled="togglingNotify"
          @update:modelValue="emit('toggle-notify', $event)"
        />
      </li>
      <li class="guest-account__row">
        <div class="guest-account__label">
          <i class="pi pi-bell" />
          <span>
            Push-Benachrichtigungen
            <small v-if="pushStatusHint" class="guest-account__hint">
              {{ pushStatusHint }}
            </small>
          </span>
        </div>
        <ToggleSwitch
          :modelValue="pushChecked"
          :disabled="pushBusy || !pushCanToggle"
          @update:modelValue="emit('toggle-push', $event)"
        />
      </li>
    </ul>

    <template #footer>
      <Button
        v-if="guest && !guest.verified"
        label="Link erneut senden"
        icon="pi pi-send"
        severity="secondary"
        outlined
        @click="onResend"
      />
      <Button
        v-if="guest"
        label="Abmelden"
        icon="pi pi-sign-out"
        severity="secondary"
        text
        @click="onLogout"
      />
      <Button label="Schließen" @click="close" />
    </template>
  </Dialog>
</template>

<style scoped>
.guest-account__empty,
.guest-account__pending p {
  margin: 0;
  font-size: 0.95em;
  color: var(--p-text-color);
}

.guest-account__pending em {
  font-style: normal;
  opacity: 0.75;
}

.guest-account__list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.85rem;
}

.guest-account__row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
}

.guest-account__label {
  display: inline-flex;
  align-items: flex-start;
  gap: 0.6rem;
  color: var(--p-text-color);
}

.guest-account__label i {
  margin-top: 0.15em;
  opacity: 0.75;
}

.guest-account__hint {
  display: block;
  margin-top: 0.15rem;
  font-size: 0.8em;
  opacity: 0.7;
  max-width: 16rem;
}
</style>
