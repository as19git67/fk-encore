<script setup lang="ts">
/**
 * Header banner that surfaces the guest's relationship to the album:
 *
 *   - Anonymous: "Anmelden" CTA opens the registration dialog.
 *   - Verify pending: explains that an e-mail was sent, offers a
 *     re-send button.
 *   - Verified: shows the guest's name with toggles for mail digest
 *     opt-in and Web Push, plus a logout link.
 *
 * Push state comes in via props instead of being owned here so the
 * parent (SharedAlbumView) keeps a single push composable instance —
 * the banner can otherwise unmount/remount and lose subscription
 * state during layout transitions.
 */

import { computed } from 'vue'
import Button from 'primevue/button'
import ToggleSwitch from 'primevue/toggleswitch'
import type { GuestSelf } from '../api/sharedalbum'
import type { PushStatus } from '../composables/usePushNotifications'

const props = defineProps<{
  guest: GuestSelf | null
  loading: boolean
  togglingNotify: boolean
  pushStatus: PushStatus
  pushBusy: boolean
  pushCanToggle: boolean
}>()

const emit = defineEmits<{
  (e: 'register'): void
  (e: 'resend-verify'): void
  (e: 'logout'): void
  (e: 'toggle-notify', value: boolean): void
  (e: 'toggle-push', value: boolean): void
  (e: 'dismiss'): void
}>()

const state = computed<'loading' | 'anonymous' | 'pending' | 'verified'>(() => {
  if (props.loading && !props.guest) return 'loading'
  if (!props.guest) return 'anonymous'
  if (!props.guest.verified) return 'pending'
  return 'verified'
})

const pushChecked = computed(() => props.pushStatus === 'subscribed')

const pushTooltip = computed<string | null>(() => {
  switch (props.pushStatus) {
    case 'unsupported':
      return 'Push wird von diesem Browser nicht unterstützt'
    case 'disabled-server':
      return 'Push ist auf dem Server nicht konfiguriert'
    case 'denied':
      return 'Im Browser blockiert — Berechtigung in den Browser-Einstellungen aktivieren'
    default:
      return null
  }
})
</script>

<template>
  <div :class="['guest-banner', `guest-banner--${state}`]">
    <template v-if="state === 'loading'" />

    <template v-else-if="state === 'anonymous'">
      <div class="guest-banner__text">
        <i class="pi pi-comment" />
        <span>Möchtest du kommentieren oder bei Neuigkeiten benachrichtigt werden?</span>
      </div>
      <Button
        label="Anmelden"
        size="small"
        @click="emit('register')"
      />
    </template>

    <template v-else-if="state === 'pending'">
      <div class="guest-banner__text">
        <i class="pi pi-envelope" />
        <span>
          Bitte E-Mail bestätigen
          <em v-if="guest">({{ guest.email }})</em>
          — Link wurde versandt.
        </span>
      </div>
      <Button
        label="Erneut senden"
        size="small"
        severity="secondary"
        outlined
        @click="emit('resend-verify')"
      />
    </template>

    <template v-else-if="state === 'verified' && guest">
      <div class="guest-banner__text">
        <i class="pi pi-user" />
        <span>Du bist als <strong>{{ guest.display_name }}</strong> angemeldet.</span>
      </div>
      <div class="guest-banner__controls">
        <label class="guest-banner__toggle" title="Mail-Benachrichtigungen">
          <i class="pi pi-envelope" />
          <ToggleSwitch
            :modelValue="guest.notify_opt_in"
            :disabled="togglingNotify"
            @update:modelValue="emit('toggle-notify', $event)"
          />
        </label>
        <label
          class="guest-banner__toggle"
          :title="pushTooltip ?? 'Push-Benachrichtigungen'"
        >
          <i class="pi pi-bell" />
          <ToggleSwitch
            :modelValue="pushChecked"
            :disabled="pushBusy || !pushCanToggle"
            @update:modelValue="emit('toggle-push', $event)"
          />
        </label>
        <Button
          label="Abmelden"
          size="small"
          text
          severity="secondary"
          @click="emit('logout')"
        />
      </div>
    </template>

    <!-- Dismiss control: hides the banner for the rest of the session
         (and beyond, when the parent persists the choice). The compact
         Anmelden/Account button in the album header remains reachable
         regardless. -->
    <button
      v-if="state !== 'loading'"
      type="button"
      class="guest-banner__dismiss"
      aria-label="Hinweis schließen"
      title="Hinweis schließen"
      @click="emit('dismiss')"
    >
      <i class="pi pi-times" aria-hidden="true" />
    </button>
  </div>
</template>

<style scoped>
/* The three banner states map onto PrimeVue Aura's dedicated
   Message severity tokens. Each one bundles a mode-adaptive
   background + text + border colour tuned for alert-style UI, so the
   banner stays legible whether the viewer sits on a light or a dark
   surface without any manual colour-mix or hardcoded values. */
.guest-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  padding: 0.6rem 1rem;
  flex-wrap: wrap;
  font-size: 0.9em;
  border-bottom: 1px solid var(--p-message-secondary-border-color);
  background: var(--p-message-secondary-background);
  color: var(--p-message-secondary-color);
}

.guest-banner--anonymous {
  border-bottom-color: var(--p-message-info-border-color);
  background: var(--p-message-info-background);
  color: var(--p-message-info-color);
}

.guest-banner--pending {
  border-bottom-color: var(--p-message-warn-border-color);
  background: var(--p-message-warn-background);
  color: var(--p-message-warn-color);
}

.guest-banner__text {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  flex: 1 1 auto;
  min-width: 0;
}

.guest-banner__text em {
  font-style: normal;
  opacity: 0.75;
}

.guest-banner__controls {
  display: inline-flex;
  align-items: center;
  gap: 0.6rem;
}

.guest-banner__toggle {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  opacity: 0.85;
  cursor: pointer;
}

.guest-banner__dismiss {
  align-self: center;
  margin-left: 0.25rem;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1.75rem;
  height: 1.75rem;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: transparent;
  color: inherit;
  opacity: 0.6;
  cursor: pointer;
  font-size: 0.85rem;
}

.guest-banner__dismiss:hover,
.guest-banner__dismiss:focus-visible {
  opacity: 1;
  background: color-mix(in srgb, currentColor 12%, transparent);
  outline: none;
}
</style>
