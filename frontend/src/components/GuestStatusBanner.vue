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
  </div>
</template>

<style scoped>
/* Banners paint a translucent primary tint over whatever surface
   the page uses, so the background adapts to the active theme
   (light: pale primary on white; dark: dim primary on dark). The
   text colour follows --p-text-color and therefore flips with the
   theme too — nothing hardcoded, no fallback to a fixed surface. */
.guest-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  padding: 0.6rem 1rem;
  border-bottom: 1px solid var(--p-content-border-color);
  background: color-mix(in srgb, var(--p-primary-color) 10%, transparent);
  color: var(--p-text-color);
  flex-wrap: wrap;
  font-size: 0.9em;
}

.guest-banner--anonymous {
  background: color-mix(in srgb, var(--p-primary-color) 7%, transparent);
}

/* Amber token from Aura's absolute palette — stays a recognisable
   "please verify" colour regardless of the active light/dark mode. */
.guest-banner--pending {
  background: color-mix(in srgb, var(--p-amber-500) 14%, transparent);
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
</style>
