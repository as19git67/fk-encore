/**
 * Reactive guest session for a single public-link token.
 *
 * The HttpOnly fk_guest_session cookie is the source of truth — this
 * composable just caches the resolved guest object so the UI doesn't
 * need to re-fetch on every interaction. `register` triggers a magic
 * link and creates an unverified session immediately so the share
 * page can switch to the "pending verify" UI state without waiting
 * for the user to click the link.
 */

import { ref, computed } from 'vue'
import {
  getGuestSelf,
  registerGuest,
  logoutGuest,
  setGuestNotifyOptIn,
  type GuestSelf,
} from '../api/sharedalbum'

export function useGuestSession(token: string) {
  const guest = ref<GuestSelf | null>(null)
  const loading = ref(false)
  const error = ref<string | null>(null)
  const submittingRegister = ref(false)
  const togglingNotify = ref(false)

  const isRegistered = computed(() => guest.value !== null)
  const isVerified = computed(() => guest.value?.verified === true)
  const canComment = computed(() => isVerified.value)

  async function refresh(): Promise<void> {
    loading.value = true
    error.value = null
    try {
      const r = await getGuestSelf(token)
      guest.value = r.guest
    } catch (err: unknown) {
      error.value = (err as Error)?.message ?? 'Status nicht ladbar'
    } finally {
      loading.value = false
    }
  }

  /**
   * Submits a registration. Returns true when a magic-link mail was
   * sent (verify_required is always true in the current backend; kept
   * as a return value so the caller can show "check your inbox").
   */
  async function register(email: string, displayName: string): Promise<boolean> {
    if (submittingRegister.value) return false
    submittingRegister.value = true
    error.value = null
    try {
      const r = await registerGuest(token, email, displayName)
      // Optimistic local state — backend has dropped a cookie so the
      // next /me will agree, but we don't need to wait for the round
      // trip: we know name + email + that verification is pending.
      guest.value = {
        id: r.guest_id,
        email,
        display_name: displayName,
        verified: false,
        notify_opt_in: true,
      }
      return r.verify_required
    } catch (err: unknown) {
      error.value = (err as Error)?.message ?? 'Anmeldung fehlgeschlagen'
      throw err
    } finally {
      submittingRegister.value = false
    }
  }

  /**
   * Re-trigger the magic-link mail (uses register again — backend
   * re-issues the verify_token on every register call).
   */
  async function resendVerifyMail(): Promise<void> {
    if (!guest.value) return
    await register(guest.value.email, guest.value.display_name)
  }

  async function logout(): Promise<void> {
    error.value = null
    try {
      await logoutGuest(token)
      guest.value = null
    } catch (err: unknown) {
      error.value = (err as Error)?.message ?? 'Abmeldung fehlgeschlagen'
    }
  }

  async function toggleNotifyOptIn(optIn: boolean): Promise<void> {
    if (!guest.value || togglingNotify.value) return
    togglingNotify.value = true
    error.value = null
    const previous = guest.value.notify_opt_in
    guest.value = { ...guest.value, notify_opt_in: optIn }
    try {
      await setGuestNotifyOptIn(token, optIn)
    } catch (err: unknown) {
      // Roll back on failure so the toggle reflects the server.
      if (guest.value) guest.value = { ...guest.value, notify_opt_in: previous }
      error.value = (err as Error)?.message ?? 'Speichern fehlgeschlagen'
    } finally {
      togglingNotify.value = false
    }
  }

  return {
    guest,
    loading,
    error,
    submittingRegister,
    togglingNotify,
    isRegistered,
    isVerified,
    canComment,
    refresh,
    register,
    resendVerifyMail,
    logout,
    toggleNotifyOptIn,
  }
}
